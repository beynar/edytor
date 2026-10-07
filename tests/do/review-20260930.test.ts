/**
 * Re-score 2026-09-30 — the room's remaining Durable Object findings
 * (workerd, SQLite):
 *
 * - NW-01: a restore from a lagging snapshot. A client relaying another
 *   user's edits stays connected and its own edits are stored; relayed
 *   structs never transfer an id, and are accepted only where the room
 *   holds none of that id's clocks.
 * - NW-02: server and storage faults close 1011 (the provider redials),
 *   never 1008 `malformed`; a failed reload inside a rebuild is retryable.
 * - Lows: the room-side replica refusal is a `4409` close, an expired
 *   credential is a `4401` close, a wake keeps a pending save alarm, and
 *   `semantics()` is read once the subclass's fields exist.
 *
 * Expected values are hand-authored from the edits each test performs.
 */
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room, Refusal } from '../../src/lib/cloudflare/index.js';
import type { FieldRoom, HookedRoom } from './worker';
import {
	E,
	ORIGIN,
	REPLICA_TAKEN,
	RawClient,
	SelfWebSocket,
	Y,
	crdt,
	dialOutcome,
	para,
	readFacade,
	shape,
	upgrade,
	storedUpdate
} from './client';

declare global {
	namespace Cloudflare {
		interface Env {
			FIELDS: DurableObjectNamespace<FieldRoom>;
		}
	}
}

const hooked = (room: string) => env.HOOKED.getByName(room);
const inHooked = <T>(room: string, fn: (r: HookedRoom, state: DurableObjectState) => T) =>
	runInDurableObject(hooked(room), (r: HookedRoom, state) => fn(r, state));
const inRoom = <T>(room: string, fn: (r: Room, state: DurableObjectState) => T) =>
	runInDurableObject(env.ROOM.getByName(room), (r: Room, state) => fn(r, state));

const clockOf = (doc: E.YDoc) => Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID);
const textOf = (client: RawClient) => shape(client.json()).children[0]?.text;
/** Distinct log entries (a handshake may deliver the same relay twice: the room's Step1 and its answer to ours). */
const byJSON = (refusals: Refusal[]) => [...new Set(refusals.map((x) => JSON.stringify(x)))].sort();

/** The text of block `id` in what the room STORED (its rows, merged). */
const storedText = (r: Room, id: string) => {
	const stored = crdt.createDoc();
	Y.applyUpdate(stored, storedUpdate(r.records()));
	return readFacade(stored, (f) => f.blockText(id));
};

describe('NW-01 · a restore from a lagging snapshot', () => {
	/**
	 * Ada writes under A; the alarm saves (the snapshot). Then Bob (B)
	 * joins, and Ada writes on under A and from a second tab (A2, a client
	 * id the snapshot never saw). Every tab closes, the room's tables are
	 * wiped, and it restores from the lagging snapshot. Offline, Bob types.
	 */
	const lag = async (room: string) => {
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

		const b = crdt.createDoc();
		const tabB = await RawClient.connect(room, b, { user: 'bob', replica: b.clientID });
		const a2 = crdt.createDoc();
		Y.applyUpdate(a2, Y.encodeStateAsUpdate(a));
		const tabA2 = await RawClient.connect(room, a2, { user: 'ada', replica: a2.clientID });
		const ada2 = E.attachDocument(a2, { actor: { id: 'ada' } });
		ada.transact(() => ada.facade.insertText('seed', 'ada: from onLoad'.length, '!'));
		ada2.transact(() => ada2.facade.insertText('seed', 0, '> '));
		await vi.waitFor(() => expect(textOf(tabB)).toBe('> ada: from onLoad!'));
		for (const tab of [tabA, tabA2, tabB]) tab.close();

		// Storage loss: the room's tables go, and any save after the snapshot.
		await inHooked(room, async (_r, state) => {
			state.storage.sql.exec('DELETE FROM rows');
			state.storage.sql.exec('DELETE FROM replicas');
			state.storage.sql.exec('DELETE FROM mirror WHERE rowid > ?', snapshot);
			await state.storage.deleteAlarm();
		});
		await evictDurableObject(hooked(room));
		expect(shape(await inHooked(room, (r) => r.read())).children[0].text).toBe('ada: from onLoad');

		const bob = E.attachDocument(b, { actor: { id: 'bob' } });
		bob.transact(() => bob.facade.insertText('seed', '> ada: '.length, '[bob] '));
		return { a, a2, b, ada, ada2, bob };
	};

	for (const [room, bare] of [
		['hooked-restore-lag', false],
		['hooked-restore-bare-lag', true]
	] as const) {
		it(`${bare ? 'a bare update' : '{ update, replicas }'}: Bob stays and his edits are stored; Ada keeps her ids`, async () => {
			const { a, a2, b, ada, ada2, bob } = await lag(room);
			const A = a.clientID;
			const A2 = a2.clientID;

			// Bob's handshake carries A's "!" (the room holds A's earlier
			// clocks: stripped), A2's "> " (a client id the room holds nothing
			// of: relayed, left unowned) and his own edit (stored).
			const tabB = await RawClient.connect(room, b, { user: 'bob', replica: b.clientID });
			await vi.waitFor(() => expect(tabB.acks.at(-1)?.get(b.clientID)).toBe(clockOf(b)));
			const afterBob = await inHooked(room, (r) => ({
				stored: storedText(r, 'seed'),
				refusals: byJSON(r.refusals)
			}));
			expect(tabB.closed).toBeNull();
			expect(afterBob).toEqual({
				stored: '> ada: [bob] from onLoad',
				refusals: byJSON([
					{ reason: 'replica', detail: A },
					{ reason: 'relayed', detail: { replica: A2, user: 'bob' } },
					// A2's binding to Ada is not Bob's to vouch for (D5, WU-07):
					// collected, and written again when Ada claims A2.
					{ reason: 'forged', detail: { user: 'bob', keys: [`c/${A2}`] } }
				])
			});

			// Ada comes back under A: her id is still hers (or, after a bare
			// restore, claimable by her dial), and her "!" is stored.
			const tabA = await RawClient.connect(room, a, { user: 'ada', replica: A });
			await vi.waitFor(() => expect(tabA.acks.at(-1)?.get(A)).toBe(clockOf(a)));
			await vi.waitFor(() => expect(textOf(tabB)).toBe('> ada: [bob] from onLoad!'));
			expect(tabA.closed).toBeNull();
			// A2 was left unowned by the relay: Ada's second tab claims it.
			expect(await dialOutcome(room, { user: 'ada', replica: A2 })).toBe('open');
			const bindingOfA2 = await inHooked(room, (r) =>
				(r.doc!.get('attribution') as unknown as { getAttr(k: string): unknown }).getAttr(`c/${A2}`)
			);
			expect(bindingOfA2).toBe('ada');
			// Nobody else can take either id.
			expect(await dialOutcome(room, { user: 'eve', replica: A })).toEqual(REPLICA_TAKEN);
			expect(await dialOutcome(room, { user: 'eve', replica: A2 })).toEqual(REPLICA_TAKEN);
			expect(await dialOutcome(room, { user: 'bob', replica: A2 })).toEqual(REPLICA_TAKEN);
			const owners = await inHooked(room, (_r, state) =>
				state.storage.sql
					.exec<{ replica: number; user: string }>('SELECT replica, user FROM replicas')
					.toArray()
					.filter((x) => [A, A2, b.clientID].includes(x.replica))
					.sort((x, y) => x.user.localeCompare(y.user) || x.replica - y.replica)
			);
			expect(owners).toEqual(
				[
					{ replica: A, user: 'ada' },
					{ replica: A2, user: 'ada' },
					{ replica: b.clientID, user: 'bob' }
				].sort((x, y) => x.user.localeCompare(y.user) || x.replica - y.replica)
			);
			tabA.close();
			tabB.close();
			for (const document of [ada, ada2, bob]) document.destroy();
		});
	}
});

describe('NW-02 · server and storage faults close 1011, never 1008 malformed', () => {
	const failRegistry =
		"CREATE TRIGGER fail_register BEFORE INSERT ON replicas BEGIN SELECT RAISE(ABORT, 'injected registry failure'); END";

	it('a registry write fault: a fresh client update and an unbound presence frame close 1011 storage', async () => {
		const room = 'nw02-registry-fault';
		const seed = E.createDocument({ value: { children: [para('p', 'hello')] } });
		const seeder = await RawClient.connect(room, seed.doc, { user: 'ada' });
		await vi.waitFor(() => expect(seeder.stored()).toBe(true));
		const writer = await RawClient.connect(room, undefined, { user: 'bob' });
		const viewer = await RawClient.connect(room, undefined, { user: 'cat' });
		await vi.waitFor(() => expect(writer.synced && viewer.synced).toBe(true));
		await inRoom(room, (_r, state) => state.storage.sql.exec(failRegistry));

		// Bob's first write registers his fresh client id: the insert fails.
		const bob = E.attachDocument(writer.doc, { actor: { id: 'bob' } });
		bob.transact(() => bob.facade.insertText('p', 5, '!'));
		// Cat's first presence entry binds (registers) her replica: it fails too.
		viewer.setPresence(9001, 1, { user: { name: 'Cat' } });
		const storageFailure = { code: 1011, reason: 'storage failure' };
		await vi.waitFor(() => expect(writer.closed).toEqual(storageFailure));
		await vi.waitFor(() => expect(viewer.closed).toEqual(storageFailure));
		const observed = await inRoom(room, (r) => ({
			stored: storedText(r, 'p'),
			reasons: r.refusals.map((x) => x.reason)
		}));
		expect(observed).toEqual({ stored: 'hello', reasons: ['storage', 'storage'] });
		expect(seeder.closed).toBeNull();
		await inRoom(room, (_r, state) => state.storage.sql.exec('DROP TRIGGER fail_register'));
		seeder.close();
		bob.destroy();
		seed.destroy();
	});

	it('the shipped provider redials through a registry fault: the edit is stored, no refused event', async () => {
		const room = 'nw02-registry-provider';
		const seed = E.createDocument({ value: { children: [para('p', 'hello')] } });
		const seeder = await RawClient.connect(room, seed.doc, { user: 'ada' });
		await vi.waitFor(() => expect(seeder.stored()).toBe(true));
		seeder.close();
		await inRoom(room, (_r, state) => state.storage.sql.exec(failRegistry));

		const document = E.createDocument({ value: { children: [para('p', 'hello')] } });
		document.transact(() => document.facade.insertText('p', 5, '!'));
		const refused: unknown[] = [];
		const provider = new crdt.providers.WebsocketProvider(
			`${ORIGIN.replace('https', 'wss')}/rooms`,
			room,
			document.doc,
			{
				awareness: document.awareness,
				params: { user: 'dan' },
				WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
				disableBc: true
			}
		);
		provider.on('refused', (refusal: unknown) => refused.push(refusal));
		// The dial registers the replica: the room accepts, then closes 1011.
		await vi.waitFor(async () =>
			expect(await inRoom(room, (r) => r.refusalCounts.storage ?? 0)).toBeGreaterThanOrEqual(2)
		);
		await inRoom(room, (_r, state) => state.storage.sql.exec('DROP TRIGGER fail_register'));
		await vi.waitFor(() => expect(provider.saved).toBe(true), { timeout: 10_000 });
		const observed = await inRoom(room, (r) => ({
			stored: storedText(r, 'p'),
			reasons: [...new Set(r.refusals.map((x) => x.reason))]
		}));
		provider.destroy();
		document.destroy();
		seed.destroy();
		expect({ observed, refused }).toEqual({
			observed: { stored: 'hello!', reasons: ['storage'] },
			refused: []
		});
	});

	it('a load failure while rebuilding after a failed append is retryable: sockets close 1011, the next dial restores', async () => {
		const room = 'nw02-rebuild-load';
		const document = E.createDocument({ value: { children: [para('p', 'hello')] } });
		const author = await RawClient.connect(room, document.doc, { user: 'ada' });
		await vi.waitFor(() => expect(author.stored()).toBe(true));
		const peer = await RawClient.connect(room, undefined, { user: 'bob' });
		await vi.waitFor(() => expect(peer.synced).toBe(true));
		await inRoom(room, (r, state) => {
			state.storage.sql.exec(
				"CREATE TRIGGER fail_append BEFORE INSERT ON rows WHEN NEW.kind = 'update' BEGIN SELECT RAISE(ABORT, 'injected append failure'); END"
			);
			// The rebuild's read of the rows fails once (a transient I/O error).
			const room = r.room as unknown as { records: () => unknown };
			const records = room.records.bind(room);
			let failures = 1;
			room.records = () => {
				if (failures-- > 0) throw new Error('injected read failure');
				return records();
			};
		});
		document.transact(() => document.facade.insertText('p', 5, '!'));
		await vi.waitFor(() =>
			expect(author.closed).toEqual({ code: 1011, reason: 'storage failure' })
		);
		// The peer's next frame finds no document: retryable, so 1011.
		peer.send(E.frame(E.messageSync, (e) => crdt.sync.writeSyncStep1(e, peer.doc)));
		await vi.waitFor(() => expect(peer.closed).toEqual({ code: 1011, reason: 'room unavailable' }));
		await inRoom(room, (_r, state) => state.storage.sql.exec('DROP TRIGGER fail_append'));

		const own = document.doc.clientID;
		const back = await RawClient.connect(room, document.doc, { user: 'ada' });
		await vi.waitFor(() => expect(back.acks.at(-1)?.get(own)).toBe(clockOf(document.doc)));
		expect(back.closed).toBeNull();
		expect(await inRoom(room, (r) => [r.failure, storedText(r, 'p')])).toEqual([null, 'hello!']);
		back.close();
		document.destroy();
	});

	it('a frame the room cannot decode is still 1008 malformed', async () => {
		const room = 'nw02-malformed';
		const client = await RawClient.bare(room, { user: 'ada' });
		const garbage = Uint8Array.of(0xff, 0xff, 0xff, 0x01);
		client.send(E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, garbage)));
		await vi.waitFor(() =>
			expect(client.closed).toEqual({ code: 1008, reason: 'refused: malformed' })
		);
	});
});

describe('room-side refusals at the dial', () => {
	it('a replica bound to another user is accepted, then closed 4409 (terminal for the provider)', async () => {
		const room = 'replica-taken-4409';
		const ada = await RawClient.connect(room, undefined, { user: 'ada', replica: 4242 });
		await vi.waitFor(() => expect(ada.synced).toBe(true));
		const eve = await upgrade(room, { user: 'eve', replica: 4242 });
		const closed = new Promise((resolve) =>
			eve.addEventListener('close', (event) => resolve([event.code, event.reason]))
		);
		expect(await closed).toEqual([REPLICA_TAKEN.code, REPLICA_TAKEN.reason]);
		expect(await inRoom(room, (r) => r.refusals)).toEqual([{ reason: 'replica', detail: 4242 }]);

		// The shipped provider stops dialing on it.
		const document = E.createDocument();
		const refused: Array<{ code: number; reason: string }> = [];
		const provider = new crdt.providers.WebsocketProvider(
			`${ORIGIN.replace('https', 'wss')}/rooms`,
			room,
			document.doc,
			{
				awareness: document.awareness,
				params: { user: 'eve', replica: '4242' },
				WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
				disableBc: true
			}
		);
		provider.on('refused', (refusal: { code: number; reason: string }) =>
			refused.push({ code: refusal.code, reason: refusal.reason })
		);
		await vi.waitFor(() => expect(refused).toEqual([REPLICA_TAKEN]));
		expect(provider.shouldConnect).toBe(false);
		provider.destroy();
		document.destroy();
		ada.close();
	});

	it("an expired credential is accepted, then closed 4401 'expired'; the room is never reached", async () => {
		const room = 'expired-4401';
		const ws = await upgrade(room, { user: 'expired' });
		const closed = new Promise((resolve) =>
			ws.addEventListener('close', (event) => resolve([event.code, event.reason]))
		);
		expect(await closed).toEqual([4401, 'expired']);
		expect(await inRoom(room, (_r, state) => state.getWebSockets().length)).toBe(0);
	});
});

describe('the save alarm and subclass semantics', () => {
	it('a wake keeps a pending save alarm: an edit after it does not push the save back', async () => {
		const room = 'hooked-alarm-kept';
		const at = await inHooked(room, async (_r, state) => {
			const at = Date.now() + 60_000;
			await state.storage.setAlarm(at);
			return at;
		});
		await evictDurableObject(hooked(room));
		await inHooked(room, (r) => r.transact((f) => f.insertText('seed', 0, 'x')));
		expect(await inHooked(room, (_r, state) => state.storage.getAlarm())).toBe(at);
		await inHooked(room, (_r, state) => state.storage.deleteAlarm());
	});

	it('semantics() is read after the subclass fields exist', async () => {
		const types = await runInDurableObject(env.FIELDS.getByName('fields-a'), (r: Room) => {
			r.transact(() => undefined);
			return r.read().children.map((block) => block.type);
		});
		expect(types).toEqual(['heading']);
	});
});
