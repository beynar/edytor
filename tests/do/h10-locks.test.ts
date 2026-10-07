/**
 * Phase 5, H10 — per-block locks as a supported helper (`lockedBlocks`,
 * `room.locks` in `docs/editor-delete-contract.md`), on the H2 hook:
 *
 * - `subtree`: a lock holds every block displayed under the locked one —
 *   typing into a child, adding a child, moving a block in or out, are
 *   denied for anyone but the owner, and compensated;
 * - `bypass`: an admin edits a locked block;
 * - `EDYTOR_LOCKS` (the `DocumentRoom` default `locks()`) names the key;
 * - the helper as a pure function over a `FrameValidation`.
 *
 * The plain lock (`locked-*` rooms) is pinned by `h2-validation.test.ts`,
 * which now runs on the helper.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
	lockedBlocks,
	type DocumentRoom as Room,
	type FrameValidation,
	type ValidatedBlock
} from '../../src/lib/cloudflare/index.js';
import type { JSONDoc } from '../../src/lib/crdt/index.js';
import type { LockedRoom } from './worker';
import { E, RawClient, Y, para, readFacade } from './client';

declare global {
	namespace Cloudflare {
		interface Env {
			LOCKED: DurableObjectNamespace<LockedRoom>;
		}
	}
}

type Document = ReturnType<typeof E.createDocument>;
const inRoom = <T>(room: string, fn: (r: Room) => T) =>
	runInDurableObject(env.LOCKED.getByName(room) as DurableObjectStub<Room>, (r: Room) => fn(r));
const roomJSON = (room: string) => inRoom(room, (r) => readFacade(r.doc!, (f) => f.toJSON()));
const denied = (room: string) =>
	inRoom(room, (r) => r.refusals.filter((x) => x.reason === 'denied').map((x) => x.detail));

const join = async (room: string, user: string, value?: JSONDoc) => {
	const document = E.createDocument({ value, actor: { id: user } });
	const client = await RawClient.connect(room, document.doc, {
		user,
		replica: document.doc.clientID
	});
	await vi.waitFor(() => expect(client.synced).toBe(true));
	return { document, client };
};

const converged = async (room: string, ...documents: Document[]) => {
	for (const document of documents)
		await vi.waitFor(async () =>
			expect(Y.encodeStateVector(document.doc)).toEqual(
				await inRoom(room, (r) => Y.encodeStateVector(r.doc!))
			)
		);
	const json = await roomJSON(room);
	for (const document of documents) expect(document.facade.toJSON()).toEqual(json);
	return json;
};

/** A parent locked by Ada with one child, and a free block. */
const tree = (): JSONDoc => ({
	children: [
		{ ...para('p', 'parent'), data: { lockedBy: 'ada' }, children: [para('c', 'child')] },
		para('q', 'free')
	]
});

describe('H10 · a subtree lock holds what shows under the locked block', () => {
	it('typing into a child, adding a child, moving a block in or out: denied for Bob, allowed for Ada', async () => {
		const room = 'locked-tree-a';
		const ada = await join(room, 'ada', tree());
		const bob = await join(room, 'bob');
		await converged(room, ada.document, bob.document);
		// Bob types into the locked parent's child.
		bob.document.transact(() => bob.document.facade.insertText('c', 0, 'BOB '));
		await vi.waitFor(async () => expect(await denied(room)).toHaveLength(1));
		// Bob adds a child under the locked parent.
		bob.document.transact(() =>
			bob.document.facade.insertBlock({ parent: 'p', index: 1 }, { id: 'n', type: 'paragraph' })
		);
		await vi.waitFor(async () => expect(await denied(room)).toHaveLength(2));
		// Bob moves his free block into the locked subtree, and the child out of it.
		bob.document.transact(() => bob.document.facade.moveBlock('q', { parent: 'p', index: 0 }));
		await vi.waitFor(async () => expect(await denied(room)).toHaveLength(3));
		bob.document.transact(() => bob.document.facade.moveBlock('c', { parent: null, index: 2 }));
		await vi.waitFor(async () => expect(await denied(room)).toHaveLength(4));
		const json = await converged(room, ada.document, bob.document);
		expect(json).toEqual({
			children: [
				{
					id: 'p',
					type: 'paragraph',
					data: { lockedBy: 'ada' },
					content: [{ text: 'parent' }],
					children: [{ id: 'c', type: 'paragraph', data: {}, content: [{ text: 'child' }] }]
				},
				{ id: 'q', type: 'paragraph', data: {}, content: [{ text: 'free' }] }
			]
		});
		// Bob's free block stays his to edit; Ada edits her subtree.
		bob.document.transact(() => bob.document.facade.insertText('q', 0, 'bob: '));
		ada.document.transact(() => ada.document.facade.insertText('c', 0, 'ada: '));
		await vi.waitFor(async () => {
			const children = (await roomJSON(room)).children;
			expect(children[1].content).toEqual([{ text: 'bob: free' }]);
			expect(children[0].children![0].content).toEqual([{ text: 'ada: child' }]);
		});
		await converged(room, ada.document, bob.document);
		expect(await denied(room)).toHaveLength(4);
		for (const peer of [ada, bob]) peer.client.close();
		for (const peer of [ada, bob]) peer.document.destroy();
	});

	it('without `subtree` the child is free (the plain lock)', async () => {
		const room = 'locked-plain-tree';
		const ada = await join(room, 'ada', tree());
		const bob = await join(room, 'bob');
		bob.document.transact(() => bob.document.facade.insertText('c', 0, 'BOB '));
		await vi.waitFor(async () =>
			expect((await roomJSON(room)).children[0].children![0].content).toEqual([
				{ text: 'BOB child' }
			])
		);
		expect(await denied(room)).toEqual([]);
		for (const peer of [ada, bob]) peer.client.close();
		for (const peer of [ada, bob]) peer.document.destroy();
	});
});

describe('H10 · bypass and the EDYTOR_LOCKS var', () => {
	it('an admin edits and unlocks a locked block', async () => {
		const room = 'locked-admin-a';
		const ada = await join(room, 'ada', {
			children: [{ ...para('p', 'mine'), data: { lockedBy: 'ada' } }]
		});
		const admin = await join(room, 'admin');
		admin.document.transact(() => admin.document.facade.insertText('p', 0, 'note: '));
		admin.document.transact(() => admin.document.facade.setBlockData('p', {}));
		await vi.waitFor(async () =>
			expect((await roomJSON(room)).children[0]).toMatchObject({
				data: {},
				content: [{ text: 'note: mine' }]
			})
		);
		expect(await denied(room)).toEqual([]);
		for (const peer of [ada, admin]) peer.client.close();
		for (const peer of [ada, admin]) peer.document.destroy();
	});

	it('EDYTOR_LOCKS names the key: a DocumentRoom locks with no code', async () => {
		const room = 'locked-env-a';
		const ada = await join(room, 'ada', {
			children: [{ ...para('p', 'mine'), data: { lockedBy: 'ada' } }]
		});
		const bob = await join(room, 'bob');
		bob.document.transact(() => bob.document.facade.insertText('p', 0, 'x'));
		await vi.waitFor(async () => expect(await denied(room)).toHaveLength(1));
		expect((await converged(room, ada.document, bob.document)).children[0].content).toEqual([
			{ text: 'mine' }
		]);
		for (const peer of [ada, bob]) peer.client.close();
		for (const peer of [ada, bob]) peer.document.destroy();
	});
});

describe('H10 · lockedBlocks as a function', () => {
	const block = (id: string, parent: string | null, lockedBy?: string): ValidatedBlock => ({
		id,
		type: 'paragraph',
		data: lockedBy === undefined ? {} : { lockedBy },
		content: [],
		parent
	});
	const frame = (
		user: string,
		touched: string[],
		before: Record<string, ValidatedBlock | null>,
		after: Record<string, ValidatedBlock | null>
	): FrameValidation => ({
		user,
		replica: null,
		touched,
		dataChanged: false,
		before: (id) => (id in before ? before[id] : (after[id] ?? null)),
		after: (id) => after[id] ?? null,
		facade: null as never
	});
	const state = { a: block('a', null, 'ada'), b: block('b', 'a'), c: block('c', 'b') };

	it('the nearest locked ancestor decides with `subtree`, the block alone without', () => {
		const f = frame('bob', ['c'], state, state);
		expect(lockedBlocks()(f)).toBe(true);
		expect(lockedBlocks({ subtree: true })(f)).toBe(false);
		expect(lockedBlocks({ subtree: true })(frame('ada', ['c'], state, state))).toBe(true);
		// A nearer lock of Bob's own wins.
		const mine = { ...state, b: block('b', 'a', 'bob') };
		expect(lockedBlocks({ subtree: true })(frame('bob', ['c'], mine, mine))).toBe(true);
	});

	it('locking for someone else is denied; unlocking one’s own is allowed; another key', () => {
		const free = { x: block('x', null) };
		const locked = { x: block('x', null, 'carol') };
		expect(lockedBlocks()(frame('bob', ['x'], free, locked))).toBe(false);
		expect(lockedBlocks()(frame('carol', ['x'], locked, free))).toBe(true);
		const owned = { x: { ...block('x', null), data: { owner: 'bob' } } };
		expect(lockedBlocks({ key: 'owner' })(frame('ada', ['x'], owned, owned))).toBe(false);
		expect(
			lockedBlocks({ key: 'owner', bypass: (u) => u === 'ada' })(frame('ada', ['x'], owned, owned))
		).toBe(true);
	});
});
