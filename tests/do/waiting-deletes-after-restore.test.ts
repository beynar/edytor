/**
 * Re-score 4 follow-up (2026-09-30) — the room's waiting deletes after a
 * restore from a lagging snapshot, in workerd:
 *
 * - DR-collab-1: a relayer's delete of a map entry that a stripped rewrite
 *   replaced is dropped even when the room lacks the entry too — storing it
 *   would empty the key when the entry's author returns without the rewrite.
 * - DR-collab-2: a relayer's delete of an author's lost text is stored
 *   when the same frame releases only part of the room's waiting structs.
 * - DR-collab-3: the delete of the entry a relayer's own waiting rewrite
 *   replaces stays in memory with the rewrite, even when other structs
 *   were already waiting.
 * - DR-collab-4: a relayer's edit of a block whose last change was lost
 *   waits (its `lastChangedBy` rewrite builds on it): unsaved until the
 *   author returns, then the room tells the relayer it is stored.
 *
 * Expected values are hand-authored from the edits each test performs.
 */
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
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

const hooked = (room: string) => env.HOOKED.getByName(room);
const inHooked = <T>(room: string, fn: (r: HookedRoom, state: DurableObjectState) => T) =>
	runInDurableObject(hooked(room), (r: HookedRoom, state) => fn(r, state));
const clockOf = (doc: E.YDoc) => Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID);
const blockOf = (doc: E.YDoc) => shape(readFacade(doc, (f) => f.toJSON())).children[0];
/** The room's block, as it reads it. */
const roomBlock = (room: string) => inHooked(room, (r) => shape(r.read()).children[0]);

/** What the room STORED (its rows, merged), as a document. */
const storedBlock = (room: string) =>
	inHooked(room, (r) => {
		const stored = crdt.createDoc();
		Y.applyUpdate(stored, storedUpdate(r.records()));
		return blockOf(stored);
	});

const provider = (room: string, doc: E.YDoc, user: string) =>
	new crdt.providers.WebsocketProvider(`${ORIGIN.replace('https', 'wss')}/rooms`, room, doc, {
		params: { user },
		WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
		disableBc: true
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

/** A frame the room acknowledged after `n` acks. */
const nextAck = (tab: RawClient, n: number) =>
	vi.waitFor(() => expect(tab.acks.length).toBeGreaterThan(n));

describe('DR-collab-1 · a stripped rewrite keeps the entry it replaces, held by the room or not', () => {
	it("Carol's and Ada's retypes are lost; Bob relays both; Carol returns: the block keeps her type", async () => {
		const room = 'hooked-restore-dr1';
		const ada = await writer(room, 'ada', 'a');
		const carol = await writer(room, 'carol', 'c');
		const b = crdt.createDoc();
		const bobs = provider(room, b, 'bob');
		await vi.waitFor(() => expect(bobs.synced).toBe(true));
		const snapshot = await snapshotNow(room);

		carol.edytor.transact(() => carol.edytor.facade.setBlockType('seed', 'heading'));
		await vi.waitFor(() =>
			expect([blockOf(ada.doc).type, blockOf(b).type]).toEqual(['heading', 'heading'])
		);
		carol.tab.close();
		ada.edytor.transact(() => ada.edytor.facade.setBlockType('seed', 'quote'));
		await vi.waitFor(() => expect(blockOf(b).type).toBe('quote'));
		bobs.disconnect();
		ada.tab.close();
		await restoreFrom(room, snapshot);

		bobs.connect();
		await vi.waitFor(() => expect([bobs.synced, bobs.saved]).toEqual([true, true]), {
			timeout: 10_000
		});
		expect((await roomBlock(room)).type).toBe('paragraph');
		bobs.destroy();

		const carolBack = await RawClient.connect(room, carol.doc, {
			user: 'carol',
			replica: carol.doc.clientID
		});
		await vi.waitFor(() =>
			expect(carolBack.acks.at(-1)?.get(carol.doc.clientID)).toBe(clockOf(carol.doc))
		);
		expect([(await roomBlock(room)).type, (await storedBlock(room)).type]).toEqual([
			'heading',
			'heading'
		]);

		// Ada returns: her later retype wins.
		const adaBack = await RawClient.connect(room, ada.doc, {
			user: 'ada',
			replica: ada.doc.clientID
		});
		await vi.waitFor(() =>
			expect(adaBack.acks.at(-1)?.get(ada.doc.clientID)).toBe(clockOf(ada.doc))
		);
		expect([(await roomBlock(room)).type, blockOf(carolBack.doc).type]).toEqual(['quote', 'quote']);
		carolBack.close();
		adaBack.close();
		ada.edytor.destroy();
		carol.edytor.destroy();
	});
});

describe("DR-collab-2 · a relayer's waiting delete is stored when its frame releases part of the waiting structs", () => {
	it("Bob deletes Ada's lost '!' while Carol's 'x' waits on his lost 'B': the '!' stays deleted", async () => {
		const room = 'hooked-restore-dr2';
		const ada = await writer(room, 'ada', 'a');
		const carol = await writer(room, 'carol', 'c');
		const b = crdt.createDoc();
		const bobs = provider(room, b, 'bob');
		await vi.waitFor(() => expect(bobs.synced).toBe(true));
		const bob = E.attachDocument(b, { actor: { id: 'bob' } });
		bob.transact(() => bob.facade.insertText('seed', 0, 'b'));
		await vi.waitFor(() => expect([bobs.saved, bobs.unsaved]).toEqual([true, 0]));
		const snapshot = await snapshotNow(room);
		const base = 'bcafrom onLoad';

		bob.transact(() => bob.facade.insertText('seed', base.length, 'B'));
		await vi.waitFor(() => expect(blockOf(ada.doc).text).toBe(`${base}B`));
		// Through a bare facade (no attribution): Bob's own `lastChangedBy`
		// rewrite must not wait on a lost one of Ada's (DR-collab-3 covers that).
		readFacade(ada.doc, (f) => f.insertText('seed', base.length + 1, '!'));
		await vi.waitFor(() =>
			expect([blockOf(b).text, blockOf(carol.doc).text]).toEqual([`${base}B!`, `${base}B!`])
		);
		bobs.disconnect();
		ada.tab.close();
		carol.tab.close();
		await restoreFrom(room, snapshot);

		// Carol returns and types between Bob's "B" and Ada's "!": it waits.
		const carolBack = await RawClient.connect(room, carol.doc, {
			user: 'carol',
			replica: carol.doc.clientID
		});
		await vi.waitFor(() => expect(carolBack.synced).toBe(true));
		const n = carolBack.acks.length;
		carol.edytor.transact(() => carol.edytor.facade.insertText('seed', base.length + 1, 'x'));
		await nextAck(carolBack, n);
		carolBack.close();

		// Offline, Bob deletes Ada's "!"; back online, he is saved and leaves.
		bob.transact(() => bob.facade.deleteText('seed', base.length + 1, 1));
		bobs.connect();
		await vi.waitFor(() => expect([bobs.saved, bobs.unsaved]).toEqual([true, 0]), {
			timeout: 10_000
		});
		bobs.destroy();
		bob.destroy();
		await evictDurableObject(hooked(room));

		// Ada returns with her "!", then Carol with her "x".
		const adaBack = await RawClient.connect(room, ada.doc, {
			user: 'ada',
			replica: ada.doc.clientID
		});
		await vi.waitFor(() =>
			expect(adaBack.acks.at(-1)?.get(ada.doc.clientID)).toBe(clockOf(ada.doc))
		);
		const carolAgain = await RawClient.connect(room, carol.doc, {
			user: 'carol',
			replica: carol.doc.clientID
		});
		await vi.waitFor(() =>
			expect(carolAgain.acks.at(-1)?.get(carol.doc.clientID)).toBe(clockOf(carol.doc))
		);
		await vi.waitFor(async () =>
			expect({
				stored: (await storedBlock(room)).text,
				ada: blockOf(ada.doc).text,
				carol: blockOf(carol.doc).text
			}).toEqual({ stored: `${base}Bx`, ada: `${base}Bx`, carol: `${base}Bx` })
		);
		adaBack.close();
		carolAgain.close();
		ada.edytor.destroy();
		carol.edytor.destroy();
	});
});

describe("DR-collab-3 · a relayer's waiting rewrite keeps the delete of the entry it replaces in memory", () => {
	it("Bob retypes over Ada's lost retype while Carol's 'x' waits: Ada returns, the block keeps her type", async () => {
		const room = 'hooked-restore-dr3';
		const ada = await writer(room, 'ada', 'a');
		const carol = await writer(room, 'carol', 'c');
		const bob = await writer(room, 'bob', 'b');
		const snapshot = await snapshotNow(room);
		const base = 'bcafrom onLoad';

		ada.edytor.transact(() => {
			ada.edytor.facade.insertText('seed', base.length, '!');
			ada.edytor.facade.setBlockType('seed', 'heading');
		});
		await vi.waitFor(() =>
			expect([blockOf(bob.doc), blockOf(carol.doc)]).toEqual([
				{ id: 'seed', type: 'heading', text: `${base}!` },
				{ id: 'seed', type: 'heading', text: `${base}!` }
			])
		);
		ada.tab.close();
		bob.tab.close();
		carol.tab.close();
		await restoreFrom(room, snapshot);

		// Carol returns and types after Ada's lost "!": it waits.
		const carolBack = await RawClient.connect(room, carol.doc, {
			user: 'carol',
			replica: carol.doc.clientID
		});
		await vi.waitFor(() => expect(carolBack.synced).toBe(true));
		const n = carolBack.acks.length;
		carol.edytor.transact(() => carol.edytor.facade.insertText('seed', base.length + 1, 'x'));
		await nextAck(carolBack, n);

		// Bob returns and retypes over Ada's lost retype: his rewrite waits too.
		const bobBack = await RawClient.connect(room, bob.doc, {
			user: 'bob',
			replica: bob.doc.clientID
		});
		await vi.waitFor(() => expect(bobBack.synced).toBe(true));
		const m = bobBack.acks.length;
		bob.edytor.transact(() => bob.edytor.facade.setBlockType('seed', 'quote'));
		await nextAck(bobBack, m);
		expect((await roomBlock(room)).type).toBe('paragraph');
		bobBack.close();
		carolBack.close();
		await evictDurableObject(hooked(room));

		// Ada returns: her retype is not deleted (Bob's, which replaces it, never reached the store).
		const adaBack = await RawClient.connect(room, ada.doc, {
			user: 'ada',
			replica: ada.doc.clientID
		});
		await vi.waitFor(() =>
			expect(adaBack.acks.at(-1)?.get(ada.doc.clientID)).toBe(clockOf(ada.doc))
		);
		expect([await roomBlock(room), await storedBlock(room)]).toEqual([
			{ id: 'seed', type: 'heading', text: `${base}!` },
			{ id: 'seed', type: 'heading', text: `${base}!` }
		]);
		adaBack.close();
		ada.edytor.destroy();
		bob.edytor.destroy();
		carol.edytor.destroy();
	});
});

describe("DR-collab-4 · a relayer's edit of a block whose last change was lost", () => {
	it('stays unsaved until the author returns, then is saved', async () => {
		const room = 'hooked-restore-dr4';
		const ada = await writer(room, 'ada', 'a');
		const b = crdt.createDoc();
		const bobs = provider(room, b, 'bob');
		await vi.waitFor(() => expect(bobs.synced).toBe(true));
		const bob = E.attachDocument(b, { actor: { id: 'bob' } });
		bob.transact(() => bob.facade.insertText('seed', 0, 'b'));
		await vi.waitFor(() => expect([bobs.saved, bobs.unsaved]).toEqual([true, 0]));
		const snapshot = await snapshotNow(room);

		ada.edytor.transact(() => ada.edytor.facade.insertText('seed', 'bafrom onLoad'.length, '!'));
		await vi.waitFor(() => expect(blockOf(b).text).toBe('bafrom onLoad!'));
		bobs.disconnect();
		ada.tab.close();
		await restoreFrom(room, snapshot);

		bob.transact(() => bob.facade.insertText('seed', 0, 'B'));
		bobs.connect();
		await vi.waitFor(async () => expect((await roomBlock(room)).text).toBe('Bbafrom onLoad'));
		expect(bobs.saved).toBe(false);

		const adaBack = await RawClient.connect(room, ada.doc, {
			user: 'ada',
			replica: ada.doc.clientID
		});
		await vi.waitFor(() =>
			expect(adaBack.acks.at(-1)?.get(ada.doc.clientID)).toBe(clockOf(ada.doc))
		);
		await vi.waitFor(() => expect([bobs.saved, bobs.unsaved]).toEqual([true, 0]));
		expect((await storedBlock(room)).text).toBe('Bbafrom onLoad!');
		adaBack.close();
		bobs.destroy();
		bob.destroy();
		ada.edytor.destroy();
	});
});
