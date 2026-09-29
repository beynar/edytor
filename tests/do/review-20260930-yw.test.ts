/**
 * Re-score 5 (2026-09-30) — the room's and the provider's units, in workerd:
 *
 * - YW-01: a relayer's rewrite that waits on an author's lost entry, then a
 *   later edit of the same client that the room stores past it: resent at
 *   a redial, the rewrite's delete of the entry it replaces still waits
 *   with it in memory, never stored — the author returns to her type.
 * - YW-05: a room id holding `/`, `%`, `#` or `?` reaches its own room
 *   through the quick-start route (the provider encodes it, the Worker
 *   decodes it).
 * - YW-09: two read-only tabs on the cross-tab channel hear no
 *   permission-denied: a tab never relays what it heard to a socket the
 *   room made read-only.
 * - YW-10: a relayer's delete the full waiting-delete cap drops stays
 *   unsaved (the room acknowledges a waiting delete by id only once it
 *   stored it); YW-11: compaction reclaims the waiting deletes of client
 *   ids nobody registered, so the resent delete is stored and saved.
 * - SW8-sync-1: a registry `onLoad` returns later never makes a dialed
 *   owner's id claimable (an unowned row never replaces an owner).
 * - DR-sync-1: waiting deletes restored from the `onSave` mirror are stored
 *   apart again: compaction reclaims made-up ids', and a resend is
 *   acknowledged. DR-sync-2: a stored waiting delete arms `onSave`.
 *   DR-sync-3: deletes of a registered id's items survive compaction until
 *   `dropWaitingDeletes()`.
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
	REPLICA_TAKEN,
	RawClient,
	SelfWebSocket,
	Y,
	crdt,
	dialOutcome,
	para,
	readFacade,
	shape
} from './client';

const url = `${ORIGIN.replace('https', 'wss')}/rooms`;
const hooked = (room: string) => env.HOOKED.getByName(room);
const inHooked = <T>(room: string, fn: (r: HookedRoom, state: DurableObjectState) => T) =>
	runInDurableObject(hooked(room), (r: HookedRoom, state) => fn(r, state));
const clockOf = (doc: E.YDoc) => Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID);
const blockOf = (doc: E.YDoc) => shape(readFacade(doc, (f) => f.toJSON())).children[0];
const roomBlock = (room: string) => inHooked(room, (r) => shape(r.read()).children[0]);
const kinds = (room: string) => inHooked(room, (r) => r.records().map((record) => record.kind));

/** What the room STORED (its rows, merged), as a document. */
const storedBlock = (room: string) =>
	inHooked(room, (r) => {
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
		return blockOf(stored);
	});

/** `user` on a raw socket, having typed `mark` at 0 (acknowledged). */
const writer = async (room: string, user: string, mark: string, doc = crdt.createDoc()) => {
	const tab = await RawClient.connect(room, doc, { user, replica: doc.clientID });
	await vi.waitFor(() => expect(tab.synced).toBe(true));
	const edytor = E.attachDocument(doc, { actor: { id: user } });
	edytor.transact(() => edytor.facade.insertText('seed', 0, mark));
	await vi.waitFor(() => expect(tab.acks.at(-1)?.get(doc.clientID)).toBe(clockOf(doc)));
	return { tab, edytor, doc };
};

/** `doc` back on a raw socket as `user`, once the room acknowledged every frame of its handshake. */
const redial = async (room: string, doc: E.YDoc, user: string) => {
	const tab = await RawClient.connect(room, doc, { user, replica: doc.clientID });
	await vi.waitFor(() => expect([tab.synced, tab.step1s > 0]).toEqual([true, true]));
	// Frames are handled in order: the ack of one more Step1 follows every earlier one.
	const n = tab.acks.length;
	tab.send(E.frame(E.messageSync, (e) => crdt.sync.writeSyncStep1(e, doc)));
	await vi.waitFor(() => expect(tab.acks.length).toBeGreaterThan(n));
	return tab;
};

/** Mirror the room now (`onSave`); returns the snapshot's mirror row. */
const snapshotNow = async (room: string) => {
	expect(await runDurableObjectAlarm(hooked(room))).toBe(true);
	return inHooked(
		room,
		(_r, state) =>
			state.storage.sql.exec<{ id: number }>('SELECT MAX(rowid) AS id FROM mirror').one().id
	);
};

/** Lose everything after `snapshot`: the room restarts from that mirror. */
const restoreFrom = async (room: string, snapshot: number) => {
	await inHooked(room, async (_r, state) => {
		state.storage.sql.exec('DELETE FROM rows');
		state.storage.sql.exec('DELETE FROM replicas');
		state.storage.sql.exec('DELETE FROM mirror WHERE rowid > ?', snapshot);
		await state.storage.deleteAlarm();
	});
	await evictDurableObject(hooked(room));
};

describe('YW-01 · a resent waiting rewrite keeps the delete of the entry it replaces in memory', () => {
	it("Bob retypes over Ada's lost retype, types on, and resends both after an eviction: Ada returns to her type", async () => {
		const room = 'hooked-restore-yw01';
		const ada = await writer(room, 'ada', 'a');
		const bob = await writer(room, 'bob', 'b');
		const snapshot = await snapshotNow(room);
		const base = 'bafrom onLoad';

		ada.edytor.transact(() => ada.edytor.facade.setBlockType('seed', 'heading'));
		await vi.waitFor(() => expect(blockOf(bob.doc).type).toBe('heading'));
		ada.tab.close();
		bob.tab.close();
		await restoreFrom(room, snapshot);

		// Bob returns and retypes over Ada's lost retype: his rewrite waits.
		// Then he types: that edit is stored past the waiting one.
		const bobBack = await redial(room, bob.doc, 'bob');
		bob.edytor.transact(() => bob.edytor.facade.setBlockType('seed', 'quote'));
		bob.edytor.transact(() => bob.edytor.facade.insertText('seed', 0, 'B'));
		await vi.waitFor(async () =>
			expect(await roomBlock(room)).toEqual({ id: 'seed', type: 'paragraph', text: `B${base}` })
		);
		bobBack.close();
		await evictDurableObject(hooked(room));

		// Bob redials: his handshake resends the waiting rewrite.
		(await redial(room, bob.doc, 'bob')).close();
		expect(await kinds(room)).not.toContain('pending');
		await evictDurableObject(hooked(room));

		// Ada returns: her retype is not deleted (Bob's, which replaces it, never reached the store).
		const adaBack = await RawClient.connect(room, ada.doc, {
			user: 'ada',
			replica: ada.doc.clientID
		});
		await vi.waitFor(() =>
			expect(adaBack.acks.at(-1)?.get(ada.doc.clientID)).toBe(clockOf(ada.doc))
		);
		const heading = { id: 'seed', type: 'heading', text: `B${base}` };
		expect([await roomBlock(room), await storedBlock(room), blockOf(ada.doc)]).toEqual([
			heading,
			heading,
			heading
		]);

		// Bob returns: his later retype lands, for everyone.
		const bobLast = await redial(room, bob.doc, 'bob');
		await vi.waitFor(async () =>
			expect([
				(await roomBlock(room)).type,
				(await storedBlock(room)).type,
				blockOf(ada.doc).type,
				blockOf(bob.doc).type
			]).toEqual(['quote', 'quote', 'quote', 'quote'])
		);
		bobLast.close();
		adaBack.close();
		ada.edytor.destroy();
		bob.edytor.destroy();
	});
});

describe('YW-05 · a room id reaches its own room, whatever it holds', () => {
	it.each(['a/b', '100% done', 'notes#2', 'a?b'])('%s', async (id) => {
		const document = E.createDocument({ value: { children: [para('p', `in ${id}`)] } });
		const provider = new crdt.providers.WebsocketProvider(url, id, document.doc, {
			params: { user: 'ada' },
			WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
			disableBc: true
		});
		await vi.waitFor(() => expect([provider.synced, provider.saved]).toEqual([true, true]), {
			timeout: 5_000
		});
		const text = await runInDurableObject(env.ROOM.getByName(id), (r: DocumentRoom) =>
			readFacade(r.doc!, (f) => f.blockText('p'))
		);
		expect(text).toBe(`in ${id}`);
		provider.destroy();
		document.destroy();
	});

	it('a path segment that does not decode (no provider sends one) is closed 4400, never a 500', async () => {
		const response = await SelfWebSocket.fetcher(`${ORIGIN}/rooms/100%`, {
			headers: { Upgrade: 'websocket' }
		});
		const ws = response.webSocket!;
		ws.accept();
		const closed = await new Promise((resolve) =>
			ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }))
		);
		expect(closed).toEqual({ code: 4400, reason: 'invalid document id' });
	});
});

describe('YW-09 · read-only tabs on the channel', () => {
	it('two tabs of a viewer hear no permission-denied: nothing heard from a tab goes to a read-only socket', async () => {
		const room = 'hooked-yw09-tabs';
		const author = await RawClient.connect(room, undefined, { user: 'ada' });
		await vi.waitFor(() => expect(author.synced).toBe(true));
		const viewer = (doc: E.YDoc) =>
			new crdt.providers.WebsocketProvider(url, room, doc, {
				params: { user: 'viv', access: 'read' },
				WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
				disableBc: false
			});
		const denied: string[] = [];
		const one = E.createDocument({ actor: { id: 'viv' } });
		const first = viewer(one.doc);
		first.on('permission-denied', (reason) => denied.push(`one: ${reason}`));
		await vi.waitFor(() => expect([first.synced, first.readOnly]).toEqual([true, true]));
		const two = E.createDocument({ actor: { id: 'viv' } });
		const second = viewer(two.doc);
		second.on('permission-denied', (reason) => denied.push(`two: ${reason}`));
		await vi.waitFor(() => expect([second.synced, second.readOnly]).toEqual([true, true]));
		// Each tab heard the other's actor record over the channel.
		await vi.waitFor(() =>
			expect([
				one.doc.store.clients.has(two.doc.clientID),
				two.doc.store.clients.has(one.doc.clientID)
			]).toEqual([true, true])
		);
		// A round trip on each socket: any denial is heard by now.
		for (const provider of [first, second]) {
			provider.disconnect();
			provider.connect();
			await vi.waitFor(() => expect(provider.synced).toBe(true));
		}
		const reasons = await inHooked(room, (r) => r.refusals.map((refusal) => refusal.reason));
		expect({ denied, reasons, saved: [first.saved, second.saved] }).toEqual({
			denied: [],
			reasons: [],
			saved: [true, true]
		});
		first.destroy();
		second.destroy();
		one.destroy();
		two.destroy();
		author.close();
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
const syncUpdate = (update: Uint8Array) =>
	E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, update));

describe('YW-10 / YW-11 · a delete the waiting cap drops', () => {
	it("stays unsaved; compaction reclaims made-up clients' waiting deletes, and the resent delete is stored", async () => {
		const room = 'hooked-restore-yw10';
		// Ada's "ada: " is in the room's snapshot; her "!" reaches Bob only.
		const a = crdt.createDoc();
		const tabA = await RawClient.connect(room, a, { user: 'ada', replica: a.clientID });
		await vi.waitFor(() => expect(tabA.synced).toBe(true));
		const ada = E.attachDocument(a, { actor: { id: 'ada' } });
		ada.transact(() => ada.facade.insertText('seed', 0, 'ada: '));
		await vi.waitFor(() => expect(tabA.acks.at(-1)?.get(a.clientID)).toBe(clockOf(a)));
		const snapshot = await snapshotNow(room);
		const b = crdt.createDoc();
		const bobs = new crdt.providers.WebsocketProvider(url, room, b, {
			params: { user: 'bob' },
			WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
			disableBc: true
		});
		await vi.waitFor(() => expect(bobs.synced).toBe(true));
		ada.transact(() => ada.facade.insertText('seed', 'ada: from onLoad'.length, '!'));
		await vi.waitFor(() => expect(blockOf(b).text).toBe('ada: from onLoad!'));
		bobs.disconnect();
		tabA.close();
		await restoreFrom(room, snapshot);

		// Eve fills the cap with deletes of made-up clients' items.
		const eve = await RawClient.bare(room, { user: 'eve' });
		eve.send(syncUpdate(deletesOf(4343, MAX_WAITING_DELETES)));
		await vi.waitFor(async () =>
			expect(await kinds(room)).toEqual(['generation', 'snapshot', 'pending'])
		);
		eve.close();

		// Offline, Bob deletes Ada's lost "!"; back online, the room drops that delete.
		const bob = E.attachDocument(b, { actor: { id: 'bob' } });
		bob.transact(() => bob.facade.deleteText('seed', 'ada: from onLoad'.length, 1));
		const saves: boolean[] = [];
		bobs.on('saved', ({ saved }) => saves.push(saved));
		bobs.connect();
		await vi.waitFor(() => expect(bobs.synced).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(await inHooked(room, (r) => r.refusalCounts['waiting'] ?? 0)).toBeGreaterThan(0);
		expect({ saves, saved: bobs.saved, unsaved: bobs.unsaved }).toEqual({
			saves: [],
			saved: false,
			unsaved: 1
		});

		// Compaction reclaims what waits for ids nobody registered; Bob's resend is stored.
		expect(
			await inHooked(room, (r) => {
				r.compact();
				return r.records().map((record) => record.kind);
			})
		).toEqual(['generation', 'snapshot']);
		bobs.disconnect();
		bobs.connect();
		await vi.waitFor(() => expect([bobs.saved, bobs.unsaved]).toEqual([true, 0]), {
			timeout: 5_000
		});
		expect(await kinds(room)).toContain('pending');
		bobs.destroy();
		bob.destroy();
		await evictDurableObject(hooked(room));

		// Ada returns with her "!": it arrives deleted.
		const back = await RawClient.connect(room, a, { user: 'ada', replica: a.clientID });
		await vi.waitFor(() => expect(back.acks.at(-1)?.get(a.clientID)).toBe(clockOf(a)));
		await vi.waitFor(async () =>
			expect({
				room: (await roomBlock(room)).text,
				stored: (await storedBlock(room)).text,
				ada: ada.facade.blockText('seed')
			}).toEqual({ room: 'ada: from onLoad', stored: 'ada: from onLoad', ada: 'ada: from onLoad' })
		);
		back.close();
		ada.destroy();
	});
});

describe('SW8-sync-1 · a registry onLoad returns later', () => {
	it("keeps the owner a dial registered while the room stayed fresh: the id's unowned row does not replace it", async () => {
		const room = 'hooked-late-sw8';
		const replica = 7777;
		expect(await dialOutcome(room, { user: 'ada', replica })).toBe('open');
		await evictDurableObject(hooked(room));
		// This start seeds the document and a registry naming the id unowned.
		expect(await dialOutcome(room, { user: 'mallory', replica })).toEqual(REPLICA_TAKEN);
		expect(await dialOutcome(room, { user: 'ada', replica })).toBe('open');
	});
});

describe('DR-sync-1 · waiting deletes a restore from the onSave mirror brings back', () => {
	it("are stored apart from the snapshot: compaction reclaims made-up ids', and a later delete still waits", async () => {
		const room = 'hooked-restore-drs1';
		const ada = await writer(room, 'ada', 'a');
		const eve = await RawClient.bare(room, { user: 'eve' });
		eve.send(syncUpdate(deletesOf(4343, MAX_WAITING_DELETES)));
		await vi.waitFor(() => expect(eve.ackedDeletes).toContain(MAX_WAITING_DELETES));
		eve.close();
		ada.tab.close();
		await restoreFrom(room, await snapshotNow(room));

		expect(await kinds(room)).toEqual(['generation', 'snapshot', 'pending']);
		expect(
			await inHooked(room, (r) => {
				r.compact();
				return { kinds: r.records().map((record) => record.kind), engine: r.doc!.store.pendingDs };
			})
		).toEqual({ kinds: ['generation', 'snapshot'], engine: null });
		const bob = await RawClient.bare(room, { user: 'bob' });
		bob.send(syncUpdate(deletesOf(4545, 1)));
		await vi.waitFor(() => expect(bob.ackedDeletes).toContain(1));
		expect(await inHooked(room, (r) => r.refusalCounts['waiting'] ?? 0)).toBe(0);
		bob.close();
		ada.edytor.destroy();
	});

	it('a resent delete the restore stored is named in its acknowledgement', async () => {
		const room = 'hooked-restore-drs2';
		const ada = await writer(room, 'ada', 'a');
		const bob = await RawClient.bare(room, { user: 'bob' });
		bob.send(syncUpdate(deletesOf(4343, 2)));
		await vi.waitFor(() => expect(bob.ackedDeletes).toContain(2));
		bob.close();
		ada.tab.close();
		await restoreFrom(room, await snapshotNow(room));

		const back = await RawClient.bare(room, { user: 'bob' });
		back.send(syncUpdate(deletesOf(4343, 2)));
		await vi.waitFor(() => expect(back.ackedDeletes).toContain(2));
		back.close();
		ada.edytor.destroy();
	});
});

describe('DR-sync-2 · a stored waiting delete arms the save', () => {
	it('with no other edit, the mirror still gets it: a restore keeps it waiting', async () => {
		const room = 'hooked-restore-drs3';
		const bob = await RawClient.bare(room, { user: 'bob' });
		bob.send(syncUpdate(deletesOf(4343, 2)));
		await vi.waitFor(() => expect(bob.ackedDeletes).toContain(2));
		bob.close();
		await restoreFrom(room, await snapshotNow(room));

		expect(await kinds(room)).toEqual(['generation', 'snapshot', 'pending']);
	});
});

describe("DR-sync-3 · deletes of a registered id's items the room lacks", () => {
	it('fill the waiting limit past compaction, until the host drops the waiting deletes', async () => {
		const room = 'hooked-drs3-own';
		const eve = await RawClient.bare(room, { user: 'eve', replica: 9191 });
		eve.send(syncUpdate(deletesOf(9191, MAX_WAITING_DELETES)));
		await vi.waitFor(() => expect(eve.ackedDeletes).toContain(MAX_WAITING_DELETES));
		eve.close();
		expect(
			await inHooked(room, (r) => {
				r.compact();
				return r.records().map((record) => record.kind);
			})
		).toEqual(['generation', 'snapshot', 'pending']);
		const bob = await RawClient.bare(room, { user: 'bob' });
		bob.send(syncUpdate(deletesOf(4545, 1)));
		await vi.waitFor(async () =>
			expect(await inHooked(room, (r) => r.refusalCounts['waiting'] ?? 0)).toBe(1)
		);

		expect(
			await inHooked(room, (r) => ({
				dropped: r.dropWaitingDeletes(),
				kinds: r.records().map((record) => record.kind),
				engine: r.doc!.store.pendingDs
			}))
		).toEqual({
			dropped: { ranges: MAX_WAITING_DELETES },
			kinds: ['generation', 'snapshot'],
			engine: null
		});
		bob.send(syncUpdate(deletesOf(4545, 1)));
		await vi.waitFor(() => expect(bob.ackedDeletes).toContain(1));
		bob.close();
		await evictDurableObject(hooked(room));
		expect(await kinds(room)).toEqual(['generation', 'snapshot', 'pending']);
	});
});
