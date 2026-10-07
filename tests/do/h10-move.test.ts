/**
 * Phase 5, H10 — moving blocks between documents (`room.move`,
 * `room.move.late` in `docs/editor-delete-contract.md`):
 *
 * - `moveBlocks` (the host's): export at the source (no write), import at
 *   the destination, delete at the source only with that acknowledgement;
 *   both rooms' clients converge; ids kept, or renamed where the
 *   destination holds one already;
 * - idempotence: an import or a commit run twice writes once; a failed
 *   import leaves the source as it was (the export aborted);
 * - late edits: an edit that reaches the source after the commit (an
 *   offline client's) is forwarded to the destination, merged three ways
 *   with what was written there since — by the room itself (`rooms()`, the
 *   `moving-*` rooms) or by the host (`forwardLateEdits`);
 * - a structural late edit (a split) is reported and stays at the source;
 * - past the grace period the source stops watching.
 */
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
	forwardLateEdits,
	moveBlocks,
	type DocumentRoom as Room,
	type MoveNamespace
} from '../../src/lib/cloudflare/index.js';
import type { JSONDoc } from '../../src/lib/crdt/index.js';
import { setNow, type MoveRoom } from './worker';
import { E, RawClient, Y, para, readFacade } from './client';

declare global {
	namespace Cloudflare {
		interface Env {
			ROOM: DurableObjectNamespace<Room>;
			MOVES: DurableObjectNamespace<MoveRoom>;
		}
	}
}

const namespaceOf = (room: string) => (room.startsWith('moving-') ? env.MOVES : env.ROOM);
const moves = (room: string) => namespaceOf(room) as unknown as MoveNamespace;
const inRoom = <T>(room: string, fn: (r: Room, state: DurableObjectState) => T) =>
	runInDurableObject(namespaceOf(room).getByName(room) as DurableObjectStub<Room>, (r: Room, s) =>
		fn(r, s)
	);
const roomJSON = (room: string) =>
	inRoom(room, (r) => JSON.parse(JSON.stringify(readFacade(r.doc!, (f) => f.toJSON()))));
const texts = (json: JSONDoc): Record<string, string> => {
	const out: Record<string, string> = {};
	const visit = (b: JSONDoc['children'][number]) => {
		out[b.id!] = (b.content ?? []).map((c) => ('text' in c ? c.text : '@')).join('');
		b.children?.forEach(visit);
	};
	json.children.forEach(visit);
	return out;
};

const join = async (room: string, user: string, value?: JSONDoc) => {
	const document = E.createDocument({ value, actor: { id: user } });
	const client = await RawClient.connect(room, document.doc, {
		user,
		replica: document.doc.clientID
	});
	await vi.waitFor(() => expect(client.synced).toBe(true));
	// The room stores the seed when the client answers its Step1, after the
	// client heard the room: a row that closes the client and reads the room
	// at once must wait for it (a race a loaded runner lost, CC-05).
	if (value !== undefined)
		await vi.waitFor(async () => expect(texts(await roomJSON(room))).toMatchObject(texts(value)));
	return { document, client };
};

const source = (): JSONDoc => ({
	children: [
		para('a', 'alpha'),
		{ ...para('m', 'moved block'), data: { tone: 'warm' }, children: [para('m1', 'its child')] },
		para('z', 'zulu')
	]
});

describe('H10 · moveBlocks: export, import, then delete at the source', () => {
	it('the blocks leave A for B, with their subtree, data and ids; clients of both converge', async () => {
		const [A, B] = ['move-a1', 'move-b1'];
		const ada = await join(A, 'ada', source());
		const bob = await join(B, 'bob', { children: [para('b1', 'bravo'), para('b2', 'charlie')] });
		const receipt = await moveBlocks(moves(A), {
			from: A,
			to: B,
			ids: ['m'],
			dest: { parent: null, index: 1 }
		});
		expect(receipt).toMatchObject({ status: 'applied', ids: { m: 'm', m1: 'm1' } });
		await vi.waitFor(async () => {
			expect(texts(ada.document.facade.toJSON())).toEqual({ a: 'alpha', z: 'zulu' });
			expect(bob.document.facade.toJSON()).toEqual(await roomJSON(B));
		});
		const b = await roomJSON(B);
		expect(b.children.map((x: { id: string }) => x.id)).toEqual(['b1', 'm', 'b2']);
		expect(b.children[1]).toMatchObject({
			data: { tone: 'warm' },
			content: [{ text: 'moved block' }],
			children: [{ id: 'm1', content: [{ text: 'its child' }] }]
		});
		expect(texts(await roomJSON(A))).toEqual({ a: 'alpha', z: 'zulu' });
		for (const peer of [ada, bob]) peer.client.close();
		for (const peer of [ada, bob]) peer.document.destroy();
	});

	it('an id the destination holds is renamed; an import or a commit run twice writes once', async () => {
		const [A, B] = ['move-a2', 'move-b2'];
		await join(A, 'ada', source()).then((p) => p.client.close());
		await join(B, 'bob', { children: [para('m', 'already here')] }).then((p) => p.client.close());
		const a = moves(A).getByName(A);
		const b = moves(B).getByName(B);
		const exported = await a.exportBlocks(['m']);
		// Exporting writes nothing.
		expect(texts(await roomJSON(A))).toMatchObject({ m: 'moved block' });
		const request = {
			moveId: exported.moveId,
			from: A,
			blocks: exported.blocks,
			dest: { parent: null, index: 1 }
		};
		const first = await b.importBlocks(request);
		const again = await b.importBlocks(request);
		expect(first).toEqual(again);
		expect(first.ids).toEqual({ m: 'm~2', m1: 'm1' });
		expect((await roomJSON(B)).children.map((x: { id: string }) => x.id)).toEqual(['m', 'm~2']);
		expect(await a.commitMove(exported.moveId, { to: B, ids: first.ids })).toMatchObject({
			status: 'applied'
		});
		expect(await a.commitMove(exported.moveId, { to: B, ids: first.ids })).toMatchObject({
			status: 'applied'
		});
		expect(texts(await roomJSON(A))).toEqual({ a: 'alpha', z: 'zulu' });
	});

	it('a refused import leaves the source as it was; the export is aborted', async () => {
		const [A, B] = ['move-a3', 'move-b3'];
		await join(A, 'ada', source()).then((p) => p.client.close());
		await join(B, 'bob', { children: [para('b1', 'bravo')] }).then((p) => p.client.close());
		const receipt = await moveBlocks(moves(A), {
			from: A,
			to: B,
			ids: ['m'],
			dest: { parent: 'nowhere', index: 0 }
		});
		expect(receipt).toMatchObject({ status: 'refused', reason: 'no such parent' });
		expect(texts(await roomJSON(A))).toMatchObject({ m: 'moved block', m1: 'its child' });
		expect(texts(await roomJSON(B))).toEqual({ b1: 'bravo' });
	});
});

/** A move with Carol offline on the source: she typed into the moved block before she heard of it. */
const lateMove = async (A: string, B: string) => {
	await setNow2(A, '2026-10-06T08:00:00Z');
	await setNow2(B, '2026-10-06T08:00:00Z');
	const ada = await join(A, 'ada', source());
	const carol = await join(A, 'carol');
	await vi.waitFor(() => expect(texts(carol.document.facade.toJSON()).m).toBe('moved block'));
	carol.client.close();
	// Offline: Carol appends to the moved block.
	carol.document.transact(() => carol.document.facade.insertText('m', 11, ' (late)'));
	const bob = await join(B, 'bob', { children: [para('b1', 'bravo')] });
	const receipt = await moveBlocks(moves(A), {
		from: A,
		to: B,
		ids: ['m'],
		dest: { parent: null, index: 1 }
	});
	// Bob edits the moved block's start in B meanwhile.
	await vi.waitFor(() => expect(texts(bob.document.facade.toJSON()).m).toBe('moved block'));
	bob.document.transact(() => bob.document.facade.insertText('m', 0, 'BOB: '));
	await vi.waitFor(async () => expect(texts(await roomJSON(B)).m).toBe('BOB: moved block'));
	// Carol comes back to A: her edit reaches the source late.
	const back = await RawClient.connect(A, carol.document.doc, {
		user: 'carol',
		replica: carol.document.doc.clientID
	});
	await vi.waitFor(() => expect(back.synced).toBe(true));
	await arrived(A, carol.document);
	return { ada, bob, carol, back, receipt };
};
/** The room holds everything `document` wrote. */
const arrived = (room: string, document: { doc: { clientID: number } }) =>
	vi.waitFor(async () => {
		const sv = Y.decodeStateVector(Y.encodeStateVector(document.doc as never));
		const held = await inRoom(room, (r) => Y.decodeStateVector(Y.encodeStateVector(r.doc!)));
		expect(held.get(document.doc.clientID)).toBe(sv.get(document.doc.clientID));
	});
const setNow2 = (room: string, iso: string) =>
	inRoom(room, (_r, state) => setNow(state.storage.sql, Date.parse(iso)));

describe('H10 · late edits reach the destination', () => {
	it('the source room forwards them itself (rooms()): merged with what B wrote since', async () => {
		const [A, B] = ['moving-a1', 'moving-b1'];
		const { ada, bob, carol, back } = await lateMove(A, B);
		// The source's alarm reads the late edit and forwards it.
		await runDurableObjectAlarm(env.MOVES.getByName(A));
		await vi.waitFor(async () =>
			expect(texts(await roomJSON(B)).m).toBe('BOB: moved block (late)')
		);
		await vi.waitFor(() =>
			expect(texts(bob.document.facade.toJSON()).m).toBe('BOB: moved block (late)')
		);
		// Nothing waits any more; the source still shows nothing of it.
		expect(await inRoom(A, (r) => r.lateEdits())).toEqual([]);
		expect(texts(await roomJSON(A))).toEqual({ a: 'alpha', z: 'zulu' });
		const logged = await inRoom(A, (r) =>
			(r as unknown as MoveRoom).logged.filter((e) => e.edytor === 'late')
		);
		expect(logged).toEqual([
			{
				edytor: 'late',
				moveId: expect.any(String),
				seq: 1,
				edits: 1,
				structural: 0,
				forwarded: true
			}
		]);
		for (const peer of [ada, bob, carol]) peer.client.close();
		back.close();
		for (const peer of [ada, bob, carol]) peer.document.destroy();
	});

	it('without rooms(), they wait for the host: lateEdits(), then forwardLateEdits', async () => {
		const [A, B] = ['move-late-a', 'move-late-b'];
		const { ada, bob, carol, back } = await lateMove(A, B);
		await runDurableObjectAlarm(env.ROOM.getByName(A));
		const waiting = await inRoom(A, (r) => r.lateEdits());
		expect(waiting).toEqual([
			{
				moveId: expect.any(String),
				from: A,
				to: B,
				seq: 1,
				edits: [
					{
						block: 'm',
						base: { content: [{ text: 'moved block' }], data: { tone: 'warm' } },
						src: { content: [{ text: 'moved block (late)' }], data: { tone: 'warm' } }
					}
				]
			}
		]);
		expect(await forwardLateEdits(moves(A), A)).toBe(1);
		expect(texts(await roomJSON(B)).m).toBe('BOB: moved block (late)');
		expect(await inRoom(A, (r) => r.lateEdits())).toEqual([]);
		// A batch applied twice applies once.
		const b = moves(B).getByName(B);
		expect(await b.applyLateEdits(waiting[0])).toEqual({ applied: 1, skipped: [] });
		expect(texts(await roomJSON(B)).m).toBe('BOB: moved block (late)');
		for (const peer of [ada, bob, carol]) peer.client.close();
		back.close();
		for (const peer of [ada, bob, carol]) peer.document.destroy();
	});

	it('a structural late edit (a split) is reported and stays at the source', async () => {
		const [A, B] = ['moving-a2', 'moving-b2'];
		await setNow2(A, '2026-10-06T08:00:00Z');
		const ada = await join(A, 'ada', source());
		const carol = await join(A, 'carol');
		await vi.waitFor(() => expect(texts(carol.document.facade.toJSON()).m).toBe('moved block'));
		carol.client.close();
		carol.document.transact(() => carol.document.facade.splitBlock('m', 5, 'tail'));
		await join(B, 'bob', { children: [para('b1', 'bravo')] }).then((p) => p.client.close());
		await moveBlocks(moves(A), { from: A, to: B, ids: ['m'], dest: { parent: null, index: 1 } });
		const back = await RawClient.connect(A, carol.document.doc, {
			user: 'carol',
			replica: carol.document.doc.clientID
		});
		await vi.waitFor(() => expect(back.synced).toBe(true));
		await arrived(A, carol.document);
		await runDurableObjectAlarm(env.MOVES.getByName(A));
		const late = await inRoom(A, (r) =>
			(r as unknown as MoveRoom).logged.filter((e) => e.edytor === 'late')
		);
		expect(late).toEqual([
			{
				edytor: 'late',
				moveId: expect.any(String),
				seq: 0,
				edits: 1,
				structural: 1,
				forwarded: false
			}
		]);
		// The split's tail shows at the source (its parent deleted), and B keeps the block as moved.
		expect(texts(await roomJSON(A))).toMatchObject({ tail: ' block' });
		expect(texts(await roomJSON(B)).m).toBe('moved block');
		for (const peer of [ada, carol]) peer.client.close();
		back.close();
		for (const peer of [ada, carol]) peer.document.destroy();
	});

	it('past the grace period the source stops watching', async () => {
		const [A, B] = ['moving-a3', 'moving-b3'];
		await setNow2(A, '2026-10-06T08:00:00Z');
		await join(A, 'ada', source()).then((p) => p.client.close());
		await join(B, 'bob', { children: [para('b1', 'bravo')] }).then((p) => p.client.close());
		await moveBlocks(moves(A), { from: A, to: B, ids: ['m'], dest: { parent: null, index: 0 } });
		await runDurableObjectAlarm(env.MOVES.getByName(A));
		const state = () =>
			inRoom(
				A,
				(_r, s) =>
					s.storage.sql.exec<{ state: string }>(`SELECT state FROM moves WHERE role = 'out'`).one()
						.state
			);
		expect(await state()).toBe('moved');
		// The alarm is set for the grace period's end (the purge horizon, 30 days).
		expect(await inRoom(A, (_r, s) => s.storage.getAlarm())).toBeLessThanOrEqual(
			Date.parse('2026-11-05T08:00:01Z')
		);
		await setNow2(A, '2026-11-05T09:00:00Z');
		await runDurableObjectAlarm(env.MOVES.getByName(A));
		expect(await state()).toBe('done');
	});
});
