/**
 * Re-score 3 (2026-09-30) — the room's Durable Object units, in workerd:
 *
 * - FW-09: after a restore from a lagging snapshot, a relayer's deletes of
 *   the items the room holds under a stripped author's id are stored and
 *   relayed (anyone may delete), and its provider reaches `saved`; only
 *   the deletes of what the room lacks, or of entries the stripped structs
 *   replace, are dropped.
 * - FW-11: an alarm that fires while the room cannot read its rows (a
 *   retryable failure) keeps the save due: `onSave` runs once the room
 *   recovers.
 * - Sweep: the router closes an invalid document id `4400` (final), and
 *   `attachDocument` on a non-Durable Object throws a clear error.
 *
 * Expected values are hand-authored from the edits each test performs.
 */
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { attachDocument, type DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import type { HookedRoom } from './worker';
import {
	E,
	ORIGIN,
	RawClient,
	SelfWebSocket,
	Y,
	crdt,
	dialOutcome,
	readFacade,
	shape,
	storedUpdate
} from './client';

const hooked = (room: string) => env.HOOKED.getByName(room);
const inHooked = <T>(room: string, fn: (r: HookedRoom, state: DurableObjectState) => T) =>
	runInDurableObject(hooked(room), (r: HookedRoom, state) => fn(r, state));

const clockOf = (doc: E.YDoc) => Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID);
const textOf = (client: RawClient) => shape(client.json()).children[0]?.text;

type Facade = Parameters<Parameters<typeof readFacade>[1]>[0];

/** The document as the room STORED it (its rows, merged), read with `read`. */
const stored = <T>(r: Room, read: (facade: Facade) => T) => {
	const doc = crdt.createDoc();
	Y.applyUpdate(doc, storedUpdate(r.records()));
	return readFacade(doc, read);
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

/** The first block's text in each `onSave` mirror, oldest first. */
const mirrored = (room: string) =>
	inHooked(room, (_r, state) => {
		state.storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS mirror (json TEXT, size INTEGER, bytes BLOB, replicas TEXT)'
		);
		return state.storage.sql
			.exec<{ json: string }>('SELECT json FROM mirror ORDER BY rowid')
			.toArray()
			.map((row) => shape(JSON.parse(row.json)).children[0].text);
	});

/** The shipped provider over `SELF`. */
const provide = (room: string, document: E.YDoc, params: Record<string, string>) =>
	new crdt.providers.WebsocketProvider(`${ORIGIN.replace('https', 'wss')}/rooms`, room, document, {
		params,
		WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
		disableBc: true
	});

type Attached = ReturnType<typeof E.attachDocument>;

/**
 * Ada writes `ada: ` and the data `{ tone: 'cool' }`, and the room saves a
 * snapshot; Bob's provider hears her next edit (`edit`), then goes
 * offline; the room loses its storage and restores the snapshot, without
 * Ada's edit. Returns Bob's doc and provider, offline, and Ada's document
 * (her tab is closed).
 */
const restoreBehindAda = async (room: string, edit: (ada: Attached) => void) => {
	const a = crdt.createDoc();
	const tabA = await RawClient.connect(room, a, { user: 'ada', replica: a.clientID });
	await vi.waitFor(() => expect(textOf(tabA)).toBe('from onLoad'));
	const ada = E.attachDocument(a, { actor: { id: 'ada' } });
	ada.transact(() => {
		ada.facade.insertText('seed', 0, 'ada: ');
		ada.facade.setBlockData('seed', { tone: 'cool' });
	});
	await vi.waitFor(() => expect(tabA.acks.at(-1)?.get(a.clientID)).toBe(clockOf(a)));
	expect(await runDurableObjectAlarm(hooked(room))).toBe(true);
	const snapshot = await inHooked(
		room,
		(_r, state) =>
			state.storage.sql.exec<{ id: number }>('SELECT MAX(rowid) AS id FROM mirror').one().id
	);

	const b = crdt.createDoc();
	const provider = provide(room, b, { user: 'bob' });
	await vi.waitFor(() => expect(provider.synced).toBe(true));
	const heard = clockOf(a);
	ada.transact(() => edit(ada));
	await vi.waitFor(() =>
		expect(Y.decodeStateVector(Y.encodeStateVector(b)).get(a.clientID)).toBe(clockOf(a))
	);
	expect(clockOf(a)).toBeGreaterThan(heard ?? 0);
	provider.disconnect();
	tabA.close();

	await inHooked(room, async (_r, state) => {
		state.storage.sql.exec('DELETE FROM rows');
		state.storage.sql.exec('DELETE FROM replicas');
		state.storage.sql.exec('DELETE FROM mirror WHERE rowid > ?', snapshot);
		await state.storage.deleteAlarm();
	});
	await evictDurableObject(hooked(room));
	return { b, provider, ada };
};

describe("FW-09 · a relayer's deletes of a stripped author's stored items are kept", () => {
	it("Bob deletes Ada's stored prefix: stored, relayed to Carol, and Bob reaches saved", async () => {
		const room = 'hooked-restore-fw09-prefix';
		const { b, provider, ada } = await restoreBehindAda(room, (ada) =>
			ada.facade.insertText('seed', 'ada: from onLoad'.length, '!')
		);
		expect(readFacade(b, (f) => f.blockText('seed'))).toBe('ada: from onLoad!');

		// Carol opens the restored room: she sees the snapshot.
		const carol = await RawClient.connect(room, undefined, { user: 'carol' });
		await vi.waitFor(() => expect(textOf(carol)).toBe('ada: from onLoad'));

		// Offline, Bob deletes Ada's "ada: "; back online, Ada's "!" is stripped.
		const bob = E.attachDocument(b, { actor: { id: 'bob' } });
		bob.transact(() => bob.facade.deleteText('seed', 0, 'ada: '.length));
		provider.connect();
		await vi.waitFor(() => expect(textOf(carol)).toBe('from onLoad'));
		await vi.waitFor(() => expect(provider.saved).toBe(true), { timeout: 10_000 });
		const text = await inHooked(room, (r) => stored(r, (f) => f.blockText('seed')));
		expect({ text, bob: readFacade(b, (f) => f.blockText('seed')) }).toEqual({
			text: 'from onLoad',
			// Ada's "!" reaches the room with her own client.
			bob: 'from onLoad!'
		});
		carol.close();
		provider.destroy();
		ada.destroy();
		bob.destroy();
	});

	it("a stripped rewrite of Ada's stored entry does not delete it: the value stays", async () => {
		const room = 'hooked-restore-fw09-entry';
		const { b, provider, ada } = await restoreBehindAda(room, (ada) =>
			ada.facade.setBlockData('seed', { tone: 'warm' })
		);
		const data = (f: { toJSON(): E.JSONDoc }) => f.toJSON().children[0].data;
		expect(readFacade(b, data)).toEqual({ tone: 'warm' });

		// Bob's handshake relays Ada's rewrite (stripped) and its delete of the
		// entry it replaces: the room keeps what it holds.
		const carol = await RawClient.connect(room, undefined, { user: 'carol' });
		await vi.waitFor(() => expect(textOf(carol)).toBe('ada: from onLoad'));
		provider.connect();
		await vi.waitFor(() => expect(provider.synced).toBe(true));
		await vi.waitFor(() => expect(carol.acks.length).toBeGreaterThan(0));
		const after = await inHooked(room, (r) => [r.room.read().children[0].data, stored(r, data)]);
		expect(after).toEqual([{ tone: 'cool' }, { tone: 'cool' }]);
		carol.close();
		provider.destroy();
		ada.destroy();
	});
});

describe('FW-11 · an alarm during a retryable failure keeps the save due', () => {
	it('the alarm fires while the rows cannot be read: onSave runs once the room recovers', async () => {
		const room = 'hooked-fw11-alarm';
		const a = crdt.createDoc();
		const tab = await RawClient.connect(room, a, { user: 'ada' });
		await vi.waitFor(() => expect(textOf(tab)).toBe('from onLoad'));
		const ada = E.attachDocument(a, { actor: { id: 'ada' } });
		ada.transact(() => ada.facade.insertText('seed', 0, 'ada: '));
		await vi.waitFor(() => expect(tab.acks.at(-1)?.get(a.clientID)).toBe(clockOf(a)));
		tab.close();

		// The room restarts and cannot read its rows; the alarm's own retry fails too.
		await inHooked(room, async (r) => {
			failReads(r, 2);
			await (r.room as unknown as { start: () => Promise<void> }).start();
			expect(r.doc).toBeNull();
		});
		await runDurableObjectAlarm(hooked(room));
		expect(await mirrored(room)).toEqual([]);

		// A dial recovers the room; the save is still due.
		const back = await RawClient.connect(room, undefined, { user: 'bob' });
		await vi.waitFor(() => expect(textOf(back)).toBe('ada: from onLoad'));
		back.close();
		expect(await runDurableObjectAlarm(hooked(room))).toBe(true);
		expect(await mirrored(room)).toEqual(['ada: from onLoad']);
		ada.destroy();
	});

	it('an alarm whose retry recovers the room saves at once', async () => {
		const room = 'hooked-fw11-alarm-retry';
		const a = crdt.createDoc();
		const tab = await RawClient.connect(room, a, { user: 'ada' });
		await vi.waitFor(() => expect(textOf(tab)).toBe('from onLoad'));
		const ada = E.attachDocument(a, { actor: { id: 'ada' } });
		ada.transact(() => ada.facade.insertText('seed', 0, 'ada: '));
		await vi.waitFor(() => expect(tab.acks.at(-1)?.get(a.clientID)).toBe(clockOf(a)));
		tab.close();

		await inHooked(room, async (r) => {
			failReads(r, 1);
			await (r.room as unknown as { start: () => Promise<void> }).start();
			expect(r.doc).toBeNull();
		});
		expect(await runDurableObjectAlarm(hooked(room))).toBe(true);
		expect(await mirrored(room)).toEqual(['ada: from onLoad']);
		// Nothing is left due.
		expect(await runDurableObjectAlarm(hooked(room))).toBe(false);
		ada.destroy();
	});
});

describe('sweep · a dial the router turns away is closed, never an HTTP error', () => {
	it('a document id over 256 characters is closed 4400 (final), not answered 400', async () => {
		expect(await dialOutcome('x'.repeat(300), { user: 'ada' })).toEqual({
			code: 4400,
			reason: 'invalid document id'
		});
	});
});

describe('sweep · attachDocument on something that is not a Durable Object', () => {
	it('throws a clear error instead of a TypeError on `storage`', () => {
		expect(() => attachDocument({} as never)).toThrow(
			'attachDocument(this): `this` must be a Durable Object (a class extending DurableObject, after super())'
		);
	});
});
