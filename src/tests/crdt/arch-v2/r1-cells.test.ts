/**
 * arch-v2 — checkpoint R1 rows: render cells derived from the document index
 * and patched ONLY from the commit change report (plan §2.4 "Render cells",
 * "Segments", "Placeholder attribute"; §4.4 `surface/cells.ts`; K7).
 *
 * Rows (doc lane):
 * - Derivation: the seeded tree equals the projection; after each of split,
 *   merge, move, delete (with and without children), remote text and block
 *   inserts, a format and a type change, the tree still equals a fresh
 *   projection, and the patch replaced EXACTLY the affected cells: every
 *   other cell keeps its object identity.
 * - Exactness over a random corpus (two replicas, both delivery orders,
 *   undo/redo, nested batches): after every commit the patched tree equals
 *   the tree built from scratch (K7: a missed or extra report entry shows).
 * - Proportional patches (F-O5, cell half): one keystroke in a 1,000-block
 *   document replaces one cell.
 * - Segments carry causal keys (the preceding atom's id, or `start`): an edit
 *   in one segment, or an atom inserted before it, never renames another.
 * - Render deltas merge equal marks by value; an empty segment renders none.
 * - The placeholder attribute: one empty text, no live composition in it.
 *
 * Expected values come from the plan rows and a projection-built oracle, never
 * from the code under test.
 */
// @ts-nocheck -- tests drive the vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { setDocRand } from '../../../lib/crdt/rand.js';

// Resolved lazily so the rows load on the reference, where the module does not exist.
const lib = import.meta.glob('../../../lib/surface/cells.ts', { eager: true });
const cellsLib = Object.values(lib)[0] ?? {};
const { createCells, partsOf, renderDeltas, placeholderOf, START } = cellsLib;

/** Red on the reference (`arch-v2/ref-r1`, where `surface/cells` does not exist); green since R1. */
const red = test;

const E = bindEdytorDoc(Y);

/** Deterministic PRNG (mulberry32). */
const rng = (seed: number) => () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const p = (id: string, text: string, children?: unknown[], type = 'paragraph') => ({
	id,
	type,
	content: [{ kind: 'text', text }],
	...(children ? { children } : {})
});

const open = (clientID: number, content?: unknown[], bytes?: Uint8Array) => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	// Ranks and nonces from a stream seeded per client: a run is reproducible.
	setDocRand(doc, rng(clientID * 7919));
	if (bytes) Y.applyUpdate(doc, bytes);
	const ed = E.create(doc);
	if (content) ed.init({ content });
	return { doc, ed };
};

/**
 * Runs compared by what they display: adjacent text runs with equal marks are
 * one (the projection lists a stream's items, the index's runs merge them).
 */
const norm = (runs) =>
	runs.reduce((out, run) => {
		const last = out[out.length - 1];
		if (
			run.kind === 'text' &&
			last?.kind === 'text' &&
			JSON.stringify(last.marks ?? {}) === JSON.stringify(run.marks ?? {})
		)
			out[out.length - 1] = { ...last, text: last.text + run.text };
		else out.push(run);
		return out;
	}, []);

/** The oracle: the visible tree built from scratch from the projection. */
const oracle = (ed) => {
	const cells = {};
	const walk = (nodes) =>
		nodes.forEach((n) => {
			cells[n.id] = {
				type: n.type,
				data: n.data ?? null,
				childIds: n.children.map((c) => c.id),
				runs: norm(n.content)
			};
			walk(n.children);
		});
	const top = ed.project().children;
	walk(top);
	return JSON.parse(JSON.stringify({ rootIds: top.map((n) => n.id), cells }));
};

/** The same shape read from a cell tree (every visible id reached from the root). */
const shape = (tree) => {
	const cells = {};
	const walk = (ids) =>
		ids.forEach((id) => {
			const c = tree.get(id);
			cells[id] = c
				? { type: c.type, data: c.data ?? null, childIds: [...c.childIds], runs: norm(c.runs) }
				: 'missing';
			if (c) walk(c.childIds);
		});
	walk(tree.rootIds);
	return JSON.parse(JSON.stringify({ rootIds: [...tree.rootIds], cells }));
};

/** Mount cells on `ed`, keep the object of every cell before each commit, and record each patch. */
const mount = (ed) => {
	const patches = [];
	const tree = createCells(ed, (patched) => patches.push(new Set(patched)));
	const snapshot = () => new Map(allIds(tree).map((id) => [id, tree.get(id)]));
	return { tree, patches, snapshot };
};

const allIds = (tree) => {
	const out = [];
	const walk = (ids) => ids.forEach((id) => (out.push(id), walk(tree.get(id)?.childIds ?? [])));
	walk(tree.rootIds);
	return out;
};

/**
 * Run `op` and check: the tree equals the oracle; the patch names exactly
 * `expected` (null = the root list); every cell not named keeps its object.
 */
const expectPatch = (ed, m, op, expected: (string | null)[]) => {
	const before = m.snapshot();
	const rootBefore = m.tree.rootIds;
	m.patches.length = 0;
	op();
	expect(shape(m.tree)).toEqual(oracle(ed));
	expect(m.patches.length).toBe(1);
	expect([...m.patches[0]].map(String).sort()).toEqual(expected.map(String).sort());
	for (const [id, cell] of before) {
		if (expected.includes(id) || !m.tree.get(id)) continue;
		expect(m.tree.get(id), `cell ${id} kept its identity`).toBe(cell);
	}
	if (!expected.includes(null)) expect(m.tree.rootIds).toBe(rootBefore);
};

describe('R1 — cells patched exactly from the change report', () => {
	const seed = () =>
		open(1, [p('a', 'alpha', [p('a1', 'one')]), p('b', 'beta'), p('c', 'gamma'), p('d', 'delta')]);

	red('the seeded tree equals the projection', () => {
		const { ed } = seed();
		const m = mount(ed);
		expect(shape(m.tree)).toEqual(oracle(ed));
		expect(m.tree.size).toBe(5);
	});

	red('split: the split block, the new block and their parent list', () => {
		const { ed } = seed();
		const m = mount(ed);
		expectPatch(ed, m, () => ed.splitBlock('b', 2, 'b2'), ['b', 'b2', null]);
		expect(
			m.tree
				.get('b2')
				.runs.map((r) => r.text)
				.join('')
		).toBe('ta');
	});

	red('merge: the surviving block and the list the merged one left', () => {
		const { ed } = seed();
		const m = mount(ed);
		expectPatch(ed, m, () => ed.mergeBlocks('c', 'b'), ['b', null]);
		expect(m.tree.get('c')).toBeUndefined();
		expect(
			m.tree
				.get('b')
				.runs.map((r) => r.text)
				.join('')
		).toBe('betagamma');
	});

	red('move: the two parent lists, never the moved cell', () => {
		const { ed } = seed();
		const m = mount(ed);
		expectPatch(ed, m, () => ed.moveBlock('c', { parent: 'a', index: 0 }), ['a', null]);
		expectPatch(ed, m, () => ed.moveBlock('a1', { parent: 'd', index: 0 }), ['a', 'd']);
	});

	red('delete: the parent list; the subtree cells are gone', () => {
		const { ed } = seed();
		const m = mount(ed);
		expectPatch(ed, m, () => ed.deleteBlock('a'), [null]);
		expect(m.tree.get('a1')).toBeUndefined();
		expect(m.tree.size).toBe(3);
	});

	red('delete keeping children: the children are re-listed and keep their cells', () => {
		const { ed } = seed();
		const m = mount(ed);
		const kid = m.tree.get('a1');
		ed.deleteBlock('a', { keepChildren: true });
		expect(shape(m.tree)).toEqual(oracle(ed));
		expect(m.tree.get('a1')).toBe(kid);
	});

	red('format: only the formatted block; equal marks render one delta', () => {
		const { ed } = seed();
		const m = mount(ed);
		expectPatch(ed, m, () => ed.formatRange('d', 1, 3, { bold: true }), ['d']);
		const [seg] = partsOf(m.tree.get('d').runs);
		expect(renderDeltas(seg.runs)).toEqual([
			{ text: 'd', marks: [] },
			{ text: 'elt', marks: [['bold', true]] },
			{ text: 'a', marks: [] }
		]);
	});

	red('type and data: only the retyped block', () => {
		const { ed } = seed();
		const m = mount(ed);
		expectPatch(ed, m, () => ed.setBlockType('c', 'heading'), ['c']);
		expectPatch(ed, m, () => ed.setBlockData('c', { level: 2 }), ['c']);
		expect(m.tree.get('c').data).toEqual({ level: 2 });
	});

	red('nested batch: one patch for the outer commit', () => {
		const { ed } = seed();
		const m = mount(ed);
		expectPatch(
			ed,
			m,
			() =>
				ed.transact(() => {
					ed.insertText('b', 0, 'x');
					ed.transact(() => ed.splitBlock('d', 1, 'd2'));
				}),
			['b', 'd', 'd2', null]
		);
	});

	// Found by the corpus below (K7): an added subtree carries a block that was
	// visible before and moved into it, retyped and edited in the same commit;
	// the report names it only inside the subtree, and the index must take the
	// subtree's payload as that block's baseline, or a later change back to the
	// old type or text compares equal to the stale baseline and is not reported.
	red('a block moved into an added subtree: its cell follows, later changes are reported', () => {
		const A = open(1, [p('x', 'xx', undefined, 'heading'), p('y', 'yy')]);
		const B = open(2, undefined, Y.encodeStateAsUpdate(A.doc));
		const m = mount(A.ed);
		const reports = [];
		A.ed.onChange((c) => reports.push(c));
		const sv = Y.encodeStateVector(A.doc);
		B.ed.insertBlock({ parent: null, index: 0 }, { id: 'z', type: 'paragraph' });
		B.ed.setBlockType('x', 'paragraph');
		B.ed.insertText('x', 2, '!');
		B.ed.moveBlock('x', { parent: 'z', index: 0 });
		Y.applyUpdate(A.doc, Y.encodeStateAsUpdate(B.doc, sv), 'remote');
		expect(shape(m.tree)).toEqual(oracle(A.ed));
		expect([...m.patches.at(-1)].sort()).toEqual([null, 'x', 'z'].sort());
		reports.length = 0;
		A.ed.transact(() => {
			A.ed.setBlockType('x', 'heading');
			A.ed.deleteText('x', 2, 1);
		});
		expect(reports.map((r) => [[...r.meta.keys()], [...r.content.keys()]])).toEqual([
			[['x'], ['x']]
		]);
		expect(shape(m.tree)).toEqual(oracle(A.ed));
	});

	red('remote text insert and remote block insert', () => {
		const A = seed();
		const B = open(2, undefined, Y.encodeStateAsUpdate(A.doc));
		const m = mount(A.ed);
		const send = (fn) => {
			const sv = Y.encodeStateVector(A.doc);
			fn();
			Y.applyUpdate(A.doc, Y.encodeStateAsUpdate(B.doc, sv), 'remote');
		};
		expectPatch(A.ed, m, () => send(() => B.ed.insertText('a1', 3, '!')), ['a1']);
		expectPatch(
			A.ed,
			m,
			() => send(() => B.ed.insertBlock({ parent: 'a', index: 1 }, { id: 'n', type: 'paragraph' })),
			['a', 'n']
		);
		expect(A.ed.toJSON()).toEqual(B.ed.toJSON());
	});

	red('one keystroke in 1,000 blocks replaces one cell (F-O5, cell half)', () => {
		const content = Array.from({ length: 1000 }, (_, i) => p(`k${i}`, `line ${i}`));
		const { ed } = open(1, content);
		const m = mount(ed);
		expectPatch(ed, m, () => ed.insertText('k500', 2, 'x'), ['k500']);
		m.patches.length = 0;
		ed.transact(() => {
			for (let i = 0; i < 1000; i += 2) ed.deleteBlock(`k${i}`);
		});
		expect(m.patches.length).toBe(1);
		expect(m.tree.size).toBe(500);
		expect(shape(m.tree)).toEqual(oracle(ed));
	});
});

// ── exactness over a random corpus (K7) ─────────────────────────────────────

describe('R1 — patched cells equal a fresh build after every commit (K7)', () => {
	// `R1_CELLS_SEEDS=1-200` widens the corpus (client ids cycle through the three assignments).
	const [from, to] = (process.env.R1_CELLS_SEEDS ?? '1-3').split('-').map(Number);
	const assignments = [
		[7, 3],
		[3, 7],
		[100, 50]
	];
	const runs = Array.from({ length: to - from + 1 }, (_, i) => [
		from + i,
		...assignments[(from + i - 1) % 3]
	]);
	for (const [seed, mine, theirs] of runs) {
		red(`seed ${seed}, clients ${mine}/${theirs}`, () => {
			const rand = rng(seed * 131);
			const pick = (xs) => xs[Math.floor(rand() * xs.length)];
			const A = open(mine, [
				p('a', 'alpha', [p('a1', 'one', [p('a2', 'two')])]),
				p('b', 'beta'),
				p('c', ''),
				p('box', 'isle', [p('in', 'side')], 'box'),
				p('d', 'delta', [p('d1', 'deep')])
			]);
			const B = open(theirs, undefined, Y.encodeStateAsUpdate(A.doc));
			let toA = [];
			let toB = [];
			A.doc.on('update', (u, origin) => origin !== 'remote' && toB.push(u));
			B.doc.on('update', (u, origin) => origin !== 'remote' && toA.push(u));
			const um = A.ed.createUndoManager({ captureTimeout: 0 });
			const bad = [];
			let commits = 0;
			// The last report, for a failure's message (subscribed before the cells).
			let last = null;
			A.ed.onChange((c) => (last = c));
			const tree = createCells(A.ed, () => {
				commits++;
				const want = oracle(A.ed);
				const got = shape(tree);
				if (JSON.stringify(want) === JSON.stringify(got)) return;
				// Name only what differs: the root list and the cells that disagree.
				const ids = new Set([...Object.keys(want.cells), ...Object.keys(got.cells)]);
				const cells = [...ids]
					.filter((id) => JSON.stringify(want.cells[id]) !== JSON.stringify(got.cells[id]))
					.map((id) => ({ id, want: want.cells[id], got: got.cells[id] }));
				const named = (m) => [...m.keys()].filter((id) => ids.has(id) || id === null);
				const report = {
					origin: String(last.origin),
					added: named(last.added),
					removed: [...last.removed],
					meta: [...last.meta].filter(([id]) => ids.has(id)),
					content: named(last.content),
					order: [...last.order]
				};
				bad.push({ commits, rootIds: [want.rootIds, got.rootIds], cells, report });
			});
			let fresh = 0;
			const freshId = () => `n${seed}-${fresh++}`;
			const opsFor = (ed) => {
				const id = () => pick([...ed.listBlockIds(), 'ghost']);
				const off = () => Math.floor(rand() * 8) - 1;
				const dest = () => ({ parent: rand() < 0.5 ? null : id(), index: Math.floor(rand() * 4) });
				const atomIn = (b) =>
					(ed.hasBlock(b) ? ed.contentItems(b) : []).find((i) => i.kind === 'inline')?.id ?? 'x';
				return [
					() => ed.insertBlock(dest(), { id: freshId(), type: 'paragraph' }),
					() => ed.insertBlocks(dest(), [p(freshId(), 'x', [p(freshId(), 'y')])]),
					() => ed.moveBlock(id(), dest()),
					() => ed.nestBlock(id(), id()),
					() => ed.unNestBlock(id()),
					() => ed.splitBlock(id(), off(), freshId()),
					() => ed.mergeBlocks(id(), id()),
					() => ed.mergeBackward(id()),
					() => ed.deleteBlock(id(), { keepChildren: rand() < 0.4 }),
					() => ed.setBlockType(id(), pick(['paragraph', 'heading'])),
					() => ed.setBlockData(id(), pick([{}, { level: 1 }])),
					() => ed.insertText(id(), off(), pick(['q', 'zz']), pick([undefined, { bold: true }])),
					() => ed.deleteText(id(), off(), Math.floor(rand() * 4)),
					() => ed.formatRange(id(), off(), 2, { italic: pick([true, null]) }),
					() => ed.insertInline(id(), off(), { id: freshId(), type: 'mention' }),
					() => {
						const b = id();
						return ed.removeInline(b, atomIn(b));
					}
				];
			};
			const deliver = (queue, doc) => {
				if (rand() < 0.5) for (const u of queue) Y.applyUpdate(doc, u, 'remote');
				else if (queue.length) Y.applyUpdate(doc, Y.mergeUpdates(queue), 'remote');
			};
			for (let step = 0; step < 300; step++) {
				const r = rand();
				if (r < 0.45) pick(opsFor(A.ed))();
				else if (r < 0.55)
					A.ed.transact(() => {
						pick(opsFor(A.ed))();
						A.ed.transact(() => pick(opsFor(A.ed))());
					});
				else if (r < 0.62) um.undo();
				else if (r < 0.66) um.redo();
				else if (r < 0.85) for (let k = 0; k < 3; k++) pick(opsFor(B.ed))();
				else {
					const [qa, qb] = [toA, toB];
					toA = [];
					toB = [];
					if (rand() < 0.5) {
						deliver(qa, A.doc);
						deliver(qb, B.doc);
					} else {
						deliver(qb, B.doc);
						deliver(qa, A.doc);
					}
				}
				if (A.ed.listBlockIds().length < 3)
					A.ed.insertBlocks({ parent: null, index: 0 }, [p(freshId(), 'refill')]);
			}
			deliver(toA, A.doc);
			expect(bad.slice(0, 1)).toEqual([]);
			expect(commits).toBeGreaterThan(100);
			tree.dispose();
		});
	}
});

// ── segments, render deltas, placeholder ───────────────────────────────────

describe('R1 — segments keyed causally; render deltas; placeholder', () => {
	const atom = (id) => ({ kind: 'inline', id, type: 'mention' });
	const make = () =>
		open(1, [
			{
				id: 's',
				type: 'paragraph',
				content: [
					{ kind: 'text', text: 'ab' },
					atom('m1'),
					{ kind: 'text', text: 'cd' },
					atom('m2')
				]
			},
			p('e', '')
		]);
	const keys = (tree, id) => partsOf(tree.get(id).runs).map((part) => part.key);

	red('segments alternate with atoms and are keyed by the atom before them', () => {
		const { ed } = make();
		const m = mount(ed);
		const parts = partsOf(m.tree.get('s').runs);
		expect(parts.map((x) => [x.kind, x.key, x.kind === 'text' ? x.text : x.id])).toEqual([
			['text', START, 'ab'],
			['inline', 'm1', 'm1'],
			['text', 'm1', 'cd'],
			['inline', 'm2', 'm2'],
			['text', 'm2', '']
		]);
		expect(partsOf(m.tree.get('e').runs).map((x) => [x.key, x.text])).toEqual([[START, '']]);
	});

	red('an edit or an atom elsewhere never renames a segment', () => {
		const { ed } = make();
		const m = mount(ed);
		ed.insertText('s', 4, 'X'); // inside the `m1` segment
		expect(keys(m.tree, 's')).toEqual([START, 'm1', 'm1', 'm2', 'm2']);
		ed.insertInline('s', 1, { id: 'm0', type: 'mention' }); // before `m1`
		expect(keys(m.tree, 's')).toEqual([START, 'm0', 'm0', 'm1', 'm1', 'm2', 'm2']);
		ed.removeInline('s', 'm1'); // the `m1` segment joins the `m0` one
		expect(keys(m.tree, 's')).toEqual([START, 'm0', 'm0', 'm2', 'm2']);
		expect(partsOf(m.tree.get('s').runs)[2].text).toBe('bcXd');
	});

	red('render deltas merge equal marks by value and skip empty runs', () => {
		expect(
			renderDeltas([
				{ text: 'a', marks: { bold: true } },
				{ text: '', marks: { italic: true } },
				{ text: 'b', marks: { bold: true } },
				{ text: 'c', marks: { link: { href: 'x' } } },
				{ text: 'd', marks: { link: { href: 'x' }, u: undefined } },
				{ text: 'e' }
			])
		).toEqual([
			{ text: 'ab', marks: [['bold', true]] },
			{ text: 'cd', marks: [['link', { href: 'x' }]] },
			{ text: 'e', marks: [] }
		]);
		expect(renderDeltas([])).toEqual([]);
	});

	red('the placeholder: one empty text and no live composition in it', () => {
		const { ed } = make();
		const m = mount(ed);
		expect(placeholderOf(m.tree.get('e'), false)).toBe(true);
		expect(placeholderOf(m.tree.get('e'), true)).toBe(false);
		expect(placeholderOf(m.tree.get('s'), false)).toBe(false);
		ed.insertText('e', 0, 'x');
		expect(placeholderOf(m.tree.get('e'), false)).toBe(false);
	});
});
