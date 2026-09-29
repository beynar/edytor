/**
 * Re-score 2 (2026-09-30) — the room's Durable Object lows, in workerd:
 *
 * - RW-08: a read fault while the room (re)starts is the storage's, not
 *   the container's: a second one after a rebuild, or one at cold start,
 *   keeps sockets retryable (1011), and a healthy dial restores the room.
 * - RW-09: a persistent append fault closes the sender 1011 at every
 *   attempt; the shipped provider backs off between those faults instead
 *   of redialing every 100 ms.
 * - RW-10: after a restore from a lagging snapshot, the provider of the
 *   client relaying another user's stripped edits still reports `saved`
 *   once the room stored its own.
 *
 * Expected values are hand-authored from the edits each test performs.
 */
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import type { HookedRoom } from './worker';
import {
	E,
	ORIGIN,
	RawClient,
	SelfWebSocket,
	Y,
	crdt,
	dialOutcome,
	para,
	readFacade,
	shape
} from './client';

const hooked = (room: string) => env.HOOKED.getByName(room);
const inHooked = <T>(room: string, fn: (r: HookedRoom, state: DurableObjectState) => T) =>
	runInDurableObject(hooked(room), (r: HookedRoom, state) => fn(r, state));
const inRoom = <T>(room: string, fn: (r: Room, state: DurableObjectState) => T) =>
	runInDurableObject(env.ROOM.getByName(room), (r: Room, state) => fn(r, state));

const clockOf = (doc: E.YDoc) => Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID);
const textOf = (client: RawClient) => shape(client.json()).children[0]?.text;

/** The text of block `id` in what the room STORED (its rows, merged). */
const storedText = (r: Room, id: string) => {
	const stored = crdt.createDoc();
	Y.applyUpdate(
		stored,
		Y.mergeUpdates(
			r
				.records()
				.slice(1)
				.map((x) => x.bytes)
		)
	);
	return readFacade(stored, (f) => f.blockText(id));
};

/** The room's next `failures` reads of its rows throw (a transient I/O error). */
const failReads = (r: Room, failures: number) => {
	const room = r.room as unknown as { records: () => unknown };
	const records = room.records.bind(room);
	room.records = () => {
		if (failures-- > 0) throw new Error('injected read failure');
		return records();
	};
};

const FAIL_APPEND =
	"CREATE TRIGGER fail_append BEFORE INSERT ON rows WHEN NEW.kind = 'update' BEGIN SELECT RAISE(ABORT, 'injected append failure'); END";

const unavailable = { code: 1011, reason: 'room unavailable' };

/** The shipped provider over `SELF`, counting its dials. */
const dialingProvider = (room: string, document: E.YDoc, params: Record<string, string>) => {
	const dials = { count: 0 };
	class CountingWebSocket extends SelfWebSocket {
		constructor(url: string) {
			super(url);
			dials.count++;
		}
	}
	const provider = new crdt.providers.WebsocketProvider(
		`${ORIGIN.replace('https', 'wss')}/rooms`,
		room,
		document,
		{
			params,
			WebSocketPolyfill: CountingWebSocket as unknown as typeof WebSocket,
			disableBc: true
		}
	);
	return { provider, dials };
};

describe('RW-08 · a read fault while the room starts stays retryable (1011)', () => {
	it('a second read fault after a rebuild: 1011, then a healthy dial restores the room', async () => {
		const room = 'rw08-second-fault';
		const document = E.createDocument({ value: { children: [para('p', 'hello')] } });
		const author = await RawClient.connect(room, document.doc, { user: 'ada' });
		await vi.waitFor(() => expect(author.acks.length).toBeGreaterThan(0));
		await inRoom(room, (r, state) => {
			state.storage.sql.exec(FAIL_APPEND);
			// The rebuild's read fails, and so does the retry at the next dial.
			failReads(r, 2);
		});
		document.transact(() => document.facade.insertText('p', 5, '!'));
		await vi.waitFor(() =>
			expect(author.closed).toEqual({ code: 1011, reason: 'storage failure' })
		);
		await inRoom(room, (_r, state) => state.storage.sql.exec('DROP TRIGGER fail_append'));

		// The dial retries the load; it fails again: still retryable.
		const second = await RawClient.connect(room, undefined, { user: 'bob' });
		await vi.waitFor(() => expect(second.closed).toEqual(unavailable));
		expect(await inRoom(room, (r) => r.failure?.message)).toBe('injected read failure');

		// The next dial loads the rows, and the edit is resent and stored.
		const own = document.doc.clientID;
		const back = await RawClient.connect(room, document.doc, { user: 'ada' });
		await vi.waitFor(() => expect(back.acks.at(-1)?.get(own)).toBe(clockOf(document.doc)));
		expect(back.closed).toBeNull();
		expect(await inRoom(room, (r) => [r.failure, storedText(r, 'p')])).toEqual([null, 'hello!']);
		back.close();
		document.destroy();
	});

	it('a read fault at cold start: 1011 while it lasts, then a healthy dial restores the room', async () => {
		const room = 'rw08-cold-start';
		const document = E.createDocument({ value: { children: [para('p', 'hello')] } });
		const author = await RawClient.connect(room, document.doc, { user: 'ada' });
		await vi.waitFor(() => expect(author.acks.length).toBeGreaterThan(0));
		author.close();
		// The start the constructor runs, with its read of the rows failing
		// (and the retry of the first dial after it).
		const failure = await inRoom(room, async (r) => {
			failReads(r, 2);
			await (r.room as unknown as { start: () => Promise<void> }).start();
			return [r.failure?.message, r.doc];
		});
		expect(failure).toEqual(['injected read failure', null]);

		expect(await dialOutcome(room, { user: 'bob' })).toEqual(unavailable);
		expect(await dialOutcome(room, { user: 'bob' })).toBe('open');
		expect(await inRoom(room, (r) => [r.failure, storedText(r, 'p')])).toEqual([null, 'hello']);
		document.destroy();
	});
});

describe('RW-09 · a persistent append fault does not make the provider redial every 100 ms', () => {
	it('the dials back off while every append fails, and the edit is stored once appends work', async () => {
		const room = 'rw09-append-fault';
		const seed = E.createDocument({ value: { children: [para('p', 'hello')] } });
		const seeder = await RawClient.connect(room, seed.doc, { user: 'ada' });
		await vi.waitFor(() => expect(seeder.acks.length).toBeGreaterThan(0));
		seeder.close();
		await inRoom(room, (_r, state) => state.storage.sql.exec(FAIL_APPEND));

		const document = E.createDocument({ value: { children: [para('p', 'hello')] } });
		document.transact(() => document.facade.insertText('p', 5, '!'));
		const refused: unknown[] = [];
		const { provider, dials } = dialingProvider(room, document.doc, { user: 'dan' });
		provider.on('refused', (refusal: unknown) => refused.push(refusal));
		// Each fault after a sync is reported (the RW-09 gap): the faults in a row, the next dial.
		const unreachable: { attempts: number; nextRetryMs: number }[] = [];
		provider.on('unreachable', (state) => unreachable.push(state));
		// Every dial syncs, sends the edit, and is closed 1011 when its append
		// fails. Backing off from 100 ms (200, 400, 800, 1600 ms…), four
		// seconds hold at most six dials; redialing every 100 ms, dozens.
		await new Promise((resolve) => setTimeout(resolve, 4000));
		const during = dials.count;
		const faults = await inRoom(room, (r) => r.refusalCounts.storage ?? 0);
		expect(during).toBeGreaterThanOrEqual(3);
		expect(during).toBeLessThanOrEqual(6);
		expect(faults).toBeLessThanOrEqual(during);
		expect(unreachable.length).toBeGreaterThanOrEqual(during - 1);
		expect(unreachable.slice(0, 3)).toEqual([
			{ attempts: 1, nextRetryMs: 200 },
			{ attempts: 2, nextRetryMs: 400 },
			{ attempts: 3, nextRetryMs: 800 }
		]);

		await inRoom(room, (_r, state) => state.storage.sql.exec('DROP TRIGGER fail_append'));
		await vi.waitFor(() => expect(provider.saved).toBe(true), { timeout: 10_000 });
		const stored = await inRoom(room, (r) => storedText(r, 'p'));
		provider.destroy();
		document.destroy();
		seed.destroy();
		expect({ stored, refused }).toEqual({ stored: 'hello!', refused: [] });
	});
});

describe('RW-10 · after a restore from a lagging snapshot, the relaying provider is saved', () => {
	it("Bob's provider reports saved once the room stored his edit, though Ada's is stripped", async () => {
		const room = 'hooked-restore-lag-saved';
		const a = crdt.createDoc();
		const tabA = await RawClient.connect(room, a, { user: 'ada', replica: a.clientID });
		await vi.waitFor(() => expect(textOf(tabA)).toBe('from onLoad'));
		const ada = E.attachDocument(a, { actor: { id: 'ada' } });
		ada.transact(() => ada.facade.insertText('seed', 0, 'ada: '));
		await vi.waitFor(() => expect(tabA.acks.at(-1)?.get(a.clientID)).toBe(clockOf(a)));
		expect(await runDurableObjectAlarm(hooked(room))).toBe(true);
		const snapshot = await inHooked(
			room,
			(_r, state) =>
				state.storage.sql.exec<{ id: number }>('SELECT MAX(rowid) AS id FROM mirror').one().id
		);

		// Bob's tab hears Ada's "!" from the room, then goes offline.
		const b = crdt.createDoc();
		const { provider } = dialingProvider(room, b, { user: 'bob' });
		await vi.waitFor(() => expect(provider.synced).toBe(true));
		ada.transact(() => ada.facade.insertText('seed', 'ada: from onLoad'.length, '!'));
		await vi.waitFor(() =>
			expect(readFacade(b, (f) => f.blockText('seed'))).toBe('ada: from onLoad!')
		);
		provider.disconnect();
		tabA.close();

		// Storage loss: the room restores from the snapshot, without Ada's "!".
		await inHooked(room, async (_r, state) => {
			state.storage.sql.exec('DELETE FROM rows');
			state.storage.sql.exec('DELETE FROM replicas');
			state.storage.sql.exec('DELETE FROM mirror WHERE rowid > ?', snapshot);
			await state.storage.deleteAlarm();
		});
		await evictDurableObject(hooked(room));

		// Offline, Bob types; back online, the room strips Ada's "!" and stores his edit.
		const bob = E.attachDocument(b, { actor: { id: 'bob' } });
		bob.transact(() => bob.facade.insertText('seed', 'ada: '.length, '[bob] '));
		expect(provider.saved).toBe(false);
		provider.connect();
		await vi.waitFor(() => expect(provider.saved).toBe(true), { timeout: 10_000 });
		const stored = await inHooked(room, (r) => storedText(r, 'seed'));
		expect({ stored, unsaved: provider.unsaved }).toEqual({
			stored: 'ada: [bob] from onLoad',
			unsaved: 0
		});
		provider.destroy();
		ada.destroy();
		bob.destroy();
	});
});
