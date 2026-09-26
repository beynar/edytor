/**
 * arch-v2 §8.1 — checkpoint D1 rows: one liveness answer, per-writer delete
 * marks, delete-with-claims on every path, no content tombstoning.
 *
 * Rows: F-D3, F-D8, F-D9, F-D10 (delete-marks half), F-D17, F-D18, F-D20.
 * Expected values are written from the plan rows and the contracts they cite
 * (`conc.delete-wins-block`, ST02a/ST02b, rule R3, decision D-14), never read
 * back from the engine.
 *
 * Delete paths (the rows say "every path"):
 * - `view`   — an `Edytor` view's `Block.removeBlock()` (the editor's path)
 * - `facade` — `facade.deleteBlock(id)` (headless)
 * - `handle` — `facade.block(id).delete()` (the typed handle)
 *
 * §8 multi-replica rules: both delivery orders, duplicate delivery, a binary
 * reload, and at least three client-id assignments; an observer replica
 * receives every permutation of the updates, each delivered twice.
 */
// @ts-nocheck -- tests drive the vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { attachDocument, bindEdytorDoc } from '../../../lib/crdt/index.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';

const E = bindEdytorDoc(Y);

type Path = 'view' | 'facade' | 'handle';
const PATHS: Path[] = ['view', 'facade', 'handle'];

/** Remote transport origin — a provider never applies under the tracked `null` origin. */
const REMOTE = { remote: true };

const CLIENT_IDS = [
	{ seed: 10, a: 20, b: 30 },
	{ seed: 10, a: 30, b: 20 },
	{ seed: 25, a: 30, b: 20 }
];

const p = (id: string, text: string, children?: unknown[]) => ({
	id,
	type: 'paragraph',
	content: [{ kind: 'text', text }],
	...(children ? { children } : {})
});

const permutations = <T>(xs: T[]): T[][] =>
	xs.length <= 1
		? [xs]
		: xs.flatMap((x, i) =>
				permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])
			);

/** Seed update written by a fixed seed writer (optionally followed by setup ops). */
const seedUpdate = (clientID: number, content: unknown[], setup?: (ed) => void): Uint8Array => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	const ed = E.create(doc);
	ed.init({ content });
	setup?.(ed);
	return Y.encodeStateAsUpdate(doc);
};

type Replica = {
	doc: Y.Doc;
	/** The document facade the replica reads and writes through. */
	ed: ReturnType<typeof E.create>;
	view: Edytor | null;
	undo: () => void;
	stopCapturing: () => void;
	/** State vector already shipped — `send` ships everything after it. */
	sent: Uint8Array;
};

/**
 * One replica hydrated from the seed. With `withView`, an `Edytor` view is
 * mounted headlessly on the replica's document (the editor path); otherwise
 * the headless facade and its own undo manager are used.
 */
const replica = (seed: Uint8Array, clientID: number, withView: boolean): Replica => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	Y.applyUpdate(doc, seed, REMOTE);
	const sent = Y.encodeStateVector(doc);
	if (withView) {
		const document = attachDocument(doc);
		document.sync();
		const view = new Edytor({ document, plugins: [richTextPlugin] });
		return {
			doc,
			ed: document.facade,
			view,
			undo: () => {
				view.undoManager.undo();
			},
			stopCapturing: () => view.undoManager.stopCapturing(),
			sent
		};
	}
	const ed = E.create(doc);
	const um = ed.createUndoManager({ captureTimeout: 0 });
	return {
		doc,
		ed,
		view: null,
		undo: () => {
			um.undo();
		},
		stopCapturing: () => um.stopCapturing(),
		sent
	};
};

/** Everything this replica wrote since the last `send` (one wire update). */
const send = (r: Replica): Uint8Array => {
	const update = Y.encodeStateAsUpdate(r.doc, r.sent);
	r.sent = Y.encodeStateVector(r.doc);
	return update;
};

/** Duplicate delivery must be idempotent. */
const deliver = (to: Replica | Y.Doc, update: Uint8Array) => {
	const doc = 'doc' in to ? to.doc : to;
	Y.applyUpdate(doc, update, REMOTE);
	Y.applyUpdate(doc, update, REMOTE);
};

const shapeOf = (ed) => ed.project().children.map((b) => [b.id, ed.blockText(b.id)]);

const reloadShape = (doc: Y.Doc, clientID: number) => {
	const fresh = new Y.Doc();
	fresh.clientID = clientID;
	Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc), REMOTE);
	return shapeOf(E.create(fresh));
};

/** Every observer delivery order (each update twice) plus a reload of each. */
const expectObservers = (seed: Uint8Array, updates: Uint8Array[], expected: unknown) => {
	for (const order of permutations(updates)) {
		const doc = new Y.Doc();
		doc.clientID = 902;
		Y.applyUpdate(doc, seed, REMOTE);
		for (const u of order) deliver(doc, u);
		expect(shapeOf(E.create(doc)), 'observer').toEqual(expected);
		expect(reloadShape(doc, 903), 'observer reloaded').toEqual(expected);
	}
};

/** Delete `id` through `path` on replica `r`; returns the op's verdict. */
const deleteVia = (r: Replica, path: Path, id: string): boolean => {
	if (path === 'facade') return r.ed.deleteBlock(id);
	if (path === 'handle') return r.ed.block(id).delete();
	const block = r.view!.idToBlock.get(id);
	expect(block, `view block ${id}`).toBeDefined();
	block!.removeBlock();
	return !r.ed.isVisibleBlock(id);
};

/** Split `id` at `offset` through `path`; returns the new block's id. */
const splitVia = (r: Replica, path: Path, id: string, offset: number, newId: string): string => {
	if (path === 'facade') {
		expect(r.ed.splitBlock(id, offset, newId)).toBe(true);
		return newId;
	}
	if (path === 'handle') {
		expect(r.ed.block(id).split(offset, newId)).not.toBe(null);
		return newId;
	}
	const before = new Set(r.ed.listBlockIds());
	const block = r.view!.idToBlock.get(id)!;
	expect(block.splitBlock({ index: offset, text: block.firstText })).not.toBe(null);
	const born = r.ed.listBlockIds().filter((x) => !before.has(x));
	expect(born).toHaveLength(1);
	return born[0];
};

// ── F-D3 — targetability ────────────────────────────────────────────────

describe('F-D3 — a block hidden under a deleted parent is not a target', () => {
	for (const via of ['facade', 'handle'] as const) {
		test(`p > [c]; delete p; insertText/insertBlock/moveBlock/splitBlock on c refused, zero bytes (${via})`, () => {
			const doc = new Y.Doc();
			doc.clientID = 10;
			const ed = E.create(doc);
			ed.init({ content: [p('p', 'pp', [p('c', 'cc')]), p('z', 'zz')] });
			expect(ed.deleteBlock('p')).toBe(true);
			const bytes = Y.encodeStateAsUpdate(doc);
			const unchanged = () => expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);

			if (via === 'facade') {
				expect(ed.insertText('c', 0, 'x'), 'insertText(c)').toBe(false);
				unchanged();
				expect(
					ed.insertBlock({ parent: 'c', index: 0 }, p('n', 'nn')),
					'insertBlock(parent: c)'
				).toBe(false);
				unchanged();
				expect(ed.moveBlock('c', { parent: null, index: 0 }), 'moveBlock(c → root)').toBe(false);
				unchanged();
				expect(ed.splitBlock('c', 1, 's'), 'splitBlock(c)').toBe(false);
				unchanged();
			} else {
				const c = ed.block('c');
				expect(c.insertText(0, 'x'), 'insertText(c)').toBe(false);
				unchanged();
				expect(c.insertChild(0, p('n', 'nn')), 'insertBlock(parent: c)').toBe(null);
				unchanged();
				expect(c.moveTo({ parent: null, index: 0 }), 'moveBlock(c → root)').toBe(false);
				unchanged();
				expect(c.split(1, 's'), 'splitBlock(c)').toBe(null);
				unchanged();
			}
			expect(shapeOf(ed)).toEqual([['z', 'zz']]);
			expect(ed.isVisibleBlock('c')).toBe(false);
		});
	}
});

// ── F-D8 — merge then delete ────────────────────────────────────────────

describe('F-D8 — merge b into a, delete a: the merged block dies with it; undo restores both', () => {
	for (const path of PATHS) {
		test(`delete via ${path}`, () => {
			const seed = seedUpdate(10, [p('a', 'aa'), p('b', 'bb'), p('c', 'cc')]);
			const r = replica(seed, 20, path === 'view');

			if (path === 'view') {
				expect(r.view!.idToBlock.get('b')!.mergeBlockBackward()).not.toBe(null);
			} else if (path === 'facade') {
				expect(r.ed.mergeBlocks('b', 'a')).toBe(true);
			} else {
				expect(r.ed.block('a').mergeFrom('b')).toBe(true);
			}
			expect(shapeOf(r.ed)).toEqual([
				['a', 'aabb'],
				['c', 'cc']
			]);
			r.stopCapturing();

			expect(deleteVia(r, path, 'a')).toBe(true);
			r.stopCapturing();
			const afterDelete = [['c', 'cc']];
			expect(shapeOf(r.ed), 'after delete').toEqual(afterDelete);
			expect(reloadShape(r.doc, 900), 'after delete, reloaded').toEqual(afterDelete);

			r.undo();
			const afterUndo = [
				['a', 'aabb'],
				['c', 'cc']
			];
			expect(shapeOf(r.ed), 'after undo').toEqual(afterUndo);
			expect(reloadShape(r.doc, 901), 'after undo, reloaded').toEqual(afterUndo);
		});
	}
});

// ── F-D9 — concurrent: delete destination ‖ merge (ST02b) ───────────────

describe('F-D9 — A deletes a ‖ B merges b into a: a gone, b visible (ST02b)', () => {
	for (const ids of CLIENT_IDS) {
		for (const path of PATHS) {
			test(`ids seed=${ids.seed} A=${ids.a} B=${ids.b} · A deletes via ${path}`, () => {
				const seed = seedUpdate(ids.seed, [p('a', 'aa'), p('b', 'bb'), p('c', 'cc')]);
				const A = replica(seed, ids.a, path === 'view');
				const B = replica(seed, ids.b, false);
				expect(deleteVia(A, path, 'a')).toBe(true);
				const del = send(A);
				expect(B.ed.mergeBlocks('b', 'a')).toBe(true);
				const merge = send(B);

				const expected = [
					['b', 'bb'],
					['c', 'cc']
				];
				deliver(A, merge);
				deliver(B, del);
				expect(shapeOf(A.ed), 'A').toEqual(expected);
				expect(shapeOf(B.ed), 'B').toEqual(expected);
				expect(reloadShape(A.doc, 900), 'A reloaded').toEqual(expected);
				expect(reloadShape(B.doc, 901), 'B reloaded').toEqual(expected);
				expectObservers(seed, [del, merge], expected);
			});
		}
	}
});

// ── F-D10 — concurrent head typing ‖ delete of a split tail ─────────────

describe('F-D10 — abcde split at 3; B types Q at the tail head ‖ A deletes the tail → abc', () => {
	for (const ids of CLIENT_IDS) {
		for (const path of PATHS) {
			for (const aSawQ of [false, true]) {
				test(`ids seed=${ids.seed} A=${ids.a} B=${ids.b} · A deletes via ${path} · A ${
					aSawQ ? 'saw' : 'did not see'
				} Q`, () => {
					const seed = seedUpdate(ids.seed, [p('b0', 'abcde')], (ed) => {
						expect(ed.splitBlock('b0', 3, 't')).toBe(true);
					});
					const A = replica(seed, ids.a, path === 'view');
					const B = replica(seed, ids.b, false);
					expect(B.ed.insertText('t', 0, 'Q')).toBe(true);
					expect(shapeOf(B.ed)).toEqual([
						['b0', 'abc'],
						['t', 'Qde']
					]);
					const q = send(B);
					if (aSawQ) deliver(A, q);
					expect(deleteVia(A, path, 't')).toBe(true);
					const del = send(A);
					if (!aSawQ) deliver(A, q);
					deliver(B, del);

					const expected = [['b0', 'abc']];
					expect(shapeOf(A.ed), 'A').toEqual(expected);
					expect(shapeOf(B.ed), 'B').toEqual(expected);
					expect(reloadShape(A.doc, 900), 'A reloaded').toEqual(expected);
					expect(reloadShape(B.doc, 901), 'B reloaded').toEqual(expected);
					expectObservers(seed, [q, del], expected);
				});
			}
		}
	}
});

// ── F-D17 — undo of delete with an offline peer (F2) ────────────────────

describe('F-D17 — A deletes b and undoes; offline P deletes "world" and bolds "hello"', () => {
	const norm = (items) =>
		items.map((i) => [i.kind === 'text' ? i.text : `<${i.type}>`, i.marks?.bold === true]);
	for (const ids of CLIENT_IDS) {
		for (const path of PATHS) {
			test(`ids seed=${ids.seed} A=${ids.a} P=${ids.b} · A deletes via ${path}`, () => {
				const seed = seedUpdate(ids.seed, [p('b', 'hello world'), p('c', 'cc')]);
				const A = replica(seed, ids.a, path === 'view');
				const P = replica(seed, ids.b, false);

				expect(deleteVia(A, path, 'b')).toBe(true);
				A.stopCapturing();
				const del = send(A);
				A.undo();
				const undo = send(A);

				expect(P.ed.deleteText('b', 6, 5)).toBe(true);
				expect(P.ed.setMark('b', 0, 5, 'bold', true)).toBe(true);
				const edits = send(P);

				deliver(A, edits);
				deliver(P, del);
				deliver(P, undo);

				const expectedShape = [
					['b', 'hello '],
					['c', 'cc']
				];
				const expectedItems = [
					['hello', true],
					[' ', false]
				];
				for (const [name, r] of [
					['A', A],
					['P', P]
				] as const) {
					expect(shapeOf(r.ed), name).toEqual(expectedShape);
					expect(norm(r.ed.contentItems('b')), `${name} marks`).toEqual(expectedItems);
				}
				expect(reloadShape(A.doc, 900), 'A reloaded').toEqual(expectedShape);
				expect(reloadShape(P.doc, 901), 'P reloaded').toEqual(expectedShape);
				expectObservers(seed, [del, undo, edits], expectedShape);
			});
		}
	}
});

// ── F-D18 — concurrent double delete, selective undo (F12) ──────────────

describe('F-D18 — A and P delete the same block concurrently; A undoes → still deleted', () => {
	for (const ids of CLIENT_IDS) {
		for (const path of PATHS) {
			for (const aOrder of ['p-then-undo', 'undo-then-p'] as const) {
				test(`ids seed=${ids.seed} A=${ids.a} P=${ids.b} · A deletes via ${path} · A: ${aOrder}`, () => {
					const seed = seedUpdate(ids.seed, [p('a', 'aa'), p('b', 'bb'), p('c', 'cc')]);
					const A = replica(seed, ids.a, path === 'view');
					const P = replica(seed, ids.b, false);

					expect(deleteVia(A, path, 'b')).toBe(true);
					A.stopCapturing();
					const aDel = send(A);
					expect(P.ed.deleteBlock('b')).toBe(true);
					const pDel = send(P);

					if (aOrder === 'p-then-undo') deliver(A, pDel);
					A.undo();
					const aUndo = send(A);
					if (aOrder === 'undo-then-p') deliver(A, pDel);
					deliver(P, aDel);
					deliver(P, aUndo);

					const expected = [
						['a', 'aa'],
						['c', 'cc']
					];
					expect(shapeOf(A.ed), 'A').toEqual(expected);
					expect(shapeOf(P.ed), 'P').toEqual(expected);
					expect(reloadShape(A.doc, 900), 'A reloaded').toEqual(expected);
					expect(reloadShape(P.doc, 901), 'P reloaded').toEqual(expected);
					expectObservers(seed, [aDel, pDel, aUndo], expected);
				});
			}
		}
	}
});

// ── F-D20 — delete source ‖ split (ST02a) ───────────────────────────────

describe('F-D20 — A deletes b1 ‖ B splits b1 at 6 into s1: s1 keeps "world" (ST02a)', () => {
	for (const ids of CLIENT_IDS) {
		for (const delPath of PATHS) {
			for (const splitPath of PATHS) {
				test(`ids seed=${ids.seed} A=${ids.a} B=${ids.b} · A deletes via ${delPath} · B splits via ${splitPath}`, () => {
					const seed = seedUpdate(ids.seed, [p('b1', 'hello world'), p('z', 'zz')]);
					const A = replica(seed, ids.a, delPath === 'view');
					const B = replica(seed, ids.b, splitPath === 'view');

					expect(deleteVia(A, delPath, 'b1')).toBe(true);
					const del = send(A);
					const s1 = splitVia(B, splitPath, 'b1', 6, 's1');
					expect(shapeOf(B.ed)).toEqual([
						['b1', 'hello '],
						[s1, 'world'],
						['z', 'zz']
					]);
					const split = send(B);

					deliver(A, split);
					deliver(B, del);
					const expected = [
						[s1, 'world'],
						['z', 'zz']
					];
					expect(shapeOf(A.ed), 'A').toEqual(expected);
					expect(shapeOf(B.ed), 'B').toEqual(expected);
					expect(A.ed.blockText(s1)).toBe('world');
					expect(reloadShape(A.doc, 900), 'A reloaded').toEqual(expected);
					expect(reloadShape(B.doc, 901), 'B reloaded').toEqual(expected);
					expectObservers(seed, [del, split], expected);
				});
			}
		}
	}
});
