/**
 * Phase 2, H2 — the room validates what clients write
 * (`docs/editor-delete-contract.md`, rows `room.marks.writer`,
 * `room.validate.inverse`, `room.validate.bootstrap`):
 *
 * - only client `n` writes or deletes a per-writer block mark `del.<n>` /
 *   `wd.<n>`: a client writing another's is stripped whole (logged
 *   `mark`), a delete of another's mark is dropped, the rest applies;
 * - `validate` (here per-block locks, `LockedRoom` in `worker.ts`) is
 *   asked after each frame that changed blocks; a denial is compensated by
 *   the room's own transaction, the history undo of that frame, which
 *   every replica receives: the sender stays connected and everyone
 *   converges;
 * - a denied frame that initialized the document has its blocks deleted.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import type { JSONDoc } from '../../src/lib/crdt/index.js';
import type { LockedRoom } from './worker';
import { E, RawClient, Y, para, readFacade } from './client';

/** `vi.waitFor` under a loaded pool: the default 1 s is short for a room's round trips. */
const SLOW = { timeout: 10_000, interval: 25 };

declare global {
	namespace Cloudflare {
		interface Env {
			LOCKED: DurableObjectNamespace<LockedRoom>;
		}
	}
}

type Document = ReturnType<typeof E.createDocument>;

const roomOf = (room: string) =>
	room.startsWith('locked-') ? env.LOCKED.getByName(room) : env.ROOM.getByName(room);
const inRoom = <T>(room: string, fn: (r: Room) => T) =>
	runInDurableObject(roomOf(room) as DurableObjectStub<Room>, (r: Room) => fn(r));
const roomJSON = (room: string) => inRoom(room, (r) => readFacade(r.doc!, (f) => f.toJSON()));
const reasons = (room: string, reason: string) =>
	inRoom(room, (r) => r.refusals.filter((x) => x.reason === reason).map((x) => x.detail));

/** A user's document, dialed into `room` and synced. */
const join = async (room: string, user: string, value?: JSONDoc) => {
	const document = E.createDocument({ value, actor: { id: user } });
	const client = await RawClient.connect(room, document.doc, {
		user,
		replica: document.doc.clientID
	});
	await vi.waitFor(() => expect(client.synced).toBe(true), SLOW);
	return { document, client };
};

/** Every replica holds the room's state (and the room's JSON). */
const converged = async (room: string, ...documents: Document[]) => {
	const sv = await inRoom(room, (r) => Y.encodeStateVector(r.doc!));
	for (const document of documents) {
		await vi.waitFor(
			async () =>
				expect(Y.encodeStateVector(document.doc)).toEqual(
					await inRoom(room, (r) => Y.encodeStateVector(r.doc!))
				),
			SLOW
		);
	}
	const json = await roomJSON(room);
	for (const document of documents) expect(document.facade.toJSON()).toEqual(json);
	return { sv, json };
};

const node = (document: Document, id: string) =>
	document.doc.get('blocks').getAttr(id) as {
		setAttr(k: string, v: unknown): void;
		deleteAttr(k: string): void;
		getAttr(k: string): unknown;
	};

describe('H2 · per-writer block marks are written and deleted by their writer only', () => {
	it("a client writing another's delete mark is stripped; one deleting another's mark has the delete dropped", async () => {
		const room = 'h2-marks';
		const ada = await join(room, 'ada', { children: [para('p', 'hello'), para('q', 'world')] });
		const eve = await join(room, 'eve');
		const adaId = ada.document.doc.clientID;

		// Eve forges Ada's delete mark on `p` (her struct under the key `del.<ada>`).
		eve.document.doc.transact(() => node(eve.document, 'p').setAttr(`del.${adaId}`, true));
		await vi.waitFor(async () => expect(await reasons(room, 'mark')).toHaveLength(1), SLOW);
		expect((await roomJSON(room)).children.map((b) => b.id)).toEqual(['p', 'q']);
		expect(await reasons(room, 'mark')).toEqual([
			{ user: 'eve', writers: [eve.document.doc.clientID], ranges: 0 }
		]);

		// Ada deletes `q` (her own mark); a fresh Eve deletes Ada's mark: dropped.
		ada.document.transact(() => ada.document.facade.deleteBlock('q'));
		await vi.waitFor(
			async () => expect((await roomJSON(room)).children.map((b) => b.id)).toEqual(['p']),
			SLOW
		);
		const mallory = await join(room, 'mallory');
		expect(node(mallory.document, 'q').getAttr(`del.${adaId}`)).toBe(true);
		mallory.document.doc.transact(() => node(mallory.document, 'q').deleteAttr(`del.${adaId}`));
		await vi.waitFor(async () => expect(await reasons(room, 'mark')).toHaveLength(2), SLOW);
		expect((await reasons(room, 'mark'))[1]).toEqual({ user: 'mallory', writers: [], ranges: 1 });
		expect((await roomJSON(room)).children.map((b) => b.id)).toEqual(['p']);
		// The room still holds Ada's mark, and Ada's replica converges with it.
		expect(
			await inRoom(room, (r) =>
				(r.doc!.get('blocks').getAttr('q') as { getAttr(k: string): unknown }).getAttr(
					`del.${adaId}`
				)
			)
		).toBe(true);
		// Her own marks are hers to write: Mallory deletes `p`, then undoes nothing forged.
		mallory.document.transact(() => mallory.document.facade.deleteBlock('p'));
		await vi.waitFor(async () => expect((await roomJSON(room)).children).toEqual([]), SLOW);
		expect(await reasons(room, 'mark')).toHaveLength(2);
		for (const peer of [ada, eve, mallory]) peer.client.close();
		for (const peer of [ada, eve, mallory]) peer.document.destroy();
	});
});

describe('H2 · validate: accept, then compensate (per-block locks)', () => {
	it('a denied frame is undone by the room; every replica converges; the sender stays', async () => {
		const room = 'locked-converge';
		const ada = await join(room, 'ada', {
			children: [para('p', 'locked text'), para('q', 'free text')]
		});
		const bob = await join(room, 'bob');
		// Ada locks `p`: allowed (it was nobody's).
		ada.document.transact(() => ada.document.facade.setBlockData('p', { lockedBy: 'ada' }));
		await vi.waitFor(
			async () => expect((await roomJSON(room)).children[0].data).toEqual({ lockedBy: 'ada' }),
			SLOW
		);
		await converged(room, ada.document, bob.document);

		// Bob types into the locked block: stored, denied, undone everywhere.
		bob.document.transact(() => bob.document.facade.insertText('p', 0, 'BOB '));
		await vi.waitFor(async () => expect(await reasons(room, 'denied')).toHaveLength(1), SLOW);
		const { json } = await converged(room, ada.document, bob.document);
		expect(json.children.map((b) => b.content)).toEqual([
			[{ text: 'locked text' }],
			[{ text: 'free text' }]
		]);
		expect(await reasons(room, 'denied')).toEqual([{ user: 'bob', touched: ['p'] }]);
		expect(bob.client.closed).toBe(null);

		// Bob's edit of the free block, and a block he adds before `p`, apply.
		bob.document.transact(() => bob.document.facade.insertText('q', 0, 'bob: '));
		bob.document.transact(() =>
			bob.document.facade.insertBlock({ parent: null, index: 0 }, { id: 'b', type: 'paragraph' })
		);
		await vi.waitFor(
			async () => expect((await roomJSON(room)).children.map((b) => b.id)).toEqual(['b', 'p', 'q']),
			SLOW
		);
		expect(await reasons(room, 'denied')).toHaveLength(1);

		// Bob deletes the locked block, then unlocks it: both undone.
		bob.document.transact(() => bob.document.facade.deleteBlock('p'));
		await vi.waitFor(async () => expect(await reasons(room, 'denied')).toHaveLength(2), SLOW);
		bob.document.transact(() => bob.document.facade.setBlockData('p', {}));
		await vi.waitFor(async () => expect(await reasons(room, 'denied')).toHaveLength(3), SLOW);
		const end = await converged(room, ada.document, bob.document);
		expect(end.json.children.map((b) => [b.id, b.data])).toEqual([
			['b', {}],
			['p', { lockedBy: 'ada' }],
			['q', {}]
		]);
		expect(end.json.children[2].content).toEqual([{ text: 'bob: free text' }]);
		// Ada still edits her block.
		ada.document.transact(() => ada.document.facade.insertText('p', 0, 'ada: '));
		await vi.waitFor(
			async () =>
				expect((await roomJSON(room)).children[1].content).toEqual([{ text: 'ada: locked text' }]),
			SLOW
		);
		expect(await reasons(room, 'denied')).toHaveLength(3);
		await converged(room, ada.document, bob.document);
		for (const peer of [ada, bob]) peer.client.close();
		for (const peer of [ada, bob]) peer.document.destroy();
	});

	it('a denied frame that initialized the document has the blocks it added deleted', async () => {
		const room = 'locked-bootstrap';
		// Ada seeds a block locked for Bob: denied (she may not lock it for him).
		const ada = await join(room, 'ada', {
			children: [{ ...para('x', 'for bob'), data: { lockedBy: 'bob' } }]
		});
		await vi.waitFor(async () => expect(await reasons(room, 'denied')).toHaveLength(1), SLOW);
		const { json } = await converged(room, ada.document);
		expect(json.children.map((b) => b.id)).not.toContain('x');
		ada.client.close();
		ada.document.destroy();
	});
});
