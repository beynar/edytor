/**
 * arch-v2 — checkpoint D3 rows: capability adopted once, answered by one
 * predicate each (rule R5, §2.2 L1, O8, O9, O22; decisions D-11, D-13).
 *
 * Rows (doc lane; the dom halves live in
 * `src/tests/fixtures/dom/arch-v2-d3-capability.test.tsx`):
 * - F-D4 — `ordered-list > [li "one"]`: Enter at end, middle, start gives
 *   `[li "one", li ""]`, `[li "o", li "ne"]`, `[li "", li "one"]`; merging an
 *   island's child out into the list yields an `li` (G5: "the tail takes the
 *   parent-appropriate default type with empty data"). Red on the reference
 *   (P12: Enter at end/start inserts a `paragraph` inside the list; P10: the
 *   merged-out child becomes `paragraph`).
 * - F-O6 — over a randomized corpus of move requests,
 *   `canMoveBlocks(r) ⇔ moveBlocks(r) is not refused`, on the document
 *   (`canPlace` vs the move ops) and on the view (the relative-move API the
 *   drop affordance and the menus use). D4 turns "not refused" into the
 *   `status` result; until then a refused document move returns `false` and
 *   a refused view move returns no blocks.
 * - Adoption (§2.2 L1): roles, `rendersContent` and `defaultChild` are
 *   adopted as data with atomic conflict refusal, per view and across the
 *   extensions of one view (D-13: "merged across extensions, conflicts are
 *   errors").
 * - L13 phantom slots: `firstText`/`lastText` never answer with the content
 *   slot of a kind that declares it does not render its content.
 *
 * Expected values come from the plan rows and the contracts they cite, never
 * from running the code.
 */
// @ts-nocheck -- tests drive the vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import { createDocument, SemanticConflictError } from '../../../lib/crdt/index.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { createTestEdytor, runBeforeInput } from '../../test.utils.js';

const noopSnippet = (() => null) as never;

const text = (value: string) => [{ text: value }];

// ── F-D4 ──────────────────────────────────────────────────────────────────

/** `ordered-list > [li <marked>]` as an editor value (`|` marks the caret). */
const listValue = (marked: string) => ({
	children: [
		{
			type: 'ordered-list',
			children: [{ type: 'list-item', content: text(marked) }]
		}
	]
});

/** `[type, text]` of each child of the first root block. */
const listShape = (edytor: Edytor) =>
	(edytor.value.children?.[0]?.children ?? []).map((child) => [
		child.type,
		(child.content ?? []).map((part) => ('text' in part ? part.text : '')).join('')
	]);

/** `ordered-list > [li "one", box(island) "" > [line "two"]]` (ids pinned). */
const ISLAND_IN_LIST = [
	{
		id: 'ol',
		type: 'ordered-list',
		children: [
			{ id: 'one', type: 'list-item', content: text('one') },
			{
				id: 'box',
				type: 'box',
				content: text(''),
				children: [{ id: 'two', type: 'line', content: text('two') }]
			}
		]
	}
];

const boxPlugin = () => ({
	blocks: {
		box: { snippet: noopSnippet, island: true },
		line: { snippet: noopSnippet }
	}
});

describe('F-D4 — same definition, different position', () => {
	const ENTER = [
		[
			'end',
			'one|',
			[
				['list-item', 'one'],
				['list-item', '']
			]
		],
		[
			'middle',
			'o|ne',
			[
				['list-item', 'o'],
				['list-item', 'ne']
			]
		],
		[
			'start',
			'|one',
			[
				['list-item', ''],
				['list-item', 'one']
			]
		]
	];
	const enter = async (_: string, marked: string, expected: string[][]) => {
		const value = listValue(marked);
		const { edytor } = createTestEdytor({ value } as never, { value });
		await runBeforeInput(edytor, { inputType: 'insertParagraph' });
		expect(edytor.value.children?.[0]?.type).toBe('ordered-list');
		expect(listShape(edytor)).toEqual(expected);
	};
	test.each(ENTER)('Enter at the %s of a list item creates a list item', enter);

	test('document: an island merged out of a list leaves its child as a list item', () => {
		const document = createDocument({
			value: { children: ISLAND_IN_LIST },
			semantics: {
				roles: { box: { island: true } },
				defaultChild: { 'ordered-list': 'list-item' }
			}
		});
		expect(document.facade.mergeBackward('box')).toBe('one');
		const [ol] = document.facade.toJSON().children;
		expect(ol.children.map((child) => [child.id, child.type])).toEqual([
			['one', 'list-item'],
			['two', 'list-item']
		]);
	});

	test('view: an island merged out of a list leaves its child as a list item', () => {
		const document = createDocument({ value: { children: ISLAND_IN_LIST } });
		const edytor = new Edytor({ document, plugins: [richTextPlugin, boxPlugin] });
		edytor.idToBlock.get('box')!.mergeBlockBackward();
		const [ol] = document.facade.toJSON().children;
		expect(ol.children.map((child) => [child.id, child.type])).toEqual([
			['one', 'list-item'],
			['two', 'list-item']
		]);
	});

	test('the default child is answered against the actual parent type', () => {
		const document = createDocument({
			semantics: { defaultChild: { 'ordered-list': 'list-item' } }
		});
		expect(document.defaultChild('ordered-list')).toBe('list-item');
		// Root (no parent) and a parent type with no declaration: the default type.
		expect(document.defaultChild(null)).toBe('paragraph');
		expect(document.defaultChild('list-item')).toBe('paragraph');
	});
});

// ── adoption (§2.2 L1, D-13) ──────────────────────────────────────────────

describe('adopted capability: data, conflict-checked atomically', () => {
	test('a view adopts its kinds: roles, rendersContent and defaultChild', () => {
		const document = createDocument();
		new Edytor({ document, plugins: [richTextPlugin] });
		expect(document.defaultChild('ordered-list')).toBe('list-item');
		expect(document.defaultChild('unordered-list')).toBe('list-item');
		expect(document.rendersContent('ordered-list')).toBe(false);
		expect(document.rendersContent('paragraph')).toBe(true);
		expect(document.semantics.roles.get('divider')).toMatchObject({ void: true });
	});

	test('a conflicting defaultChild or rendersContent is refused, atomically', () => {
		const document = createDocument({
			semantics: {
				defaultChild: { 'ordered-list': 'list-item' },
				rendersContent: { 'ordered-list': false }
			}
		});
		expect(() =>
			document.adoptSemantics({
				roles: { fresh: { island: true } },
				defaultChild: { quote: 'paragraph', 'ordered-list': 'paragraph' }
			})
		).toThrowError(SemanticConflictError);
		expect(() =>
			document.adoptSemantics({
				defaultChild: { other: 'paragraph' },
				rendersContent: { 'ordered-list': true }
			})
		).toThrowError(SemanticConflictError);
		// Nothing of either refused contribution was adopted.
		expect(document.semantics.roles.has('fresh')).toBe(false);
		expect(document.semantics.defaultChild.has('quote')).toBe(false);
		expect(document.semantics.defaultChild.has('other')).toBe(false);
		expect(document.defaultChild('ordered-list')).toBe('list-item');
		expect(document.rendersContent('ordered-list')).toBe(false);
		// Agreeing contributions are accepted.
		document.adoptSemantics({
			defaultChild: { 'ordered-list': 'list-item' },
			rendersContent: { 'ordered-list': false }
		});
	});

	test('a second view declaring a different default child is refused', () => {
		const document = createDocument();
		new Edytor({ document, plugins: [richTextPlugin] });
		const otherList = () => ({
			blocks: { 'ordered-list': { snippet: noopSnippet, defaultChild: 'paragraph' } }
		});
		expect(() => new Edytor({ document, plugins: [otherList] })).toThrowError(
			SemanticConflictError
		);
		expect(document.defaultChild('ordered-list')).toBe('list-item');
	});

	test('two extensions of one view declaring different default children is an error (D-13)', () => {
		const a = () => ({ blocks: { stack: { snippet: noopSnippet, defaultChild: 'paragraph' } } });
		const b = () => ({ blocks: { stack: { snippet: noopSnippet, defaultChild: 'heading' } } });
		const document = createDocument();
		expect(() => new Edytor({ document, plugins: [a, b] })).toThrowError(SemanticConflictError);
		expect(document.semantics.defaultChild.has('stack')).toBe(false);
	});
});

// ── L13: phantom slots ────────────────────────────────────────────────────

describe('firstText/lastText never answer with a slot the kind does not render', () => {
	test('a list container and a divider answer with no text; an item with its own', () => {
		const document = createDocument({
			value: {
				children: [
					{
						id: 'ol',
						type: 'ordered-list',
						children: [
							{ id: 'a', type: 'list-item', content: text('a') },
							{ id: 'b', type: 'list-item', content: text('b') }
						]
					},
					{ id: 'hr', type: 'divider' }
				]
			}
		});
		const edytor = new Edytor({ document, plugins: [richTextPlugin] });
		for (const id of ['ol', 'hr']) {
			const block = edytor.idToBlock.get(id)!;
			expect(block.content.length).toBeGreaterThan(0); // the unrendered slot exists
			expect(block.firstText).toBeUndefined();
			expect(block.lastText).toBeUndefined();
		}
		const a = edytor.idToBlock.get('a')!;
		expect(a.firstText).toBe(a.content[0]);
		expect(a.lastText).toBe(a.content[0]);
	});
});

// ── F-O6 ──────────────────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32) — the corpus is reproducible per seed. */
const rng = (seed: number) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const b = (id: string, type = 'paragraph', children?: unknown[]) => ({
	id,
	type,
	content: text(id),
	...(children ? { children } : {})
});

/**
 * A tree with every structural case the rules name: nesting, an island with
 * an interior, a void, deep nesting, and (after seeding) a deleted block.
 */
const CORPUS = [
	b('P1', 'paragraph', [b('P1a'), b('P1b')]),
	b('box', 'box', [b('L1', 'line'), b('L2', 'line', [b('L2a', 'line')])]),
	{ id: 'rule', type: 'divider' },
	b('P2', 'paragraph', [b('P2a', 'paragraph', [b('P2aa')])]),
	b('P3'),
	b('gone')
];
const IDS = ['P1', 'P1a', 'P1b', 'box', 'L1', 'L2', 'L2a', 'rule', 'P2', 'P2a', 'P2aa', 'P3'];
const CANDIDATES = [...IDS, 'gone', 'missing'];
const CORPUS_ROLES = { box: { island: true }, divider: { void: true } };

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

describe('F-O6 — canMoveBlocks(r) ⇔ moveBlocks(r) is not refused', () => {
	const corpusDocument = () => {
		const document = createDocument({
			value: { children: CORPUS },
			semantics: { roles: CORPUS_ROLES }
		});
		expect(document.facade.deleteBlock('gone')).toBe(true);
		return document;
	};

	test.each([1, 2, 3])('document: canPlace answers what the move ops do (seed %i)', (seed) => {
		const r = rng(seed);
		const ed = corpusDocument().facade;
		let accepted = 0;
		let refused = 0;
		for (let step = 0; step < 300; step++) {
			const count = 1 + Math.floor(r() * 3);
			const ids = Array.from({ length: count }, () => pick(r, CANDIDATES));
			const parent = r() < 0.25 ? null : pick(r, CANDIDATES);
			const index = Math.floor(r() * 4);
			const expected = ed.canPlace(ids, parent);
			const kind = r();
			let actual: boolean;
			if (ids.length === 1 && kind < 0.3) {
				actual = ed.moveBlock(ids[0], { parent, index });
			} else if (ids.length === 1 && kind < 0.45 && parent !== null) {
				actual = ed.nestBlock(ids[0], parent);
			} else {
				actual = ed.moveBlocks(ids, { parent, index });
			}
			expect({ step, ids, parent, actual }).toEqual({ step, ids, parent, actual: expected });
			if (actual) accepted++;
			else refused++;
		}
		// The corpus exercises both answers.
		expect(accepted).toBeGreaterThan(20);
		expect(refused).toBeGreaterThan(20);
	});

	test.each([1, 2, 3])('view: the relative-move API agrees with itself (seed %i)', (seed) => {
		const r = rng(seed);
		const document = corpusDocument();
		const boxPlugin = () => ({
			blocks: {
				box: { snippet: noopSnippet, island: true },
				line: { snippet: noopSnippet }
			}
		});
		const edytor = new Edytor({ document, plugins: [richTextPlugin, boxPlugin] });
		const positions = ['before', 'after', 'inside'] as const;
		let accepted = 0;
		let refused = 0;
		for (let step = 0; step < 200; step++) {
			const live = IDS.map((id) => edytor.idToBlock.get(id)).filter(Boolean);
			const count = 1 + Math.floor(r() * 2);
			const blocks = [...new Set(Array.from({ length: count }, () => pick(r, live)))];
			const target = pick(r, live);
			const position = pick(r, positions);
			const request = { blocks, target, position };
			const expected = edytor.canMoveBlocks(request);
			const actual = edytor.moveBlocks(request).length > 0;
			expect({ step, actual }).toEqual({ step, actual: expected });
			if (actual) accepted++;
			else refused++;
		}
		expect(accepted).toBeGreaterThan(10);
		expect(refused).toBeGreaterThan(10);
	});

	test('document: canMerge answers what the merges do', () => {
		const r = rng(7);
		const ed = corpusDocument().facade;
		for (let step = 0; step < 60; step++) {
			const id = pick(r, IDS);
			if (!ed.isVisibleBlock(id)) continue;
			const after = ed.next(id);
			const expected = after !== null && ed.canMerge(after, id);
			expect({ step, id, merged: ed.mergeForward(id) !== null }).toEqual({
				step,
				id,
				merged: expected
			});
		}
	});

	test('the island seal and the void role are the structural rules', () => {
		const ed = corpusDocument().facade;
		// An island interior is sealed: it cannot leave, and nothing enters it.
		expect(ed.canPlace(['L1'], null)).toBe(false);
		expect(ed.canPlace(['P3'], 'box')).toBe(false);
		expect(ed.canPlace(['P3'], 'L1')).toBe(false);
		// A void takes no children; a block never goes under itself.
		expect(ed.canPlace(['P3'], 'rule')).toBe(false);
		expect(ed.canPlace(['P2'], 'P2aa')).toBe(false);
		// Dead ids and duplicates are refused; the island and void themselves move.
		expect(ed.canPlace(['gone'], null)).toBe(false);
		expect(ed.canPlace(['P3', 'P3'], null)).toBe(false);
		expect(ed.canPlace(['box', 'rule'], 'P3')).toBe(true);
		// Without a destination: "may these blocks move at all" (drag handles).
		expect(ed.canPlace(['L2a'])).toBe(false);
		expect(ed.canPlace(['box'])).toBe(true);
		// Merges: never across the island boundary, never with a void.
		expect(ed.canMerge('L1', 'P1b')).toBe(false);
		expect(ed.canMerge('L1', 'box')).toBe(true);
		expect(ed.canMerge('P3', 'rule')).toBe(false);
		expect(ed.canMerge('P3', 'P2aa')).toBe(true);
	});
});
