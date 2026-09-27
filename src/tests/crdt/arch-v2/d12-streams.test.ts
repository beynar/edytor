/**
 * arch-v2 D12 — text ownership switched from slice records to stream
 * boundaries (plan §2.1, R2; §9.3 D12 row), through the production facade.
 *
 * Rows (expected results from the plan's contracts and the orchestrator's D12
 * requirements, never from running code):
 * - F-D11: concurrent splits of `hello world` at 3 ‖ 8 partition it into
 *   `hel`, `lo wo`, `rld`; nothing dropped or duplicated (reading order of the
 *   siblings is tracked only, D-18).
 * - F-D15: history independence — a left caret at a block's start stays in
 *   that (now empty) block when the block is split at 0, whether the block
 *   owns its text or was split off another (anchor rule 1).
 * - F-D16: per-keystroke bytes at a split-born block's start are within 10 %
 *   of mid-text typing.
 * - F-D21 (D-21, pinned): a split re-inserts the merge claims that follow it
 *   on the new block, so a concurrent undo of that merge leaves the claimed
 *   block merged into the new block.
 * - F-U3 (lineage half): with lineage on, one wire update per undo, and a
 *   receiver applying it never shows `hello world` in the head.
 * - F-D19 (late redo, orchestrator requirement 3): after the paste's undo and
 *   B's typing into the emptied split-born block, A's late redo shows
 *   `HelloQ world` in P while `u` keeps `z` — nothing lost or doubled.
 * - Orchestrator requirements 2+4: concurrent first typing into a
 *   boundary-dead streamless block on two replicas keeps both typings; the
 *   block's own text is written by a writer derived from the block and its
 *   dead incarnation (identical items on both replicas); `createdBy` survives.
 * - Orchestrator requirement 5: splitting a block with no text and no claims
 *   creates its own text first (the split is applied, both blocks visible).
 *
 * Multi-replica rows: three client-id assignments, both delivery orders,
 * duplicate delivery and a binary reload (plan §8).
 */
// @ts-nocheck -- tests reach raw engine internals (excluded lane).
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';

const E = bindEdytorDoc(Y);
const REMOTE = { remote: true };
const alice = { id: 'alice' };
const bob = { id: 'bob' };

/** Red on the reference (`arch-v2/ref-d12`, slice records): `it.fails` until the switch. */
const red = it.fails;

const CLIENT_IDS = [
	{ a: 7, b: 3 },
	{ a: 3, b: 7 },
	{ a: 100, b: 50 }
];

const para = (id: string, text?: string) => ({
	id,
	type: 'paragraph',
	...(text === undefined ? {} : { content: [{ text }] })
});

const seeded = (blocks) => {
	const doc = new Y.Doc();
	E.seed(doc, blocks);
	return Y.encodeStateAsUpdate(doc);
};

type Replica = { doc: Y.Doc; ed: ReturnType<typeof E.create>; sent: Uint8Array };

const replica = (base: Uint8Array, clientID: number, config = {}): Replica => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	Y.applyUpdate(doc, base, REMOTE);
	return { doc, ed: E.create(doc, config), sent: Y.encodeStateVector(doc) };
};

/** Everything `r` wrote since the last send. */
const send = (r: Replica): Uint8Array => {
	const u = Y.encodeStateAsUpdate(r.doc, r.sent);
	r.sent = Y.encodeStateVector(r.doc);
	return u;
};

/** Duplicate delivery: every update applied twice. */
const deliver = (to: Replica, ...updates: Uint8Array[]) => {
	for (const u of updates) {
		Y.applyUpdate(to.doc, u, REMOTE);
		Y.applyUpdate(to.doc, u, REMOTE);
	}
	to.sent = Y.encodeStateVector(to.doc);
};

/** Exchange everything both ways, in `order`. */
const sync = (x: Replica, y: Replica, order: 'xy' | 'yx' = 'xy') => {
	const ux = Y.encodeStateAsUpdate(x.doc, Y.encodeStateVector(y.doc));
	const uy = Y.encodeStateAsUpdate(y.doc, Y.encodeStateVector(x.doc));
	if (order === 'xy') {
		deliver(y, ux);
		deliver(x, uy);
	} else {
		deliver(x, uy);
		deliver(y, ux);
	}
};

const reload = (doc: Y.Doc, clientID: number) => {
	const fresh = new Y.Doc();
	fresh.clientID = clientID;
	Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc), REMOTE);
	return E.create(fresh);
};

/** `[id, text]` of every visible block, in document order. */
const shape = (ed) => ed.listBlockIds().map((id) => [id, ed.blockText(id)]);

/** The bytes one local step writes, and how many `update` events it emitted. */
const step = (doc: Y.Doc, fn: () => unknown) => {
	const before = Y.encodeStateVector(doc);
	let updates = 0;
	const frames: Uint8Array[] = [];
	const count = (u: Uint8Array) => {
		updates++;
		frames.push(u);
	};
	doc.on('update', count);
	try {
		fn();
	} finally {
		doc.off('update', count);
	}
	return { bytes: Y.encodeStateAsUpdate(doc, before), updates, frames };
};

// ── F-D11 ────────────────────────────────────────────────────────────────

/** 40 ordered client pairs. */
const PAIRS = (() => {
	const ids = [2, 3, 5, 7, 11, 13, 17];
	const out: [number, number][] = [];
	for (const a of ids) for (const b of ids) if (a !== b && out.length < 40) out.push([a, b]);
	return out;
})();

describe('F-D11 — hello world split at 3 ‖ split at 8, 40 client pairs', () => {
	const base = seeded([para('b', 'hello world')]);
	for (const [a, b] of PAIRS) {
		it(`A=${a} B=${b}`, () => {
			for (const order of ['xy', 'yx'] as const) {
				const A = replica(base, a);
				const B = replica(base, b);
				expect(A.ed.splitBlock('b', 3, 'sA').status).toBe('applied');
				expect(B.ed.splitBlock('b', 8, 'sB').status).toBe('applied');
				sync(A, B, order);
				for (const ed of [A.ed, B.ed, reload(A.doc, 900), reload(B.doc, 901)]) {
					expect(ed.blockText('b')).toBe('hel');
					expect(ed.blockText('sA')).toBe('lo wo');
					expect(ed.blockText('sB')).toBe('rld');
					const all = ed
						.listBlockIds()
						.map((id) => ed.blockText(id))
						.join('');
					expect([...all].sort().join('')).toBe([...'hello world'].sort().join(''));
				}
				expect(shape(A.ed)).toEqual(shape(B.ed));
			}
		});
	}
});

// ── F-D15 ────────────────────────────────────────────────────────────────

describe('F-D15 — history independence: a left caret at a block start stays there across a split at 0', () => {
	const cases = {
		'(a) own text': seeded([para('alpha', 'alpha'), para('d2', 'Hello')]),
		'(b) split-born': (() => {
			const doc = new Y.Doc();
			E.seed(doc, [para('alpha', 'alphaHello')]);
			const ed = E.create(doc);
			expect(ed.splitBlock('alpha', 5, 'd2').status).toBe('applied');
			return Y.encodeStateAsUpdate(doc);
		})()
	};
	for (const [name, base] of Object.entries(cases)) {
		// (b) holds on the reference (the owner facet); (a) is C3.
		(name.startsWith('(a)') ? red : it)(name, () => {
			const A = replica(base, 7);
			expect(shape(A.ed)).toEqual([
				['alpha', 'alpha'],
				['d2', 'Hello']
			]);
			const caret = A.ed.anchorAt('d2', 0, 'left');
			expect(A.ed.splitBlock('d2', 0, 'w').status).toBe('applied');
			expect(shape(A.ed)).toEqual([
				['alpha', 'alpha'],
				['d2', ''],
				['w', 'Hello']
			]);
			expect(A.ed.resolveAnchor(caret)).toEqual({ blockId: 'd2', offset: 0 });
			// the same answer on a replica that received both writes
			const B = replica(Y.encodeStateAsUpdate(A.doc), 3);
			expect(B.ed.resolveAnchor(caret)).toEqual({ blockId: 'd2', offset: 0 });
		});
	}
});

// ── F-D16 ────────────────────────────────────────────────────────────────

describe('F-D16 — bytes per keystroke at a split-born block start ≈ mid-text typing', () => {
	const typed = (ed, doc, id, at: (i: number) => number) => {
		let total = 0;
		for (let i = 0; i < 20; i++) {
			total += step(doc, () => expect(ed.insertText(id, at(i), 'k').status).toBe('applied')).bytes
				.length;
		}
		return total / 20;
	};
	const withSplit = () => {
		const A = replica(seeded([para('b', 'hello world, hello world')]), 7);
		expect(A.ed.splitBlock('b', 12, 'u').status).toBe('applied');
		return A;
	};
	red('typing forward from the start, and repeated inserts at the start', () => {
		const mid = withSplit();
		const midBytes = typed(mid.ed, mid.doc, 'b', (i) => 5 + i);
		const fwd = withSplit();
		const fwdBytes = typed(fwd.ed, fwd.doc, 'u', (i) => i);
		const pre = withSplit();
		const preBytes = typed(pre.ed, pre.doc, 'u', () => 0);
		expect(fwdBytes).toBeLessThanOrEqual(midBytes * 1.1);
		expect(preBytes).toBeLessThanOrEqual(midBytes * 1.1 + 4);
		expect(fwd.ed.blockText('u')).toBe('k'.repeat(20) + ' hello world');
	});
});

// ── F-D21 ────────────────────────────────────────────────────────────────

describe('F-D21 (D-21) — M merges c into b then undoes ‖ S splits b before c: c stays merged into the new block', () => {
	const base = seeded([para('b', 'bb'), para('c', 'cc')]);
	for (const ids of CLIENT_IDS) {
		for (const order of ['xy', 'yx'] as const) {
			it(`M=${ids.a} S=${ids.b} · ${order}`, () => {
				const M = replica(base, ids.a);
				const S = replica(base, ids.b);
				const um = M.ed.createUndoManager({ captureTimeout: 0 });
				expect(M.ed.mergeBlocks('c', 'b').status).toBe('applied');
				deliver(S, send(M));
				expect(shape(S.ed)).toEqual([['b', 'bbcc']]);
				expect(um.undo()).not.toBe(null);
				expect(S.ed.splitBlock('b', 2, 'u').status).toBe('applied');
				sync(M, S, order);
				const expected = [
					['b', 'bb'],
					['u', 'cc']
				];
				for (const ed of [M.ed, S.ed, reload(M.doc, 900), reload(S.doc, 901)]) {
					expect(shape(ed)).toEqual(expected);
				}
			});
		}
	}
});

// ── F-U3 (lineage half) ──────────────────────────────────────────────────

describe('F-U3 — lineage on: one wire update per undo; the receiver never shows hello world in the head', () => {
	const base = seeded([para('b', 'hello world')]);
	for (const ids of CLIENT_IDS) {
		red(`A=${ids.a} B=${ids.b}`, () => {
			const A = replica(base, ids.a, { actor: () => alice, lineageDepth: 5 });
			const B = replica(base, ids.b, { actor: () => bob, lineageDepth: 5 });
			const um = A.ed.createUndoManager({ captureTimeout: 0 });
			expect(A.ed.splitBlock('b', 6, 't').status).toBe('applied');
			expect(A.ed.deleteText('t', 0, 5).status).toBe('applied');
			deliver(B, send(A));
			expect(shape(B.ed)).toEqual([
				['b', 'hello '],
				['t', '']
			]);
			const undo = step(A.doc, () => expect(um.undo()).not.toBe(null));
			expect(undo.updates).toBe(1);
			A.sent = Y.encodeStateVector(A.doc);
			for (const frame of undo.frames) {
				deliver(B, frame);
				expect(B.ed.blockText('b')).toBe('hello ');
			}
			for (const ed of [A.ed, B.ed, reload(B.doc, 901)]) {
				expect(shape(ed)).toEqual([
					['b', 'hello '],
					['t', 'world']
				]);
			}
		});
	}
});

// ── F-D19 scenario: a split-born block whose boundary died with its host ───

/**
 * A pastes P `Hello world`; B presses Enter inside P at 5 (creating `u`) and
 * types `Q` at u's start; A undoes the paste. Returns both replicas synced.
 */
const deadBoundary = (ids, config: (who: 'A' | 'B') => object = () => ({})) => {
	const base = seeded([para('x', 'x')]);
	const A = replica(base, ids.a, config('A'));
	const B = replica(base, ids.b, config('B'));
	const um = A.ed.createUndoManager({ captureTimeout: 0 });
	expect(
		A.ed.insertBlock(
			{ parent: null, index: 1 },
			{ id: 'P', type: 'paragraph', content: [{ kind: 'text', text: 'Hello world' }] }
		).status
	).toBe('applied');
	deliver(B, send(A));
	expect(B.ed.splitBlock('P', 5, 'u').status).toBe('applied');
	expect(B.ed.insertText('u', 0, 'Q').status).toBe('applied');
	deliver(A, send(B));
	expect(A.ed.blockText('u')).toBe('Q world');
	expect(um.undo()).not.toBe(null);
	deliver(B, send(A));
	for (const r of [A, B]) {
		expect(r.ed.isVisibleBlock('P')).toBe(false);
		expect(r.ed.isVisibleBlock('u')).toBe(true);
		expect(r.ed.blockText('u')).toBe('');
	}
	return { A, B, um };
};

describe('F-D19 late redo (requirement 3): P shows HelloQ world while u keeps z', () => {
	for (const ids of CLIENT_IDS) {
		for (const order of ['xy', 'yx'] as const) {
			red(`A=${ids.a} B=${ids.b} · ${order}`, () => {
				const { A, B, um } = deadBoundary(ids);
				expect(B.ed.insertText('u', 0, 'z').status).toBe('applied');
				expect(um.redo()).not.toBe(null);
				sync(A, B, order);
				const expected = [
					['x', 'x'],
					['P', 'HelloQ world'],
					['u', 'z']
				];
				for (const ed of [A.ed, B.ed, reload(A.doc, 900), reload(B.doc, 901)]) {
					expect(shape(ed)).toEqual(expected);
				}
			});
		}
	}
});

describe('requirements 2+4: concurrent first typing into a boundary-dead streamless block', () => {
	const attributed = (who: 'A' | 'B') => ({ actor: () => (who === 'A' ? alice : bob) });
	for (const ids of CLIENT_IDS) {
		for (const order of ['xy', 'yx'] as const) {
			it(`both typings are kept; createdBy survives — A=${ids.a} B=${ids.b} · ${order}`, () => {
				const { A, B } = deadBoundary(ids, attributed);
				expect(A.ed.blockAttribution('u')?.createdBy).toBe('bob');
				expect(A.ed.insertText('u', 0, 'a').status).toBe('applied');
				expect(B.ed.insertText('u', 0, 'b').status).toBe('applied');
				sync(A, B, order);
				for (const ed of [A.ed, B.ed, reload(A.doc, 900), reload(B.doc, 901)]) {
					const text = ed.blockText('u');
					expect([...text].sort().join('')).toBe('ab');
					expect(text).toBe(A.ed.blockText('u'));
					expect(ed.blockAttribution('u')?.createdBy).toBe('bob');
				}
			});
			red(
				`the own text is written by a writer derived from the dead incarnation — A=${ids.a} B=${ids.b} · ${order}`,
				() => {
					const { A, B } = deadBoundary(ids);
					expect(A.ed.insertText('u', 0, 'a').status).toBe('applied');
					expect(B.ed.insertText('u', 0, 'b').status).toBe('applied');
					const idOf = (r: Replica) => r.ed.resolveBlock('u').getAttr('content')._item.id;
					const [ia, ib] = [idOf(A), idOf(B)];
					expect(ia).toEqual(ib);
					expect([ids.a, ids.b]).not.toContain(ia.client);
					sync(A, B, order);
					expect(idOf(A)).toEqual(ia);
					expect(idOf(B)).toEqual(ia);
				}
			);
		}
	}
});

describe('requirement 5: a split of a block with no text and no claims creates its own text first', () => {
	for (const ids of CLIENT_IDS) {
		for (const order of ['xy', 'yx'] as const) {
			it(`B splits the streamless u at 0 ‖ A types into u — A=${ids.a} B=${ids.b} · ${order}`, () => {
				const { A, B } = deadBoundary(ids);
				expect(B.ed.splitBlock('u', 0, 'w').status).toBe('applied');
				expect(shape(B.ed)).toEqual([
					['x', 'x'],
					['u', ''],
					['w', '']
				]);
				expect(A.ed.insertText('u', 0, 'a').status).toBe('applied');
				sync(A, B, order);
				for (const ed of [A.ed, B.ed, reload(A.doc, 900), reload(B.doc, 901)]) {
					expect(ed.listBlockIds()).toEqual(['x', 'u', 'w']);
					expect(ed.blockText('u') + ed.blockText('w')).toBe('a');
					expect(shape(ed)).toEqual(shape(A.ed));
				}
				// typing into both blocks afterwards lands in each
				expect(B.ed.insertText('w', 0, 'W').status).toBe('applied');
				expect(B.ed.insertText('u', 0, 'U').status).toBe('applied');
				expect(B.ed.blockText('u').startsWith('U')).toBe(true);
				expect(B.ed.blockText('w').startsWith('W')).toBe(true);
			});
		}
	}
});
