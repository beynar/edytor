/**
 * Phase 2, P2 — compaction stores the room's healed live state, never a
 * merge of the records (`docs/research/crdt-fix-plan-2026-10.md`). Rows
 * `room.compact.live`, `room.compact.waiting` and `room.compact.copies` of
 * `docs/editor-delete-contract.md`:
 *
 * - the snapshot is the live document's state without what waits (the
 *   engine's pending structs and deletes), so a reload holds exactly the
 *   live state: same state vector, delete set, encoding and JSON;
 * - structs waiting for a dependency at compaction are stored when it
 *   arrives, and a reload holds them;
 * - the room's document keeps the text a replica may copy again (P11's
 *   `gcFilter`): a deleted restoration copy keeps its content in the
 *   snapshot, as on an editing replica.
 */
import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import type { YDoc } from '../../src/lib/crdt/index.js';
import { E, RawClient, Y, crdt, para, readFacade } from './client';

/** `vi.waitFor` under a loaded pool: the default 1 s is short for a room's round trips. */
const SLOW = { timeout: 10_000, interval: 25 };

const stubOf = (room: string) => env.ROOM.getByName(room);
const inRoom = <T>(room: string, fn: (r: Room, state: DurableObjectState) => T) =>
	runInDurableObject(stubOf(room), (r: Room, state) => fn(r, state));

/** `read` with the engine's pending store set aside (what the room never stores). */
const settled = <T>(doc: YDoc, read: () => T): T => {
	const { store } = doc;
	const held = [store.pendingStructs, store.pendingDs] as const;
	store.pendingStructs = null;
	store.pendingDs = null;
	try {
		return read();
	} finally {
		[store.pendingStructs, store.pendingDs] = held;
	}
};

/** Every deleted struct of `doc`, as `client:clock+length` (its delete set). */
const deleted = (doc: YDoc) => {
	const out: string[] = [];
	for (const [client, structs] of doc.store.clients) {
		for (const struct of structs) {
			if (struct.deleted) out.push(`${client}:${struct.id.clock}+${struct.length}`);
		}
	}
	return out.sort();
};

/** What a stored state must equal: the live doc's (pending set aside). */
const stateOf = (doc: YDoc) =>
	settled(doc, () => ({
		sv: Object.fromEntries(Y.decodeStateVector(Y.encodeStateVector(doc))),
		ds: deleted(doc),
		update: [...Y.encodeStateAsUpdate(doc)],
		json: readFacade(doc, (f) => f.toJSON())
	}));

const live = (room: string) => inRoom(room, (r) => stateOf(r.doc!));

const kinds = (room: string) => inRoom(room, (r) => r.records().map((record) => record.kind));

const author = (text: string, actor: string) =>
	E.createDocument({
		value: { children: [para('p', text)] },
		actor: { id: actor },
		history: { captureTimeout: 0 }
	});

const syncFrame = (update: Uint8Array) =>
	E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, update));

describe('P2 · compaction stores the live state', () => {
	it('a reload after compaction holds exactly the live state, smaller than a merge of the records', async () => {
		const room = 'p2-churn';
		const a = author('', 'ada');
		const sent: Uint8Array<ArrayBuffer>[] = [Y.encodeStateAsUpdate(a.doc)];
		a.doc.on('update', (update: Uint8Array<ArrayBuffer>) => sent.push(update));
		const client = await RawClient.connect(room, a.doc, { user: 'ada', replica: a.doc.clientID });
		await vi.waitFor(() => expect(client.synced).toBe(true), SLOW);
		// Typing, one keystroke per transaction, with a typo erased every tenth key.
		let text = '';
		for (let i = 0; i < 400; i++) {
			const key = String.fromCharCode(97 + (i % 26));
			a.transact(() => a.facade.insertText('p', text.length, key));
			text += key;
			if (i % 10 === 9) {
				a.transact(() => a.facade.deleteText('p', text.length - 1, 1));
				text = text.slice(0, -1);
			}
		}
		await vi.waitFor(
			async () =>
				expect(await inRoom(room, (r) => readFacade(r.doc!, (f) => f.blockText('p')))).toBe(text),
			SLOW
		);
		// What a merge of every record would store (the room's compaction before P2).
		const merged = Y.mergeUpdates(sent).length;
		const snapshot = await inRoom(room, (r) => {
			r.compact();
			return r.records().find((record) => record.kind === 'snapshot')!.bytes.length;
		});
		expect(snapshot * 2).toBeLessThan(merged);
		const before = await live(room);
		expect(before.json.children.map((b) => b.content)).toEqual([[{ text }]]);
		client.close();
		await evictDurableObject(stubOf(room));
		expect(await live(room)).toEqual(before);
		a.destroy();
	});

	it('structs waiting for a dependency at compaction are stored when it arrives; a reload holds them', async () => {
		const room = 'p2-waiting';
		const a = author('x', 'ada');
		const initial = Y.encodeStateAsUpdate(a.doc);
		const updates: Uint8Array[] = [];
		a.doc.on('update', (update: Uint8Array) => updates.push(update));
		a.transact(() => a.facade.insertText('p', 1, 'a'));
		const first = updates.length;
		a.transact(() => a.facade.insertText('p', 2, 'b'));
		const client = await RawClient.bare(room, { user: 'ada', replica: a.doc.clientID });
		client.send(syncFrame(initial));
		// The second edit first: it waits for the first.
		for (const update of updates.slice(first)) client.send(syncFrame(update));
		await vi.waitFor(
			async () =>
				expect(await inRoom(room, (r) => r.doc!.store.pendingStructs !== null)).toBe(true),
			SLOW
		);
		const compacted = await inRoom(room, (r) => {
			r.compact();
			return {
				text: readFacade(r.doc!, (f) => f.blockText('p')),
				waiting: r.doc!.store.pendingStructs !== null
			};
		});
		expect(compacted).toEqual({ text: 'x', waiting: true });
		expect(await kinds(room)).toEqual(['generation', 'snapshot']);
		for (const update of updates.slice(0, first)) client.send(syncFrame(update));
		await vi.waitFor(
			async () =>
				expect(await inRoom(room, (r) => readFacade(r.doc!, (f) => f.blockText('p')))).toBe('xab'),
			SLOW
		);
		const before = await live(room);
		expect(await inRoom(room, (r) => r.doc!.store.pendingStructs)).toBe(null);
		client.close();
		await evictDurableObject(stubOf(room));
		expect(await live(room)).toEqual(before);
		// And once more through a compaction of the released structs.
		await inRoom(room, (r) => r.compact());
		await evictDurableObject(stubOf(room));
		expect(await live(room)).toEqual(before);
		a.destroy();
	});

	it("the room keeps a deleted restoration copy's text, as an editing replica does (P11)", async () => {
		const room = 'p2-copies';
		const a = author('', 'ada');
		const client = await RawClient.connect(room, a.doc, { user: 'ada', replica: a.doc.clientID });
		await vi.waitFor(() => expect(client.synced).toBe(true), SLOW);
		a.transact(() => a.facade.insertText('p', 0, 'hello'));
		a.transact(() => a.facade.deleteText('p', 0, 5));
		a.history.undo(); // restores 'hello' by copying it (P11)
		expect(a.facade.blockText('p')).toBe('hello');
		a.transact(() => a.facade.deleteText('p', 0, 5)); // deletes the copy
		await vi.waitFor(
			async () =>
				expect(await inRoom(room, (r) => Y.encodeStateVector(r.doc!))).toEqual(
					Y.encodeStateVector(a.doc)
				),
			SLOW
		);
		const snapshot = await inRoom(room, (r) => {
			r.compact();
			const { bytes, v2 } = r.records().find((record) => record.kind === 'snapshot')!;
			return v2 ? Y.convertUpdateFormatV2ToV1(bytes) : bytes;
		});
		/** Ids of the characters an update carries with their text. */
		const characters = (update: Uint8Array) =>
			new Set(
				Y.decodeUpdate(update)
					.structs.filter(
						(s): s is InstanceType<typeof Y.Item> =>
							s instanceof Y.Item && typeof (s.content as { str?: unknown }).str === 'string'
					)
					.map((s) => `${s.id.client}:${s.id.clock}+${s.length}`)
			);
		// What a replica keeps (P11's gcFilter), and what plain collection keeps.
		const kept = crdt.createDoc();
		crdt.doc.keepCopies(kept as never);
		Y.applyUpdate(kept, Y.encodeStateAsUpdate(a.doc));
		const plain = crdt.createDoc();
		Y.applyUpdate(plain, Y.encodeStateAsUpdate(a.doc));
		const expected = characters(Y.encodeStateAsUpdate(kept));
		expect(expected.size).toBeGreaterThan(characters(Y.encodeStateAsUpdate(plain)).size);
		expect(characters(snapshot)).toEqual(expected);
		client.close();
		a.destroy();
	});
});
