/**
 * arch-v2 — checkpoint D5 rows: every document operation is prepared, then
 * applied (rule R6, §2.4 "Prepared plan", O10, D46; FP-6).
 *
 * `document.prepare.<op>(…)` is pure against the current version: it returns
 * `refused` (an op result) or a plan `{ids, writes, effect, version}` whose
 * `writes` are named steps (the documented operation names) and whose
 * `effect` summarizes what applying it does — blocks created, removed,
 * merged, moved, retyped (`meta`) and the text ranges it writes.
 * `document.apply(plan)` writes exactly that plan; the observed result
 * (`noop | applied`) still comes from the transaction (D4).
 *
 * Rows (doc lane):
 * - F-O11 — `prepare` over the random corpus: zero bytes, no update, no
 *   state-vector advance; applying the plan changes exactly what its effect
 *   summary names. The touched set is observed test-side from the document
 *   before and after the apply, never from the op's result or its plan:
 *   created = new registry entries; removed = live before, gone after, not
 *   merged away; merged = self-displaying before, displayed by another live
 *   block after; moved = a placement candidate written; meta = type or data
 *   changed; text = the block's displayed atoms (identity, content, marks)
 *   changed.
 * - Composites compose prepared plans (the D5 row): the steps and effects of
 *   an island merged out of its parent, a delete keeping its children, a
 *   delete hiding its subtree, a split carrying children; a refused
 *   composite refuses before any write; a plan applied at another version
 *   is rejected.
 *
 * Expected values come from the plan rows and the contracts they cite, never
 * from running the code.
 */
// @ts-nocheck -- tests drive the vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';

const E = bindEdytorDoc(Y);

/** Red on the reference (no `prepare`/`apply`): expected-fail until the implementation lands. */
const row = test.fails;

const p = (id: string, text: string, children?: unknown[], type = 'paragraph') => ({
	id,
	type,
	content: [{ kind: 'text', text }],
	...(children ? { children } : {})
});

const roles = (t: string) =>
	t === 'box' ? { island: true } : t === 'img' ? { void: true } : undefined;

const make = (content: unknown[], clientID = 7) => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	const ed = E.create(doc, { actor: () => ({ id: 'alice' }), lineageDepth: 3, roleOf: roles });
	ed.init({ content });
	return { doc, ed };
};

const svEqual = (a: Uint8Array, b: Uint8Array) =>
	a.length === b.length && a.every((x, i) => x === b[i]);

/** Run `fn`; report whether anything left the document. */
const observe = (doc: Y.Doc, fn: () => unknown) => {
	const sv0 = Y.encodeStateVector(doc);
	const bytes0 = Y.encodeStateAsUpdate(doc);
	let updates = 0;
	const count = () => updates++;
	doc.on('update', count);
	let result: unknown;
	try {
		result = fn();
	} finally {
		doc.off('update', count);
	}
	return {
		result,
		updates,
		untouched: svEqual(sv0, Y.encodeStateVector(doc)) && svEqual(bytes0, Y.encodeStateAsUpdate(doc))
	};
};

const isPlan = (x: unknown) => x !== null && typeof x === 'object' && 'writes' in (x as object);

/** Per-block facts read from the document (test-side; independent of the op). */
const facts = (ed, doc) => {
	const v = ed.model.view(doc);
	const out = new Map();
	for (const [id, rec] of v.blocks) {
		const live = ed.isVisibleBlock(id);
		const len = live ? ed.displayLength(id) : 0;
		const atoms = [];
		for (let k = 0; k < len; k++) {
			const a = ed.anchorAt(id, k, 'right');
			atoms.push(a ? [a.b, a.a.i?.c, a.a.i?.k] : null);
		}
		out.set(id, {
			live,
			owner: v.own.ownerOf(id),
			meta: JSON.stringify([rec.node.getAttr('type'), rec.node.getAttr('data') ?? null]),
			at: JSON.stringify(ed.model.candidatesOf(rec.node).map((c) => c.key)),
			text: live ? JSON.stringify([ed.contentItems(id), atoms]) : null
		});
	}
	return out;
};

/** What changed between two fact snapshots, in the effect summary's vocabulary. */
const touched = (before: Map, after: Map) => {
	const t = { creates: [], removes: [], merges: [], moves: [], meta: [], text: [] };
	for (const [id, a] of after) {
		const b = before.get(id);
		if (b === undefined) {
			t.creates.push(id);
			continue;
		}
		const mergedInto =
			b.live && b.owner === id && typeof a.owner === 'string' && a.owner !== id ? a.owner : null;
		if (mergedInto !== null) t.merges.push(`${id}>${mergedInto}`);
		else if (b.live && !a.live) t.removes.push(id);
		if (b.at !== a.at) t.moves.push(id);
		if (b.meta !== a.meta) t.meta.push(id);
		if (b.live && a.live && b.text !== a.text) t.text.push(id);
	}
	return t;
};

const set = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** The effect summary in the same vocabulary. */
const predicted = (effect) => ({
	creates: set(effect.creates),
	removes: set(effect.removes),
	merges: set(effect.merges.map(([from, into]) => `${from}>${into}`)),
	moves: set(effect.moves),
	meta: set(effect.meta),
	text: set(effect.textRanges.map((r) => r.block))
});

/** Prepare (must write nothing), apply, and compare the effect with what changed. */
const prepareApply = (ed, doc, name: string, prepare: () => unknown, label = name) => {
	const prepared = observe(doc, prepare);
	expect(prepared.updates, `${label}: prepare writes nothing`).toBe(0);
	expect(prepared.untouched, `${label}: prepare leaves zero bytes, no state-vector advance`).toBe(
		true
	);
	const plan = prepared.result as { status?: string };
	if (!isPlan(plan)) {
		expect(plan.status, `${label}: not a plan ⇒ refused`).toBe('refused');
		const refusedApply = observe(doc, () => ed.apply(plan));
		expect(refusedApply.result.status).toBe('refused');
		expect(refusedApply.untouched, `${label}: a refusal writes nothing`).toBe(true);
		return { status: 'refused' };
	}
	for (const w of plan.writes) expect(typeof w.op, `${label}: named step`).toBe('string');
	const before = facts(ed, doc);
	const applied = observe(doc, () => ed.apply(plan));
	const after = facts(ed, doc);
	const r = applied.result as { status: string; ids: string[] };
	const want = predicted(plan.effect);
	const got = touched(before, after);
	expect(
		{ creates: set(got.creates), removes: set(got.removes), merges: set(got.merges) },
		`${label}: structure`
	).toEqual({ creates: want.creates, removes: want.removes, merges: want.merges });
	expect({ moves: set(got.moves), meta: set(got.meta) }, `${label}: placements and meta`).toEqual({
		moves: want.moves,
		meta: want.meta
	});
	expect(set(got.text), `${label}: text`).toEqual(want.text);
	const empty = Object.values(want).every((xs) => xs.length === 0);
	expect(r.status, `${label}: effect empty ⇔ noop`).toBe(empty ? 'noop' : 'applied');
	if (r.status === 'applied') expect(r.ids, `${label}: ids`).toEqual(plan.ids);
	return r;
};

/** Deterministic PRNG (mulberry32). */
const rng = (seed: number) => () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ── F-O11 — prepare over the random corpus ────────────────────────────────

describe('F-O11 — prepare is pure; the effect summary equals what the applied plan changed', () => {
	for (const seed of [1, 2, 3]) {
		row(`seed ${seed}`, () => {
			const rand = rng(seed);
			const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
			const { doc, ed } = make(
				[
					p('a', 'alpha', [p('a1', 'one')]),
					p('b', 'beta'),
					p('c', ''),
					p('box', 'isle', [p('in', 'side', undefined, 'line')], 'box'),
					p('d', 'delta')
				],
				seed + 60
			);
			let fresh = 0;
			const freshId = () => `n${seed}-${fresh++}`;
			const ids = () => [...ed.listBlockIds(), 'ghost', pick(ed.listBlockIds().concat(['a']))];
			const id = () => pick(ids());
			const off = () => Math.floor(rand() * 8) - 1;
			const len = () => Math.floor(rand() * 4);
			const dest = () => ({ parent: rand() < 0.5 ? null : id(), index: Math.floor(rand() * 4) });
			const inlineIn = (b: string) =>
				(ed.hasBlock(b) ? ed.contentItems(b) : []).find((i) => i.kind === 'inline')?.id ??
				'no-atom';
			const P = ed.prepare;

			const OPS: [string, () => unknown][] = [
				[
					'insertBlock',
					() => P.insertBlock(dest(), { id: rand() < 0.2 ? id() : freshId(), type: 'paragraph' })
				],
				[
					'insertBlocks',
					() => P.insertBlocks(dest(), rand() < 0.3 ? [] : [p(freshId(), 'x', [p(freshId(), 'y')])])
				],
				['moveBlock', () => P.moveBlock(id(), dest())],
				['moveBlocks', () => P.moveBlocks(rand() < 0.2 ? [] : [id(), id()], dest())],
				['nestBlock', () => P.nestBlock(id(), id())],
				['unNestBlock', () => P.unNestBlock(id())],
				['splitBlock', () => P.splitBlock(id(), off(), rand() < 0.2 ? id() : freshId())],
				['mergeBlocks', () => P.mergeBlocks(id(), id())],
				['mergeBackward', () => P.mergeBackward(id())],
				['mergeForward', () => P.mergeForward(id())],
				['deleteBlock', () => P.deleteBlock(id(), { keepChildren: rand() < 0.4 })],
				['setBlockType', () => P.setBlockType(id(), pick(['paragraph', 'heading']))],
				['setBlockData', () => P.setBlockData(id(), pick([{}, { level: 1 }]))],
				[
					'setBlock',
					() =>
						P.setBlock(id(), {
							type: pick([undefined, 'paragraph', 'heading']),
							data: pick([undefined, { level: 2 }]),
							content:
								rand() < 0.5
									? undefined
									: pick([
											[{ kind: 'text', text: '' }],
											[{ kind: 'text', text: 'set' }],
											[
												{ kind: 'text', text: 's', marks: { bold: true } },
												{ kind: 'inline', id: freshId(), type: 'mention' }
											]
										]),
							children:
								rand() < 0.6
									? undefined
									: [{ id: rand() < 0.3 ? id() : freshId(), type: 'paragraph' }]
						})
				],
				['duplicateBlock', () => P.duplicateBlock(id(), () => freshId())],
				[
					'insertText',
					() => P.insertText(id(), off(), pick(['', 'q', 'zz']), pick([undefined, { bold: true }]))
				],
				['deleteText', () => P.deleteText(id(), off(), len())],
				['setMark', () => P.setMark(id(), off(), len(), 'bold', true)],
				['unsetMark', () => P.unsetMark(id(), off(), len(), 'bold')],
				['formatRange', () => P.formatRange(id(), off(), len(), { italic: pick([true, null]) })],
				['clearMarks', () => P.clearMarks(id(), off(), len())],
				['insertInline', () => P.insertInline(id(), off(), { id: freshId(), type: 'mention' })],
				[
					'removeInline',
					() => {
						const b = id();
						return P.removeInline(b, inlineIn(b));
					}
				],
				[
					'setInlineData',
					() => {
						const b = id();
						return P.setInlineData(b, inlineIn(b), pick([{}, { v: 1 }]));
					}
				]
			];

			const seen = { refused: 0, noop: 0, applied: 0 };
			for (let step = 0; step < 300; step++) {
				const [name, prepare] = pick(OPS);
				const r = prepareApply(ed, doc, name, prepare, `${step} ${name}`);
				seen[r.status]++;
				if (ed.listBlockIds().length < 3)
					ed.insertBlocks({ parent: null, index: 0 }, [p(freshId(), 'refill')]);
			}
			expect(seen.refused).toBeGreaterThan(0);
			expect(seen.noop).toBeGreaterThan(0);
			expect(seen.applied).toBeGreaterThan(0);
		});
	}
});

// ── composites compose prepared plans ─────────────────────────────────────

describe('D5 — composites are prepared as one plan of named steps', () => {
	const ops = (plan) => plan.writes.map((w) => w.op);

	row('an island merged out of its parent: unnest, reset, merge — one plan', () => {
		const { doc, ed } = make([
			p('a', 'aa'),
			p('box', 'bb', [p('c', 'cc', undefined, 'line')], 'box')
		]);
		const plan = ed.prepare.mergeBackward('box');
		expect(ops(plan)).toEqual(['moveBlocks', 'setBlockType', 'mergeBlocks']);
		expect(plan.effect).toEqual({
			creates: [],
			removes: [],
			merges: [['box', 'a']],
			moves: ['c'],
			meta: ['c'],
			textRanges: [{ block: 'a', offset: 2, length: 2 }]
		});
		prepareApply(ed, doc, 'mergeBackward', () => ed.prepare.mergeBackward('box'));
		expect(ed.toJSON().children.map((b) => [b.id, b.type])).toEqual([
			['a', 'paragraph'],
			['c', 'paragraph']
		]);
		expect(ed.blockText('a')).toBe('aabb');
	});

	row('delete keeping children: move them out, then delete — the children are not removed', () => {
		const { doc, ed } = make([p('x', 'xx', [p('y', 'yy')]), p('z', 'zz')]);
		const plan = ed.prepare.deleteBlock('x', { keepChildren: true });
		expect(ops(plan)).toEqual(['moveBlocks', 'deleteBlock']);
		expect(plan.effect.removes).toEqual(['x']);
		expect(plan.effect.moves).toEqual(['y']);
		prepareApply(ed, doc, 'deleteBlock', () => ed.prepare.deleteBlock('x', { keepChildren: true }));
		expect(ed.listBlockIds()).toEqual(['y', 'z']);
	});

	row('delete hides the subtree: every block that leaves the document is in removes', () => {
		const { doc, ed } = make([p('x', 'xx', [p('y', 'yy', [p('w', 'ww')])]), p('z', 'zz')]);
		const plan = ed.prepare.deleteBlock('x');
		expect(ops(plan)).toEqual(['deleteBlock']);
		expect([...plan.effect.removes].sort()).toEqual(['w', 'x', 'y']);
		prepareApply(ed, doc, 'deleteBlock', () => ed.prepare.deleteBlock('x'));
		expect(ed.listBlockIds()).toEqual(['z']);
	});

	row('a split carrying children: split, then the children follow the new block', () => {
		const { doc, ed } = make([p('a', 'ab', [p('k', 'kk')])]);
		const plan = ed.prepare.splitBlock('a', 1, 'n');
		expect(ops(plan)).toEqual(['splitBlock', 'moveBlocks']);
		expect(plan.effect).toEqual({
			creates: ['n'],
			removes: [],
			merges: [],
			moves: ['k'],
			meta: [],
			textRanges: [{ block: 'a', offset: 1, length: 1 }]
		});
		prepareApply(ed, doc, 'splitBlock', () => ed.prepare.splitBlock('a', 1, 'n'));
		expect(ed.toJSON().children.map((b) => [b.id, (b.children ?? []).map((c) => c.id)])).toEqual([
			['a', []],
			['n', ['k']]
		]);
	});

	row('a refused composite refuses before any write', () => {
		const { doc, ed } = make([p('b', 'bb', [p('c1', 'one')])]);
		const seen = observe(doc, () =>
			ed.prepare.setBlock('b', {
				type: 'heading',
				content: [{ kind: 'text', text: 'new' }],
				children: [{ id: 'c1', type: 'paragraph' }]
			})
		);
		expect(seen.result).toEqual({ status: 'refused', ids: [], reason: 'id-collision' });
		expect(seen.untouched).toBe(true);
	});

	row('a plan is valid only at the version it was prepared against', () => {
		const { ed } = make([p('a', 'aa')]);
		const plan = ed.prepare.insertText('a', 2, 'x');
		ed.insertText('a', 0, 'y');
		expect(() => ed.apply(plan)).toThrow(/plan/);
		expect(ed.blockText('a')).toBe('yaa');
	});

	row('the op is its prepared plan applied', () => {
		const one = make([p('a', 'ab', [p('k', 'kk')]), p('b', 'cd')]);
		const two = make([p('a', 'ab', [p('k', 'kk')]), p('b', 'cd')]);
		const r1 = one.ed.mergeForward('a');
		const r2 = two.ed.apply(two.ed.prepare.mergeForward('a'));
		expect(r1).toEqual(r2);
		expect(one.ed.toJSON()).toEqual(two.ed.toJSON());
	});
});
