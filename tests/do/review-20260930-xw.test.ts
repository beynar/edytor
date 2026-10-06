/**
 * Re-score 4 (2026-09-30) — the saved-state units, in workerd:
 *
 * - XW-02: a read-only socket's provider reaches `saved` — after a reload
 *   that replays the local copy (the previous session's actor record), with
 *   a second tab of the same viewer on the channel, when a peer's
 *   delete-only edit reaches it over the channel first, and on an empty
 *   room its document seeds. The room tells a read-only socket so when it
 *   joins; its provider then tracks nothing (nothing it writes can be
 *   stored).
 *
 * - XW-07: after a restore from a lagging snapshot, a relayer's delete of
 *   an author's text the room lost is stored (it waits for that text):
 *   when the author returns, the text arrives deleted — in the room, for
 *   the other clients, and for the author.
 *
 * Expected values are hand-authored from the edits each test performs.
 */
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import * as encoding from 'lib0-v14/encoding';
import { describe, expect, it, vi } from 'vitest';
import { MAX_WAITING_DELETES, type DocumentRoom } from '../../src/lib/cloudflare/index.js';
import type { HookedRoom } from './worker';
import {
	E,
	ORIGIN,
	RawClient,
	SelfWebSocket,
	Y,
	crdt,
	readFacade,
	shape,
	storedUpdate
} from './client';

const textOf = (client: RawClient) => shape(client.json()).children[0]?.text;
const url = `${ORIGIN.replace('https', 'wss')}/rooms`;

/** The shipped provider over `SELF`, read-only for `user`. */
const viewerProvider = (
	room: string,
	doc: E.YDoc,
	{ connect = true, disableBc = true }: { connect?: boolean; disableBc?: boolean } = {}
) =>
	new crdt.providers.WebsocketProvider(url, room, doc, {
		params: { user: 'viv', access: 'read' },
		WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
		disableBc,
		connect
	});

/** Ada, a writer, holding the room's loaded document. */
const author = async (room: string) => {
	const a = crdt.createDoc();
	const tab = await RawClient.connect(room, a, { user: 'ada', replica: a.clientID });
	await vi.waitFor(() => expect(textOf(tab)).toBe('from onLoad'));
	return tab;
};

describe('XW-02 · a read-only socket reaches saved', () => {
	it('after a reload that replays the local copy (the previous session’s actor record)', async () => {
		const room = 'hooked-xw02-reload';
		const tab = await author(room);
		const first = E.createDocument({ actor: { id: 'viv' } });
		const before = viewerProvider(room, first.doc);
		await vi.waitFor(() => expect(before.saved && before.synced).toBe(true));
		const copy = Y.encodeStateAsUpdate(first.doc);
		before.destroy();
		first.destroy();

		const reloaded = E.createDocument({ actor: { id: 'viv' } });
		const viewer = viewerProvider(room, reloaded.doc, { connect: false });
		Y.applyUpdate(reloaded.doc, copy, { store: true });
		viewer.connect();
		await vi.waitFor(() => expect(viewer.synced).toBe(true));
		await vi.waitFor(() => expect([viewer.saved, viewer.unsaved]).toEqual([true, 0]), {
			timeout: 5_000
		});
		viewer.destroy();
		reloaded.destroy();
		tab.close();
	});

	it('with a second tab of the same viewer on the channel', async () => {
		const room = 'hooked-xw02-tabs';
		const tab = await author(room);
		const one = E.createDocument({ actor: { id: 'viv' } });
		const two = E.createDocument({ actor: { id: 'viv' } });
		const first = viewerProvider(room, one.doc, { disableBc: false });
		await vi.waitFor(() => expect(first.synced).toBe(true));
		const second = viewerProvider(room, two.doc, { disableBc: false });
		await vi.waitFor(() => expect(second.synced).toBe(true));
		// Each tab heard the other's actor record over the channel.
		await vi.waitFor(() =>
			expect([
				one.doc.store.clients.has(two.doc.clientID),
				two.doc.store.clients.has(one.doc.clientID)
			]).toEqual([true, true])
		);
		await vi.waitFor(
			() =>
				expect([first.saved, first.unsaved, second.saved, second.unsaved]).toEqual([
					true,
					0,
					true,
					0
				]),
			{ timeout: 5_000 }
		);
		first.destroy();
		second.destroy();
		one.destroy();
		two.destroy();
		tab.close();
	});

	it("when a peer's delete-only edit reaches it over the channel before the socket", async () => {
		const room = 'hooked-xw02-relayed-delete';
		const tab = await author(room);
		const viewer = E.createDocument({ actor: { id: 'viv' } });
		const viewers = viewerProvider(room, viewer.doc, { disableBc: false });
		await vi.waitFor(() => expect(viewers.synced).toBe(true));
		await vi.waitFor(() => expect(viewers.saved).toBe(true));

		// Ada types, then deletes part of her own text; another tab of the
		// viewer heard it and relays it.
		const ada = E.attachDocument(tab.doc, { actor: { id: 'ada' } });
		ada.transact(() => ada.facade.insertText('seed', 'from onLoad'.length, ' ada'));
		await vi.waitFor(() => expect(viewer.facade.blockText('seed')).toBe('from onLoad ada'));
		const heard: Uint8Array[] = [];
		tab.doc.on('update', (update: Uint8Array) => heard.push(update));
		ada.transact(() => ada.facade.deleteText('seed', 'from onLoad'.length, 2));
		// Its delete part alone, as a delete that adds no data (an undone insert) is sent.
		const body = new Y.UpdateEncoderV1();
		encoding.writeVarUint(body.restEncoder, 0); // no structs
		Y.writeIdSet(body, Y.decodeUpdate(heard.at(-1)!).ds);
		const deletion = body.toUint8Array();
		expect(Y.decodeUpdate(deletion).structs).toEqual([]);
		viewers._bcSubscriber(
			E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, deletion)).buffer as ArrayBuffer,
			{}
		);
		await vi.waitFor(() => expect(viewer.facade.blockText('seed')).toBe('from onLoadda'));
		await vi.waitFor(() => expect([viewers.saved, viewers.unsaved]).toEqual([true, 0]), {
			timeout: 5_000
		});
		viewers.destroy();
		viewer.destroy();
		ada.destroy();
		tab.close();
	});

	it('on an empty room, where its document seeds', async () => {
		const room = 'hooked-empty-xw02-viewer';
		const viewer = E.createDocument({ actor: { id: 'viv' } });
		let provider: ReturnType<typeof viewerProvider> | undefined;
		viewer.attachSync(
			Object.assign(
				({ doc, synced }: Parameters<E.EdytorSync>[0]) => {
					const own = viewerProvider(room, doc);
					provider = own;
					own.on('synced', (state) => state && synced(own));
					return () => own.destroy();
				},
				{ bound: Infinity }
			),
			{ value: { children: [{ type: 'paragraph', id: 'p', content: [{ text: 'draft' }] }] } }
		);
		await vi.waitFor(() => expect(viewer.readiness).toBe('local'));
		expect(viewer.facade.blockText('p')).toBe('draft');
		await vi.waitFor(() => expect([provider!.saved, provider!.unsaved]).toEqual([true, 0]), {
			timeout: 5_000
		});
		viewer.destroy();
	});
	it('a viewer that edits nothing hears no permission-denied: not at the join, not at a redial (DR-collab-2)', async () => {
		const room = 'hooked-dr-join-notice';
		const tab = await author(room);
		const viewer = E.createDocument({ actor: { id: 'viv' } });
		const viewers = viewerProvider(room, viewer.doc);
		const denied: string[] = [];
		viewers.on('permission-denied', (reason) => denied.push(reason));
		await vi.waitFor(() => expect([viewers.synced, viewers.readOnly]).toEqual([true, true]));
		viewers.disconnect();
		viewers.connect();
		await vi.waitFor(() => expect(viewers.synced).toBe(true));
		expect({ denied, readOnly: viewers.readOnly, saved: viewers.saved }).toEqual({
			denied: [],
			readOnly: true,
			saved: true
		});
		viewers.destroy();
		viewer.destroy();
		tab.close();
	});
	it('never fails for the denial; granted write on a redial, its edits count until stored', async () => {
		const room = 'hooked-xw02-granted';
		const tab = await author(room);
		const viewer = E.createDocument({ actor: { id: 'viv' } });
		const viewers = viewerProvider(room, viewer.doc);
		const failed: unknown[] = [];
		const denied: string[] = [];
		viewers.on('failed', (error) => failed.push(error));
		viewers.on('permission-denied', (reason) => denied.push(reason));
		await vi.waitFor(() => expect([viewers.synced, viewers.saved]).toEqual([true, true]));
		viewer.transact(() => viewer.facade.insertText('seed', 0, 'viv: '));
		await vi.waitFor(() => expect(denied.length).toBeGreaterThan(0));
		expect([viewers.saved, viewers.unsaved, textOf(tab)]).toEqual([true, 0, 'from onLoad']);

		// The same user is granted edit: the next dial reads the new params.
		viewers.disconnect();
		viewers.params = { user: 'viv' };
		const states: boolean[] = [];
		viewers.on('saved', ({ saved }) => states.push(saved));
		viewers.connect();
		await vi.waitFor(() => expect(textOf(tab)).toBe('viv: from onLoad'));
		await vi.waitFor(() => expect([viewers.saved, viewers.unsaved]).toEqual([true, 0]));
		expect({ states, failed, denied: new Set(denied), readOnly: viewers.readOnly }).toEqual({
			states: [false, true],
			failed: [],
			denied: new Set(['read-only']),
			readOnly: false
		});
		viewers.destroy();
		viewer.destroy();
		tab.close();
	});
});

const hooked = (room: string) => env.HOOKED.getByName(room);
const inHooked = <T>(room: string, fn: (r: HookedRoom, state: DurableObjectState) => T) =>
	runInDurableObject(hooked(room), (r: HookedRoom, state) => fn(r, state));
const clockOf = (doc: E.YDoc) => Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID);

/** The text of block `id` in what the room STORED (its rows, merged). */
const storedText = (room: string, id: string) =>
	inHooked(room, (r) => {
		const stored = crdt.createDoc();
		Y.applyUpdate(stored, storedUpdate(r.records()));
		return readFacade(stored, (f) => f.blockText(id));
	});

describe("XW-07 · a relayer's delete of an author's lost text is kept for the author's return", () => {
	it("Bob deletes Ada's lost '!' and leaves; Ada returns: everyone ends at ''", async () => {
		const room = 'hooked-restore-xw07';
		// Ada's "ada: " is in the room's snapshot; her "!" reaches Bob only.
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
		const bobs = new crdt.providers.WebsocketProvider(url, room, b, {
			params: { user: 'bob' },
			WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
			disableBc: true
		});
		await vi.waitFor(() => expect(bobs.synced).toBe(true));
		ada.transact(() => ada.facade.insertText('seed', 'ada: from onLoad'.length, '!'));
		await vi.waitFor(() =>
			expect(readFacade(b, (f) => f.blockText('seed'))).toBe('ada: from onLoad!')
		);
		bobs.disconnect();
		tabA.close();
		await inHooked(room, async (_r, state) => {
			state.storage.sql.exec('DELETE FROM rows');
			state.storage.sql.exec('DELETE FROM replicas');
			state.storage.sql.exec('DELETE FROM mirror WHERE rowid > ?', snapshot);
			await state.storage.deleteAlarm();
		});
		await evictDurableObject(hooked(room));

		// Offline, Bob deletes the whole text; back online, he is saved and leaves.
		const bob = E.attachDocument(b, { actor: { id: 'bob' } });
		bob.transact(() => bob.facade.deleteText('seed', 0, 'ada: from onLoad!'.length));
		bobs.connect();
		await vi.waitFor(() => expect(bobs.saved).toBe(true), { timeout: 10_000 });
		expect(await storedText(room, 'seed')).toBe('');
		bobs.destroy();
		bob.destroy();
		// Compaction keeps the waiting delete apart from the snapshot.
		const kinds = await inHooked(room, (r) => {
			r.compact();
			return r.records().map((record) => record.kind);
		});
		expect(kinds).toEqual(['generation', 'snapshot', 'pending']);
		await evictDurableObject(hooked(room));

		// Ada returns with her "!", and Carol is there.
		const carol = await RawClient.connect(room, undefined, { user: 'carol' });
		await vi.waitFor(() => expect(carol.synced).toBe(true));
		expect(textOf(carol)).toBe('');
		const back = await RawClient.connect(room, a, { user: 'ada', replica: a.clientID });
		await vi.waitFor(() => expect(back.acks.at(-1)?.get(a.clientID)).toBe(clockOf(a)));
		await vi.waitFor(async () =>
			expect({
				stored: await storedText(room, 'seed'),
				carol: textOf(carol),
				ada: ada.facade.blockText('seed')
			}).toEqual({ stored: '', carol: '', ada: '' })
		);
		// The delete applied: compaction stores no waiting record any more (DR-collab-1).
		const compacted = await inHooked(room, (r) => {
			r.compact();
			return r.records().map((record) => record.kind);
		});
		expect(compacted).toEqual(['generation', 'snapshot']);
		carol.close();
		back.close();
		ada.destroy();
	});
});

/** A delete-only update of `count` separate ranges of `client`'s items. */
const deletesOf = (client: number, count: number) => {
	const body = new Y.UpdateEncoderV1();
	encoding.writeVarUint(body.restEncoder, 0); // no structs
	const deletes = Y.createIdSet();
	for (let i = 0; i < count; i++) deletes.add(client, 2 * i, 1);
	Y.writeIdSet(body, deletes);
	return body.toUint8Array();
};
const rangesOf = (bytes: Uint8Array) => {
	let n = 0;
	for (const ranges of Y.decodeUpdate(bytes).ds.clients.values()) n += ranges.getIds().length;
	return n;
};

describe('DR-collab-1 · waiting deletes are bounded', () => {
	it('a frame that would take them past the cap has them dropped (logged); the rest are stored, and stay bounded', async () => {
		const room = 'dr-waiting-cap';
		const stub = env.ROOM.getByName(room);
		const eve = await RawClient.bare(room, { user: 'eve' });
		const send = (update: Uint8Array) =>
			eve.send(E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, update)));
		send(deletesOf(4242, 3));
		send(deletesOf(4343, MAX_WAITING_DELETES));
		send(deletesOf(4444, 2));
		const state = () =>
			runInDurableObject(stub, (r: DocumentRoom) => ({
				waiting: r.refusalCounts['waiting'] ?? 0,
				kinds: r.records().map((record) => record.kind),
				stored: r
					.records()
					.filter((record) => record.kind === 'pending')
					.reduce((n, record) => n + rangesOf(record.bytes), 0)
			}));
		await vi.waitFor(async () =>
			expect(await state()).toEqual({
				waiting: 1,
				kinds: ['generation', 'pending', 'pending'],
				stored: 5
			})
		);
		expect(eve.closed).toBeNull();
		eve.close();
		await evictDurableObject(stub);
		expect(await state()).toEqual({
			waiting: 0,
			kinds: ['generation', 'pending', 'pending'],
			stored: 5
		});
		// Compaction reclaims them: no user registered those client ids (YW-11).
		await runInDurableObject(stub, (r: DocumentRoom) => r.compact());
		await evictDurableObject(stub);
		expect(await state()).toEqual({ waiting: 0, kinds: ['generation', 'snapshot'], stored: 0 });
	});
});

describe('XW-07 · a stored waiting delete cannot forge the schema stamp', () => {
	it("a delete of the seed's future stamp, sent before the seed, is discarded with it: the room restarts", async () => {
		const room = 'xw07-stamp-predelete';
		const writer = E.createDocument({
			value: { children: [{ type: 'paragraph', id: 'p', content: [{ text: 'hello' }] }] }
		});
		const stamp = (
			writer.doc.get('meta') as unknown as {
				_map: Map<string, { id: { client: number; clock: number } }>;
			}
		)._map.get('v')!.id;
		const eve = await RawClient.bare(room, { user: 'eve' });
		const body = new Y.UpdateEncoderV1();
		encoding.writeVarUint(body.restEncoder, 0); // no structs
		const deletes = Y.createIdSet();
		deletes.add(stamp.client, stamp.clock, 1);
		Y.writeIdSet(body, deletes);
		const predelete = body.toUint8Array();
		eve.send(E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, predelete)));
		const stub = env.ROOM.getByName(room);
		const kinds = () =>
			runInDurableObject(stub, (r: DocumentRoom) => r.records().map((record) => record.kind));
		await vi.waitFor(async () => expect(await kinds()).toEqual(['generation', 'pending']));

		const ada = await RawClient.bare(room, { user: 'ada' });
		const seed = writer.encode();
		ada.send(E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, seed)));
		await vi.waitFor(() => expect(ada.acks.at(-1)?.get(stamp.client)).toBeGreaterThan(stamp.clock));
		eve.close();
		ada.close();
		writer.destroy();
		await evictDurableObject(stub);
		const after = await runInDurableObject(stub, (r: DocumentRoom) => ({
			failure: r.failure?.message ?? null,
			text: shape(r.read()).children[0]?.text,
			kinds: r.records().map((record) => record.kind)
		}));
		expect(after).toEqual({ failure: null, text: 'hello', kinds: ['generation', 'update'] });
	});
});
