/**
 * arch-v2 — checkpoint D6 rows: range deletion is one prepared document
 * operation between two positions, its merges governed by `canMerge`
 * (rules R5, R6; §4.1 `doc/rangeDelete`; §5 L40, L41).
 *
 * Rows (doc lane; the dom half of F-D12 lives in
 * `src/tests/fixtures/dom/range-delete-containers.test.tsx`):
 * - every `del.range.*` row of `docs/editor-delete-contract.md`, on the
 *   document (`prepare.deleteRange` → `apply`), with the caret the op
 *   reports (`del.range.caret`);
 * - F-D1 — `root > [box(island) > [A "aa"], Y "yy"]` (and one level deeper
 *   inside `X`); select A@1 → Y@1; delete → `[box > [A "a"], Y "y"]`: the
 *   island seal refuses the merge `del.range.flat` would do; `mergeForward(A)`
 *   refuses the same way. Also on the view path (the P2 probe): red on the
 *   reference (`box > [A "ay"]`, Y deleted);
 * - F-D12 — `[ordered-list > [i1 "one", i2 "two"], P "three"]`; select
 *   i1@0 → P@2 → `[P "ree"]`, caret P@0, no empty container (P5: red on the
 *   reference view path);
 * - F-O5 (document half) — range delete and selected-block delete over
 *   1,000 paragraphs: document work linear in the blocks removed (operation
 *   counts, CC-05; the timings are `bench:crdt`'s).
 *
 * Expected values come from the contract rows and the plan rows, never from
 * running the code. `del.range.outside-survives`, `del.range.island-seal`,
 * `del.range.empty-container`, `del.range.replace` and `del.range.caret`
 * were written into the contract at D6 (the plan's "write the row first").
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, test } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { createDocument } from '../../../lib/crdt/index.js';
import { indexChecks } from '../../../lib/crdt/text/runs.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { prepareApply, rng } from './prepared-oracle.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';

/** Red on the reference (no `prepare.deleteRange`); green since D6. */
const row = test;

const noopSnippet = (() => null) as never;
const boxPlugin = () => ({
	blocks: { box: { snippet: noopSnippet, island: true }, line: { snippet: noopSnippet } }
});

const SEMANTICS = {
	roles: { box: { island: true } },
	rendersContent: { 'ordered-list': false },
	defaultChild: { 'ordered-list': 'list-item' }
};

const b = (id: string, text: string, children?: unknown[], type = 'paragraph') => ({
	id,
	type,
	content: text === '' ? [] : [{ text }],
	...(children ? { children } : {})
});

const make = (children: unknown[]) =>
	createDocument({ value: { children }, semantics: SEMANTICS }).facade;

/** `[id, type, text, children?]` per block — the full recursive tree. */
const shape = (blocks) =>
	blocks.map((x) => {
		const text = (x.content ?? []).map((part) => part.text ?? '').join('');
		const out = [x.id, x.type, text];
		if (x.children?.length) out.push(shape(x.children));
		return out;
	});
const tree = (f) => shape(f.toJSON().children);

/** Prepare the range delete, apply it, return `{result, at}`. */
const del = (f, [sb, so], [eb, eo], op = 'deleteRange') => {
	const plan = f.prepare[op]({ block: sb, offset: so }, { block: eb, offset: eo });
	const result = f.apply(plan);
	return { result, at: plan.at };
};

const threeFlat = () => make([b('a', 'aa'), b('b', 'bb'), b('c', 'cc')]);
const P = (id: string, text: string) => [id, 'paragraph', text];

describe('del.range.flat — flat siblings', () => {
	row('both partial: the tail suffix merges into the head (alpha@2 → beta@2)', () => {
		const f = make([b('alpha', 'alpha'), b('beta', 'beta')]);
		const { result, at } = del(f, ['alpha', 2], ['beta', 2]);
		expect(result.status).toBe('applied');
		expect(tree(f)).toEqual([P('alpha', 'alta')]);
		expect(at).toEqual({ block: 'alpha', offset: 2 });
	});

	row('[a@1→b@1] → "ab","cc"', () => {
		const f = threeFlat();
		del(f, ['a', 1], ['b', 1]);
		expect(tree(f)).toEqual([P('a', 'ab'), P('c', 'cc')]);
	});

	row('[a@1→c@1] nonadjacent → "ac": the interior block dies', () => {
		const f = threeFlat();
		const { at } = del(f, ['a', 1], ['c', 1]);
		expect(tree(f)).toEqual([P('a', 'ac')]);
		expect(at).toEqual({ block: 'a', offset: 1 });
	});

	row('[a@1→b@2] → "a","cc": the tail dies on an empty suffix', () => {
		const f = threeFlat();
		del(f, ['a', 1], ['b', 2]);
		expect(tree(f)).toEqual([P('a', 'a'), P('c', 'cc')]);
	});

	// D6 fix: the document op does not canonicalize an end at the tail's start —
	// the range covers the seam (del.range.flat, `yEnd == 0`; the selection's
	// canonical form gives the contract's `"aa","cc"` / `"","bb","cc"` examples).
	row('yEnd == 0 at the op: [a@2→c@0] covers the seam → "aacc"', () => {
		const f = threeFlat();
		const { at } = del(f, ['a', 2], ['c', 0]);
		expect(tree(f)).toEqual([P('a', 'aacc')]);
		expect(at).toEqual({ block: 'a', offset: 2 });
	});

	row('yEnd == 0 at the op, adjacent: [a@2→b@0] joins the seam → "aabb"', () => {
		const f = threeFlat();
		del(f, ['a', 2], ['b', 0]);
		expect(tree(f)).toEqual([P('a', 'aabb'), P('c', 'cc')]);
	});

	row('yEnd == 0 at the op, empty head prefix: [a@0→b@0] → the tail survives whole', () => {
		const f = threeFlat();
		const { at } = del(f, ['a', 0], ['b', 0]);
		expect(tree(f)).toEqual([P('b', 'bb'), P('c', 'cc')]);
		expect(at).toEqual({ block: 'b', offset: 0 });
	});

	row('the canonical forms of those ranges give the contract examples', () => {
		const f = threeFlat();
		del(f, ['a', 2], ['b', 2]);
		expect(tree(f)).toEqual([P('a', 'aa'), P('c', 'cc')]);
		const g = threeFlat();
		del(g, ['a', 0], ['a', 2]);
		expect(tree(g)).toEqual([P('a', ''), P('b', 'bb'), P('c', 'cc')]);
	});

	row('the positions may be given end first (a reversed selection)', () => {
		const f = threeFlat();
		del(f, ['b', 1], ['a', 1]);
		expect(tree(f)).toEqual([P('a', 'ab'), P('c', 'cc')]);
	});
});

describe('del.range.whole-text / text-only — within one block', () => {
	row('b@0 → b@2: the block survives empty', () => {
		const f = threeFlat();
		const { at } = del(f, ['b', 0], ['b', 2]);
		expect(tree(f)).toEqual([P('a', 'aa'), P('b', ''), P('c', 'cc')]);
		expect(at).toEqual({ block: 'b', offset: 0 });
	});

	row('alpha@1 → alpha@3 → "aha"', () => {
		const f = make([b('alpha', 'alpha')]);
		del(f, ['alpha', 1], ['alpha', 3]);
		expect(tree(f)).toEqual([P('alpha', 'aha')]);
	});

	row('a collapsed range is a noop', () => {
		const f = threeFlat();
		const { result, at } = del(f, ['b', 1], ['b', 1]);
		expect(result.status).toBe('noop');
		expect(at).toEqual({ block: 'b', offset: 1 });
	});
});

describe('del.range.flat.head-empty / tail-empty / whole-doc', () => {
	row('head-empty: alpha@0 → beta@1 → [beta "eta"], caret at the seam', () => {
		const f = make([b('alpha', 'alpha'), b('beta', 'beta')]);
		const { at } = del(f, ['alpha', 0], ['beta', 1]);
		expect(tree(f)).toEqual([P('beta', 'eta')]);
		expect(at).toEqual({ block: 'beta', offset: 0 });
	});

	row('tail-empty: alpha@2 → beta@4 → [alpha "al"]', () => {
		const f = make([b('alpha', 'alpha'), b('beta', 'beta')]);
		del(f, ['alpha', 2], ['beta', 4]);
		expect(tree(f)).toEqual([P('alpha', 'al')]);
	});

	row('full head + partial-to-end tail: both die, the untouched sibling remains', () => {
		const f = threeFlat();
		const { at } = del(f, ['a', 0], ['b', 2]);
		expect(tree(f)).toEqual([P('c', 'cc')]);
		expect(at).toEqual({ block: 'c', offset: 0 });
	});

	row('both die with a block before: the caret lands at its end', () => {
		const f = threeFlat();
		const { at } = del(f, ['b', 0], ['c', 2]);
		expect(tree(f)).toEqual([P('a', 'aa')]);
		expect(at).toEqual({ block: 'a', offset: 2 });
	});

	row('whole-doc: the head survives, emptied (no block is written)', () => {
		const f = threeFlat();
		const plan = f.prepare.deleteRange({ block: 'a', offset: 0 }, { block: 'c', offset: 2 });
		expect(plan.effect.creates).toEqual([]);
		expect(f.apply(plan).status).toBe('applied');
		expect(tree(f)).toEqual([P('a', '')]);
		expect(plan.at).toEqual({ block: 'a', offset: 0 });
	});

	row('whole-doc from a nested head: the head keeps its container and type', () => {
		const f = make([
			b(
				'ol',
				'',
				[b('i1', 'one', undefined, 'list-item'), b('i2', 'two', undefined, 'list-item')],
				'ordered-list'
			),
			b('z', 'zed')
		]);
		const { at } = del(f, ['i1', 0], ['z', 3]);
		expect(tree(f)).toEqual([['ol', 'ordered-list', '', [['i1', 'list-item', '']]]]);
		expect(at).toEqual({ block: 'i1', offset: 0 });
	});
});

describe('del.range.nested-tail / nested-subtree', () => {
	const nested = (items = [b('beta', 'beta', undefined, 'list-item')]) =>
		make([b('alpha', 'alpha'), b('ol', '', items, 'ordered-list'), b('omega', 'omega')]);

	// The list is no ancestor the range dies through: it keeps its items (DR-crdt-4).
	row('alpha@0 → beta@2 → [ordered-list > list-item "ta", paragraph "omega"]', () => {
		const f = nested();
		const { at } = del(f, ['alpha', 0], ['beta', 2]);
		expect(tree(f)).toEqual([
			['ol', 'ordered-list', '', [['beta', 'list-item', 'ta']]],
			P('omega', 'omega')
		]);
		expect(at).toEqual({ block: 'beta', offset: 0 });
	});

	row('the later item stays in the list with the tail (two items)', () => {
		const f = nested([
			b('beta', 'beta', undefined, 'list-item'),
			b('gamma', 'gamma', undefined, 'list-item')
		]);
		del(f, ['alpha', 0], ['beta', 2]);
		expect(tree(f)).toEqual([
			[
				'ol',
				'ordered-list',
				'',
				[
					['beta', 'list-item', 'ta'],
					['gamma', 'list-item', 'gamma']
				]
			],
			P('omega', 'omega')
		]);
	});

	row('an end at an item start: the head dies, the whole list survives', () => {
		const f = nested([
			b('beta', 'beta', undefined, 'list-item'),
			b('gamma', 'gamma', undefined, 'list-item')
		]);
		del(f, ['alpha', 0], ['beta', 0]);
		expect(tree(f)).toEqual([
			[
				'ol',
				'ordered-list',
				'',
				[
					['beta', 'list-item', 'beta'],
					['gamma', 'list-item', 'gamma']
				]
			],
			P('omega', 'omega')
		]);
	});

	row('nested-subtree: alpha@0 → beta@4 → [paragraph "omega"]', () => {
		const f = nested();
		const { at } = del(f, ['alpha', 0], ['beta', 4]);
		expect(tree(f)).toEqual([P('omega', 'omega')]);
		expect(at).toEqual({ block: 'omega', offset: 0 });
	});

	row('a nested tail under a surviving ancestor head: the doomed head is rescued past', () => {
		// The `nested` DOM scenario: Hello > [Nested child, Nested tail], After.
		const f = make([
			b('hello', 'Hello', [b('child', 'Nested child'), b('tail', 'Nested tail')]),
			b('after', 'After')
		]);
		const { at } = del(f, ['hello', 0], ['child', 7]);
		expect(tree(f)).toEqual([P('child', 'child'), P('tail', 'Nested tail'), P('after', 'After')]);
		expect(at).toEqual({ block: 'child', offset: 0 });
	});
});

describe('del.range.outside-survives — what follows the range end is kept', () => {
	row('a surviving head: the list keeps its later item (DR-crdt-4)', () => {
		const f = make([
			b('alpha', 'alpha'),
			b(
				'ol',
				'',
				[b('beta', 'beta', undefined, 'list-item'), b('gamma', 'gamma', undefined, 'list-item')],
				'ordered-list'
			),
			b('omega', 'omega')
		]);
		const { at } = del(f, ['alpha', 2], ['beta', 2]);
		expect(tree(f)).toEqual([
			P('alpha', 'alta'),
			['ol', 'ordered-list', '', [['gamma', 'list-item', 'gamma']]],
			P('omega', 'omega')
		]);
		expect(at).toEqual({ block: 'alpha', offset: 2 });
	});

	row('an item rescued out of a list under a dying block shows as a paragraph', () => {
		const f = make([
			b('alpha', 'alpha'),
			b('x', 'xx', [
				b(
					'ol',
					'',
					[b('i', 'ii', undefined, 'list-item'), b('j', 'jj', undefined, 'list-item')],
					'ordered-list'
				)
			]),
			b('omega', 'omega')
		]);
		del(f, ['alpha', 1], ['i', 1]);
		expect(tree(f)).toEqual([P('alpha', 'ai'), P('j', 'jj'), P('omega', 'omega')]);
	});

	row("a merging tail's children take its vacated slot", () => {
		const f = make([b('a', 'aa'), b('b', 'bb', [b('c', 'cc')]), b('d', 'dd')]);
		del(f, ['a', 1], ['b', 1]);
		expect(tree(f)).toEqual([P('a', 'ab'), P('c', 'cc'), P('d', 'dd')]);
	});

	row("a dying tail's children survive it", () => {
		const f = make([b('a', 'aa'), b('b', 'bb', [b('c', 'cc')])]);
		del(f, ['a', 1], ['b', 2]);
		expect(tree(f)).toEqual([P('a', 'a'), P('c', 'cc')]);
	});

	row('a rescue never crosses an island seal: the island stays', () => {
		const f = make([b('p', 'pp'), b('box', '', [b('A', 'aa', undefined, 'line')], 'box')]);
		del(f, ['p', 1], ['A', 1]);
		expect(tree(f)).toEqual([P('p', 'p'), ['box', 'box', '', [['A', 'line', 'a']]]]);
	});
});

describe('F-D1 — nesting in nesting: the island seal refuses the merge', () => {
	const flat = () => make([b('box', '', [b('A', 'aa', undefined, 'line')], 'box'), b('Y', 'yy')]);
	const deeper = () =>
		make([b('X', '', [b('box', '', [b('A', 'aa', undefined, 'line')], 'box')]), b('Y', 'yy')]);

	row('document: A@1 → Y@1 → [box > [A "a"], Y "y"]', () => {
		const f = flat();
		const { at } = del(f, ['A', 1], ['Y', 1]);
		expect(tree(f)).toEqual([['box', 'box', '', [['A', 'line', 'a']]], P('Y', 'y')]);
		expect(at).toEqual({ block: 'A', offset: 1 });
		expect(f.mergeForward('A').status).toBe('refused');
	});

	row('document, one level deeper inside X: the same answer', () => {
		const f = deeper();
		del(f, ['A', 1], ['Y', 1]);
		expect(tree(f)).toEqual([
			['X', 'paragraph', '', [['box', 'box', '', [['A', 'line', 'a']]]]],
			P('Y', 'y')
		]);
		expect(f.mergeForward('A').status).toBe('refused');
	});

	row('view: the range delete asks the document (P2)', () => {
		const document = createDocument({
			value: {
				children: [b('box', '', [b('A', 'aa', undefined, 'line')], 'box'), b('Y', 'yy')]
			}
		});
		const edytor = new Edytor({ document, plugins: [richTextPlugin, boxPlugin] });
		const A = edytor.idToBlock.get('A')!.firstText!;
		const Y = edytor.idToBlock.get('Y')!.firstText!;
		edytor.deleteContentWithinSelection({
			selection: { startText: A, yStart: 1, endText: Y, yEnd: 1 }
		});
		expect(tree(document.facade)).toEqual([['box', 'box', '', [['A', 'line', 'a']]], P('Y', 'y')]);
		expect(edytor.idToBlock.get('A')!.mergeBlockForward()).toBe(null);
	});
});

describe('F-D12 — nested, empty container', () => {
	const fixture = () =>
		make([
			b(
				'ol',
				'',
				[b('i1', 'one', undefined, 'list-item'), b('i2', 'two', undefined, 'list-item')],
				'ordered-list'
			),
			b('P', 'three')
		]);

	row('document: i1@0 → P@2 → [P "ree"], caret P@0, no empty container', () => {
		const f = fixture();
		const { at } = del(f, ['i1', 0], ['P', 2]);
		expect(tree(f)).toEqual([P('P', 'ree')]);
		expect(at).toEqual({ block: 'P', offset: 0 });
	});

	row('view: the same range through the view leaves no empty container (P5)', () => {
		const document = createDocument({
			value: {
				children: [
					b(
						'ol',
						'',
						[b('i1', 'one', undefined, 'list-item'), b('i2', 'two', undefined, 'list-item')],
						'ordered-list'
					),
					b('P', 'three')
				]
			}
		});
		const edytor = new Edytor({ document, plugins: [richTextPlugin] });
		const i1 = edytor.idToBlock.get('i1')!.firstText!;
		const p = edytor.idToBlock.get('P')!.firstText!;
		edytor.deleteContentWithinSelection({
			selection: { startText: i1, yStart: 0, endText: p, yEnd: 2 }
		});
		expect(tree(document.facade)).toEqual([P('P', 'ree')]);
	});

	row('the container dies only when every child dies and it renders no content', () => {
		const f = fixture();
		del(f, ['i1', 1], ['P', 2]);
		expect(tree(f)).toEqual([['ol', 'ordered-list', '', [['i1', 'list-item', 'oree']]]]);
	});
});

describe('del.range.replace — the head is kept for the replacement', () => {
	row('alpha@0 → beta@2 replaced → [alpha "ta"], insertion point alpha@0', () => {
		const f = make([b('alpha', 'alpha'), b('beta', 'beta')]);
		const { at } = del(f, ['alpha', 0], ['beta', 2], 'replaceRange');
		expect(tree(f)).toEqual([P('alpha', 'ta')]);
		expect(at).toEqual({ block: 'alpha', offset: 0 });
	});

	row('whole-document replacement keeps the head, emptied', () => {
		const f = threeFlat();
		const { at } = del(f, ['a', 0], ['c', 2], 'replaceRange');
		expect(tree(f)).toEqual([P('a', '')]);
		expect(at).toEqual({ block: 'a', offset: 0 });
	});
});

describe('prepared op (R6)', () => {
	row('one plan, named steps, one undo step; the refusal writes nothing', () => {
		const f = threeFlat();
		const plan = f.prepare.deleteRange({ block: 'a', offset: 1 }, { block: 'c', offset: 1 });
		expect(plan.writes.map((w) => w.op).sort()).toEqual(
			['deleteText', 'deleteText', 'deleteBlock', 'mergeBlocks'].sort()
		);
		expect(plan.effect.removes).toEqual(['b']);
		expect(plan.effect.merges).toEqual([['c', 'a']]);
		expect(
			f.prepare.deleteRange({ block: 'ghost', offset: 0 }, { block: 'c', offset: 1 }).status
		).toBe('refused');
	});
});

// ── F-O11 over range deletion (the D5 oracle) ──────────────────────────────

describe('F-O11 — the range delete plan changes exactly its effect', () => {
	const E = bindEdytorDoc(Y);
	const roles = (t: string) =>
		t === 'box' ? { island: true } : t === 'img' ? { void: true } : undefined;
	for (const seed of [1, 2, 3]) {
		row(`seed ${seed}`, () => {
			const rand = rng(seed);
			const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
			const doc = new Y.Doc();
			doc.clientID = seed + 80;
			const f = E.create(doc, {
				actor: () => ({ id: 'alice' }),
				roleOf: roles,
				rendersContent: (t: string) => t !== 'ordered-list',
				defaultChildOf: (t: string) => (t === 'ordered-list' ? 'list-item' : undefined)
			});
			let fresh = 0;
			const freshId = () => `n${seed}-${fresh++}`;
			const corpus = () => [
				b(freshId(), 'alpha', [b(freshId(), 'one')]),
				b(
					freshId(),
					'',
					[b(freshId(), 'i1', undefined, 'list-item'), b(freshId(), 'i2', undefined, 'list-item')],
					'ordered-list'
				),
				b(freshId(), 'isle', [b(freshId(), 'side', undefined, 'line')], 'box'),
				b(freshId(), 'beta'),
				b(freshId(), '', undefined, 'img'),
				b(freshId(), 'gamma', [b(freshId(), 'deep', [b(freshId(), 'deeper')])])
			];
			const spec = (x) => ({
				...x,
				content: x.content.map((c) => ({ kind: 'text', ...c })),
				...(x.children ? { children: x.children.map(spec) } : {})
			});
			f.init({ content: corpus().map(spec) });
			const at = () => {
				const id = pick([...f.listBlockIds(), 'ghost']);
				return { block: id, offset: Math.floor(rand() * 7) };
			};
			const seen = { refused: 0, noop: 0, applied: 0 };
			for (let step = 0; step < 120; step++) {
				const op = pick(['deleteRange', 'deleteRange', 'replaceRange', 'deleteBlocks']);
				const prepare =
					op === 'deleteBlocks'
						? () => f.prepare.deleteBlocks([pick(f.listBlockIds()), pick(f.listBlockIds())])
						: () => f.prepare[op](at(), at());
				const emptyLists = () =>
					f
						.listBlockIds()
						.filter((id) => f.blockTypeOf(id) === 'ordered-list' && f.childrenIds(id).length === 0);
				const before = emptyLists();
				const plan = prepare();
				const r = prepareApply(f, doc, op, () => plan, `${step} ${op}`);
				seen[r.status]++;
				if (op !== 'deleteBlocks' && r.status !== 'refused') {
					// The caret names a live block, inside its display.
					expect(f.isVisibleBlock(plan.at.block), `${step}: caret block live`).toBe(true);
					expect(plan.at.offset).toBeLessThanOrEqual(f.displayLength(plan.at.block));
					// No list container is emptied by a range delete (del.range.empty-container).
					const left = emptyLists().filter((id) => !before.includes(id));
					expect(left, `${step}: ${JSON.stringify(plan.writes)}`).toEqual([]);
				}
				if (f.childrenIds(null).length < 2)
					f.insertBlocks({ parent: null, index: 0 }, corpus().map(spec));
			}
			expect(seen.refused).toBeGreaterThan(0);
			expect(seen.applied).toBeGreaterThan(0);
		});
	}
});

// ── F-O5 (document half) ──────────────────────────────────────────────────

describe('F-O5 — range delete and selected-block delete over 1,000 paragraphs', () => {
	const many = (n: number) =>
		make(Array.from({ length: n }, (_, i) => b(`p${i}`, `paragraph ${i}`)));
	/**
	 * The index's work for `op` over `n` paragraphs, the read after it
	 * included (CC-05: operation counts, deterministic on any machine; the
	 * timings are `bench:crdt`'s `scale` workload). The self-checks are off
	 * while it counts: their rebuild reads would be counted too.
	 */
	const work = (n: number, op: (f, n: number) => unknown) => {
		const f = many(n);
		f.toJSON(); // warm the derived view
		const { debug } = f.runsView;
		const checks = indexChecks.on;
		indexChecks.on = false;
		try {
			debug.reset();
			op(f, n);
			expect(f.toJSON().children).toHaveLength(1);
			return {
				folds: debug.folds,
				pairs: debug.foldedPairs,
				structs: debug.foldedStructs,
				recomputes: debug.recomputes,
				items: debug.itemsWalked
			};
		} finally {
			indexChecks.on = checks;
		}
	};
	/**
	 * Ten times the blocks removed: the same number of folds and recomputes
	 * (only the surviving block renders again), at most eleven times the fold
	 * input and the items read (quadratic work would be a hundred times).
	 */
	const linear = (op: (f, n: number) => unknown) => {
		const small = work(100, op);
		const large = work(1000, op);
		expect(small.pairs).toBeGreaterThan(0);
		expect(large.folds, 'folds').toBeLessThanOrEqual(small.folds);
		expect(large.recomputes, 'recomputes').toBeLessThanOrEqual(small.recomputes);
		expect(large.pairs, 'folded pairs').toBeLessThanOrEqual(11 * small.pairs);
		expect(large.structs, 'folded structs').toBeLessThanOrEqual(11 * small.structs);
		expect(large.items, 'items walked').toBeLessThanOrEqual(11 * small.items + 64);
	};

	row('range delete: document work linear in the blocks removed', () =>
		linear((f, n) =>
			f.apply(f.prepare.deleteRange({ block: 'p0', offset: 1 }, { block: `p${n - 1}`, offset: 1 }))
		)
	);

	row('selected-block delete: document work linear in the blocks removed', () =>
		linear((f) => f.apply(f.prepare.deleteBlocks(f.childrenIds(null).slice(1))))
	);
});
