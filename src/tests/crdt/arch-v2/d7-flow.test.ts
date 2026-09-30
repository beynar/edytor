/**
 * arch-v2 — checkpoint D7 rows: an admitted flow (inline runs + kinded
 * blocks, fresh ids at ingress) is placed by ONE prepared document operation,
 * `prepare.insertFlow(target, flow)` (rules R6, R1; §4.1 `doc/flow`; §5 L46).
 *
 * Rows (doc lane; the paste / drop / HTML paths live in
 * `src/tests/fixtures/dom/arch-v2-d7-flow.test.tsx`):
 * - every `flow.*` row of `docs/editor-delete-contract.md` on the document,
 *   with the caret the op reports;
 * - F-P5 (decision D-4) on the document: `X`, `Y` at `Hello|World` →
 *   `["HelloX", "YWorld"]`, whether the lines are runs or kinded blocks;
 * - F-O11 over `insertFlow` (the D5 oracle): prepare writes nothing, the plan
 *   changes exactly its effect.
 *
 * Expected values come from the contract rows and the plan rows, never from
 * running the code. The `flow.*` rows were written into the contract at D7
 * (the plan's "write the row first").
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, test } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { createDocument } from '../../../lib/crdt/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { observe, prepareApply, rng } from './prepared-oracle.js';

/** Red on the reference (no `prepare.insertFlow`); green since D7. */
const row = test;

const SEMANTICS = {
	roles: { img: { void: true }, box: { island: true } },
	rendersContent: { 'ordered-list': false },
	defaultChild: { 'ordered-list': 'list-item' }
};

const b = (id: string, text: string, children?: unknown[], type = 'paragraph', data?: object) => ({
	id,
	type,
	...(data ? { data } : {}),
	content: text === '' ? [] : [{ text }],
	...(children ? { children } : {})
});

/** `b(…)` as a block spec (flow children are specs, admitted at ingress). */
const sb = (x) => ({
	...x,
	content: x.content.map((c) => ({ kind: 'text', ...c })),
	...(x.children ? { children: x.children.map(sb) } : {})
});

const made = (children: unknown[]) => createDocument({ value: { children }, semantics: SEMANTICS });
const make = (children: unknown[]) => made(children).facade;

/** `[id, type, text, children?]` per block — the full recursive tree. */
const shape = (blocks) =>
	blocks.map((x) => {
		const text = (x.content ?? []).map((part) => part.text ?? '@').join('');
		const out = [x.id, x.type, text];
		if (x.children?.length) out.push(shape(x.children));
		return out;
	});
const tree = (f) => shape(f.toJSON().children);

/** A run line (no kind) and a kinded line, fresh ids given by the test. */
const run = (id: string, text: string) => ({
	id,
	content: text === '' ? [] : [{ kind: 'text', text }]
});
const line = (id: string, text: string, type = 'paragraph', extra = {}) => ({
	...run(id, text),
	type,
	...extra
});

const place = (f, target, flow) => {
	const plan = f.prepare.insertFlow(target, flow);
	const result = f.apply(plan);
	return { result, at: plan.at, plan };
};

const P = (id: string, text: string, children?: unknown[]) =>
	children ? [id, 'paragraph', text, children] : [id, 'paragraph', text];

describe('F-P5 / flow.split — several lines split the block (decision D-4)', () => {
	row('runs X, Y at Hello|World → ["HelloX", "YWorld"], caret after Y', () => {
		const f = make([b('h', 'HelloWorld')]);
		const { result, at } = place(
			f,
			{ block: 'h', offset: 5 },
			{ lines: [run('x', 'X'), run('y', 'Y')] }
		);
		expect(result.status).toBe('applied');
		expect(tree(f)).toEqual([P('h', 'HelloX'), P('y', 'YWorld')]);
		expect(at).toEqual({ block: 'y', offset: 1 });
	});

	row('kinded paragraphs X, Y give the same structure', () => {
		const f = make([b('h', 'HelloWorld')]);
		place(f, { block: 'h', offset: 5 }, { lines: [line('x', 'X'), line('y', 'Y')] });
		expect(tree(f)).toEqual([P('h', 'HelloX'), P('y', 'YWorld')]);
	});

	row('lines between the first and the last are whole blocks between the halves', () => {
		const f = make([b('h', 'HelloWorld'), b('z', 'after')]);
		const { at } = place(
			f,
			{ block: 'h', offset: 5 },
			{ lines: [run('x', 'X'), line('m', 'M', 'quote'), run('n', 'N'), run('y', 'Y')] }
		);
		expect(tree(f)).toEqual([
			P('h', 'HelloX'),
			['m', 'quote', 'M'],
			P('n', 'N'),
			P('y', 'YWorld'),
			P('z', 'after')
		]);
		expect(at).toEqual({ block: 'y', offset: 1 });
	});

	row("the tail is the last line's block: its kind when kinded, the head keeps its own", () => {
		const f = make([b('h', 'HelloWorld', undefined, 'heading', { level: 'h2' })]);
		place(f, { block: 'h', offset: 5 }, { lines: [line('x', 'X'), line('y', 'Y', 'quote')] });
		const json = f.toJSON().children;
		expect(shape(json)).toEqual([
			['h', 'heading', 'HelloX'],
			['y', 'quote', 'YWorld']
		]);
		expect(json[0].data).toEqual({ level: 'h2' });
	});

	row("a run as the last line: the tail keeps the block's kind (a split)", () => {
		const f = make([b('h', 'HelloWorld', undefined, 'heading', { level: 'h2' })]);
		place(f, { block: 'h', offset: 5 }, { lines: [run('x', 'X'), run('y', 'Y')] });
		const json = f.toJSON().children;
		expect(shape(json)).toEqual([
			['h', 'heading', 'HelloX'],
			['y', 'heading', 'YWorld']
		]);
		expect(json[1].data).toEqual({ level: 'h2' });
	});

	row("the block's children follow the tail (they come after the caret)", () => {
		const f = make([b('h', 'HelloWorld', [b('c', 'child')])]);
		place(f, { block: 'h', offset: 5 }, { lines: [run('x', 'X'), run('y', 'Y')] });
		expect(tree(f)).toEqual([P('h', 'HelloX'), P('y', 'YWorld', [P('c', 'child')])]);
	});

	row("a joined line's children become the first children of the block it joins", () => {
		const f = make([b('h', 'HelloWorld', [b('c', 'child')])]);
		place(
			f,
			{ block: 'h', offset: 5 },
			{
				lines: [
					line('x', 'X', 'paragraph', { children: [{ id: 'xc', type: 'paragraph' }] }),
					line('y', 'Y', 'paragraph', { children: [{ id: 'yc', type: 'paragraph' }] })
				]
			}
		);
		expect(tree(f)).toEqual([
			P('h', 'HelloX', [P('xc', '')]),
			P('y', 'YWorld', [P('yc', ''), P('c', 'child')])
		]);
	});

	row('at the end of the text: the tail holds only the last line', () => {
		const f = make([b('h', 'Hello')]);
		const { at } = place(f, { block: 'h', offset: 5 }, { lines: [run('x', 'X'), run('y', 'Y')] });
		expect(tree(f)).toEqual([P('h', 'HelloX'), P('y', 'Y')]);
		expect(at).toEqual({ block: 'y', offset: 1 });
	});

	row('at the start of the text: the head holds only the first line', () => {
		const f = make([b('h', 'World')]);
		place(f, { block: 'h', offset: 0 }, { lines: [run('x', 'X'), run('y', 'Y')] });
		expect(tree(f)).toEqual([P('h', 'X'), P('y', 'YWorld')]);
	});

	row("an empty block takes the first line's kind; the tail takes the last's", () => {
		const f = make([b('e', ''), b('z', 'note')]);
		place(
			f,
			{ block: 'e', offset: 0 },
			{
				lines: [
					line('u', 'Bullet', 'bulleted-list-item', { data: {} }),
					line('n', 'Number', 'numbered-list-item', { data: {} })
				]
			}
		);
		expect(tree(f)).toEqual([
			['e', 'bulleted-list-item', 'Bullet'],
			['n', 'numbered-list-item', 'Number'],
			P('z', 'note')
		]);
	});

	row("an empty line in the middle is an empty block of the parent's default child", () => {
		const f = make([
			b('l', '', [b('i', 'onetwo', undefined, 'list-item')], 'ordered-list'),
			b('z', 'after')
		]);
		place(f, { block: 'i', offset: 3 }, { lines: [run('x', 'X'), run('m', ''), run('y', 'Y')] });
		expect(tree(f)).toEqual([
			[
				'l',
				'ordered-list',
				'',
				[
					['i', 'list-item', 'oneX'],
					['m', 'list-item', ''],
					['y', 'list-item', 'Ytwo']
				]
			],
			P('z', 'after')
		]);
	});
});

describe('flow.inline — one line joins the text at the position', () => {
	row('a run at Hello|World → "HelloXWorld", caret after X', () => {
		const f = make([b('h', 'HelloWorld')]);
		const { at } = place(f, { block: 'h', offset: 5 }, { lines: [run('x', 'X')] });
		expect(tree(f)).toEqual([P('h', 'HelloXWorld')]);
		expect(at).toEqual({ block: 'h', offset: 6 });
	});

	row('a kinded line into a block with text: the block keeps its kind', () => {
		const f = make([b('h', 'HelloWorld', undefined, 'heading', { level: 'h2' })]);
		place(f, { block: 'h', offset: 5 }, { lines: [line('q', 'X', 'quote')] });
		expect(tree(f)).toEqual([['h', 'heading', 'HelloXWorld']]);
	});

	row("a kinded line into an empty block: the block takes the line's kind and data", () => {
		const f = make([b('e', '', undefined, 'heading', { level: 'h2' })]);
		place(f, { block: 'e', offset: 0 }, { lines: [line('q', 'Quoted', 'quote', { data: {} })] });
		const json = f.toJSON().children;
		expect(shape(json)).toEqual([['e', 'quote', 'Quoted']]);
		expect(json[0].data ?? {}).toEqual({});
	});

	row('inline atoms keep their place; the caret counts an atom as 1', () => {
		const f = make([b('h', 'ab')]);
		const { at } = place(
			f,
			{ block: 'h', offset: 1 },
			{
				lines: [
					{
						id: 'x',
						content: [
							{ kind: 'text', text: 'X' },
							{ kind: 'inline', id: 'i1', type: 'mention' },
							{ kind: 'text', text: 'Y' }
						]
					}
				]
			}
		);
		expect(tree(f)).toEqual([P('h', 'aX@Yb')]);
		expect(at).toEqual({ block: 'h', offset: 4 });
	});

	row("the line's children become the block's first children", () => {
		const f = make([b('h', 'target', [b('c', 'child')])]);
		place(
			f,
			{ block: 'h', offset: 6 },
			{ lines: [run('x', 'Parent')].map((l) => ({ ...l, children: [sb(b('n', 'Nested'))] })) }
		);
		expect(tree(f)).toEqual([P('h', 'targetParent', [P('n', 'Nested'), P('c', 'child')])]);
	});
});

describe('flow.whole — a block-selection copy places whole blocks', () => {
	row('at the end of a block: after it (the clipboard nested-copy pin)', () => {
		const f = make([b('t', 'target'), b('z', 'after')]);
		const { at } = place(
			f,
			{ block: 't', offset: 6 },
			{
				whole: true,
				lines: [line('p', 'Parent', 'paragraph', { children: [sb(b('n', 'Nested'))] })]
			}
		);
		expect(tree(f)).toEqual([
			P('t', 'target'),
			P('p', 'Parent', [P('n', 'Nested')]),
			P('z', 'after')
		]);
		expect(at).toEqual({ block: 'p', offset: 6 });
	});

	row('mid-text: after the block, which is not split', () => {
		const f = make([b('h', 'HelloWorld')]);
		place(f, { block: 'h', offset: 5 }, { whole: true, lines: [line('x', 'X'), line('y', 'Y')] });
		expect(tree(f)).toEqual([P('h', 'HelloWorld'), P('x', 'X'), P('y', 'Y')]);
	});

	row('an empty block (no text, no children) is replaced', () => {
		const f = make([b('a', 'lead'), b('e', ''), b('z', 'tail')]);
		const { at } = place(
			f,
			{ block: 'e', offset: 0 },
			{ whole: true, lines: [line('x', 'X', 'quote'), line('y', 'Y')] }
		);
		expect(tree(f)).toEqual([P('a', 'lead'), ['x', 'quote', 'X'], P('y', 'Y'), P('z', 'tail')]);
		expect(at).toEqual({ block: 'y', offset: 1 });
	});
});

describe('flow.slot — over selected blocks', () => {
	row("the blocks go, the lines take the first one's slot (runs: the default child)", () => {
		const f = make([b('a', 'lead'), b('s', 'Replace me'), b('t', 'too'), b('z', 'Keep me')]);
		const { result, at } = place(f, { replace: ['t', 's'] }, { lines: [run('x', 'pha')] });
		expect(result.status).toBe('applied');
		expect(tree(f)).toEqual([P('a', 'lead'), P('x', 'pha'), P('z', 'Keep me')]);
		expect(at).toEqual({ block: 'x', offset: 3 });
	});

	row('inside a list the runs take the list default child', () => {
		const f = make([
			b(
				'l',
				'',
				[b('i', 'one', undefined, 'list-item'), b('j', 'two', undefined, 'list-item')],
				'ordered-list'
			)
		]);
		place(f, { replace: ['i'] }, { lines: [run('x', 'X'), line('y', 'Y', 'quote')] });
		expect(tree(f)).toEqual([
			[
				'l',
				'ordered-list',
				'',
				[
					['x', 'list-item', 'X'],
					['y', 'quote', 'Y'],
					['j', 'list-item', 'two']
				]
			]
		]);
	});

	row('a dead block in the set refuses the whole op before any write', () => {
		const f = make([b('a', 'lead'), b('s', 'x')]);
		const plan = f.prepare.insertFlow({ replace: ['s', 'ghost'] }, { lines: [run('x', 'X')] });
		expect(plan.status).toBe('refused');
	});
});

describe('flow.lines + flow.slot — over selected lines of a code block (HX-06)', () => {
	const code = () =>
		createDocument({
			value: {
				children: [
					b(
						'c',
						'',
						[b('c1', 'x', undefined, 'codeLine'), b('c2', 'y', undefined, 'codeLine')],
						'code'
					),
					b('z', 'after')
				]
			},
			semantics: {
				roles: { code: { island: true, lines: true }, divider: { void: true } },
				rendersContent: { code: false, divider: false, 'unordered-list': false },
				defaultChild: { code: 'codeLine', 'unordered-list': 'list-item' }
			}
		}).facade;
	const list = {
		id: 'u',
		type: 'unordered-list',
		content: [],
		children: [line('one', 'one', 'list-item')]
	};

	row('the lines are plain code lines in the slot; no block lands in or after the island', () => {
		const f = code();
		const { result, at } = place(
			f,
			{ replace: ['c1'] },
			{ whole: true, lines: [list, line('h', 'H', 'heading')] }
		);
		expect(result.status).toBe('applied');
		expect(tree(f)).toEqual([
			[
				'c',
				'code',
				'',
				[
					['one', 'codeLine', 'one'],
					['h', 'codeLine', 'H'],
					['c2', 'codeLine', 'y']
				]
			],
			P('z', 'after')
		]);
		expect(at).toEqual({ block: 'h', offset: 1 });
	});

	row('a flow that shows no line leaves one empty code line in the slot', () => {
		const f = code();
		const { result, at } = place(f, { replace: ['c1'] }, { lines: [line('d', '', 'divider')] });
		expect(result.status).toBe('applied');
		expect(tree(f)).toEqual([
			[
				'c',
				'code',
				'',
				[
					['d', 'codeLine', ''],
					['c2', 'codeLine', 'y']
				]
			],
			P('z', 'after')
		]);
		expect(at).toEqual({ block: 'd', offset: 0 });
	});
});

describe('flow.header — at the end of a container header whose body shows (HX-10)', () => {
	/** A callout `h` with a body, as the editor shows it (`view.header`: Enter opens a first child). */
	const callout = (text = 'hello', body = [b('c1', 'body')]) =>
		createDocument({
			value: {
				children: [b('h', text, body, 'callout', { icon: 'i' }), b('z', 'after')]
			},
			semantics: {
				roles: { code: { island: true, lines: true }, divider: { void: true } },
				rendersContent: { code: false, divider: false, 'unordered-list': false },
				defaultChild: { code: 'codeLine', 'unordered-list': 'list-item' }
			}
		}).facade;
	const header = { header: (id: string) => id === 'h' };
	const put = (f, offset: number, lines, view = header) => {
		const plan = f.prepare.insertFlow({ block: 'h', offset }, { lines }, view);
		return { result: f.apply(plan), at: plan.at };
	};
	const fresh = expect.any(String);
	const code = { id: 'k', type: 'code', content: [], children: [line('k1', 'let a', 'codeLine')] };

	row('a divider leads the body; a fresh first line takes the caret; the body stays', () => {
		const f = callout();
		const { result, at } = put(f, 5, [line('d', '', 'divider')]);
		expect(result.status).toBe('applied');
		expect(tree(f)).toEqual([
			['h', 'callout', 'hello', [['d', 'divider', ''], [fresh, 'paragraph', ''], P('c1', 'body')]],
			P('z', 'after')
		]);
		expect(at).toEqual({ block: tree(f)[0][3][1][0], offset: 0 });
	});

	row('a code block leads the body; the caret ends its last line', () => {
		const f = callout();
		const { at } = put(f, 5, [code]);
		expect(tree(f)).toEqual([
			[
				'h',
				'callout',
				'hello',
				[['k', 'code', '', [['k1', 'codeLine', 'let a']]], P('c1', 'body')]
			],
			P('z', 'after')
		]);
		expect(at).toEqual({ block: 'k1', offset: 5 });
	});

	row('x, a divider: x joins the header, the divider leads the body', () => {
		const f = callout();
		put(f, 5, [line('x', 'x'), line('d', '', 'divider')]);
		expect(tree(f)).toEqual([
			['h', 'callout', 'hellox', [['d', 'divider', ''], [fresh, 'paragraph', ''], P('c1', 'body')]],
			P('z', 'after')
		]);
	});

	row('a divider, x: x is the first line after it, before the body', () => {
		const f = callout();
		const { at } = put(f, 5, [line('d', '', 'divider'), line('x', 'x')]);
		expect(tree(f)).toEqual([
			['h', 'callout', 'hello', [['d', 'divider', ''], P('x', 'x'), P('c1', 'body')]],
			P('z', 'after')
		]);
		expect(at).toEqual({ block: 'x', offset: 1 });
	});

	row("a divider, a run: the run's line is the header's default child, not a callout", () => {
		const f = callout();
		put(f, 5, [line('d', '', 'divider'), run('x', 'x')]);
		expect(tree(f)).toEqual([
			['h', 'callout', 'hello', [['d', 'divider', ''], P('x', 'x'), P('c1', 'body')]],
			P('z', 'after')
		]);
	});

	row('several joining lines: the last one leads the body, as Enter opens a first child', () => {
		const f = callout();
		const { at } = put(f, 5, [line('a', 'a'), line('y', 'y')]);
		expect(tree(f)).toEqual([
			['h', 'callout', 'helloa', [P('y', 'y'), P('c1', 'body')]],
			P('z', 'after')
		]);
		expect(at).toEqual({ block: 'y', offset: 1 });
	});

	row("a joining first line's children come first, then the placed lines, then the body", () => {
		const f = callout();
		put(f, 5, [
			line('a', 'a', 'paragraph', { children: [line('n', 'n')] }),
			line('d', '', 'divider')
		]);
		expect(tree(f)).toEqual([
			[
				'h',
				'callout',
				'helloa',
				[P('n', 'n'), ['d', 'divider', ''], [fresh, 'paragraph', ''], P('c1', 'body')]
			],
			P('z', 'after')
		]);
	});

	row('an empty header: the divider leads the body too (Enter opens a first child)', () => {
		const f = callout('');
		put(f, 0, [line('d', '', 'divider')]);
		expect(tree(f)).toEqual([
			['h', 'callout', '', [['d', 'divider', ''], [fresh, 'paragraph', ''], P('c1', 'body')]],
			P('z', 'after')
		]);
	});

	// DR-rest-1: an empty header keeps its container kind and data; a typed first
	// line gives it its text only, so the body stays under the callout, as Enter.
	const h2 = (id: string, text: string) => line(id, text, 'heading', { data: { level: 'h2' } });
	const kept = (f) => {
		const [h] = f.toJSON().children;
		expect([h.type, h.data]).toEqual(['callout', { icon: 'i' }]);
	};

	row(
		'an empty header, a heading then a divider: the header keeps its kind and takes the text',
		() => {
			const f = callout('');
			put(f, 0, [h2('x', 'H'), line('d', '', 'divider')]);
			expect(tree(f)).toEqual([
				['h', 'callout', 'H', [['d', 'divider', ''], [fresh, 'paragraph', ''], P('c1', 'body')]],
				P('z', 'after')
			]);
			kept(f);
		}
	);

	row('an empty header, a heading then x: x leads the body; the header keeps its kind', () => {
		const f = callout('');
		const { at } = put(f, 0, [h2('x', 'H'), line('y', 'y')]);
		expect(tree(f)).toEqual([
			['h', 'callout', 'H', [P('y', 'y'), P('c1', 'body')]],
			P('z', 'after')
		]);
		kept(f);
		expect(at).toEqual({ block: 'y', offset: 1 });
	});

	row('an empty header, one heading: the header takes its text only', () => {
		const f = callout('');
		const { at } = put(f, 0, [h2('x', 'H')]);
		expect(tree(f)).toEqual([['h', 'callout', 'H', [P('c1', 'body')]], P('z', 'after')]);
		kept(f);
		expect(at).toEqual({ block: 'h', offset: 1 });
	});

	// SW18: an empty header with no body yet (an open toggle: Enter opens a first
	// child) keeps its kind for a joining first line, as one with a body does.
	row('an empty header without a body, one heading: it takes the text only', () => {
		const f = callout('', []);
		const { at } = put(f, 0, [h2('x', 'H')]);
		expect(tree(f)).toEqual([['h', 'callout', 'H'], P('z', 'after')]);
		kept(f);
		expect(at).toEqual({ block: 'h', offset: 1 });
	});

	row('an empty header without a body, a heading then y: y is its first line', () => {
		const f = callout('', []);
		const { at } = put(f, 0, [h2('x', 'H'), line('y', 'y')]);
		expect(tree(f)).toEqual([['h', 'callout', 'H', [P('y', 'y')]], P('z', 'after')]);
		kept(f);
		expect(at).toEqual({ block: 'y', offset: 1 });
	});

	row('an empty header without a body: a code block replaces it (`flow.apart`)', () => {
		const f = callout('', []);
		const { at } = put(f, 0, [code]);
		expect(tree(f)).toEqual([['k', 'code', '', [['k1', 'codeLine', 'let a']]], P('z', 'after')]);
		expect(at).toEqual({ block: 'k1', offset: 5 });
	});

	row("a closed header ('closed'): an empty one keeps its kind; its hidden body stays", () => {
		const f = callout('');
		const view = { header: () => 'closed', hidden: (id: string) => id === 'c1' };
		const { at } = put(f, 0, [h2('x', 'H'), line('y', 'y')], view);
		expect(tree(f)).toEqual([
			['h', 'callout', 'H', [P('c1', 'body')]],
			P('y', 'y'),
			P('z', 'after')
		]);
		kept(f);
		expect(at).toEqual({ block: 'y', offset: 1 });
	});

	// DR-crdt-1: a closed header shows no children, so a joined line's nested lines
	// never land in its hidden body: they are lines of the flow after it.
	const shut = { header: () => 'closed' as const, hidden: (id: string) => id === 'c1' };
	const nested = () => line('a', 'a', 'paragraph', { children: [line('n', 'b')] });

	row("a closed header ('closed'), empty: a joined line's nested lines go after it", () => {
		const f = callout('', []);
		const { at } = put(f, 0, [nested()], shut);
		expect(tree(f)).toEqual([['h', 'callout', 'a'], P('n', 'b'), P('z', 'after')]);
		expect(at).toEqual({ block: 'n', offset: 1 });
	});

	row("a closed header ('closed') at its end: nested lines go after it, the body stays", () => {
		const f = callout();
		const { at } = put(f, 5, [nested()], shut);
		expect(tree(f)).toEqual([
			['h', 'callout', 'helloa', [P('c1', 'body')]],
			P('n', 'b'),
			P('z', 'after')
		]);
		expect(at).toEqual({ block: 'n', offset: 1 });
	});

	row("a closed header ('closed') taking the last line: its nested lines go after it", () => {
		const f = callout('');
		const { at } = put(f, 0, [code, nested()], shut);
		expect(tree(f)).toEqual([
			['k', 'code', '', [['k1', 'codeLine', 'let a']]],
			['h', 'callout', 'a', [P('c1', 'body')]],
			P('n', 'b'),
			P('z', 'after')
		]);
		expect(at).toEqual({ block: 'n', offset: 1 });
	});

	row('mid-header, the text after the caret still takes the body (`flow.split`)', () => {
		const f = callout();
		put(f, 3, [line('d', '', 'divider')]);
		expect(tree(f)).toEqual([
			['h', 'callout', 'hel'],
			['d', 'divider', ''],
			[fresh, 'callout', 'lo', [P('c1', 'body')]],
			P('z', 'after')
		]);
	});

	row('headless (no `view.header`): the body moves to a new line of its kind', () => {
		const f = callout();
		put(f, 5, [line('d', '', 'divider')], {});
		expect(tree(f)).toEqual([
			['h', 'callout', 'hello'],
			['d', 'divider', ''],
			[fresh, 'callout', '', [P('c1', 'body')]],
			P('z', 'after')
		]);
	});
});

describe('flow.void — a block that cannot split takes one run', () => {
	row('lines into a void caption join with line breaks; children are not placed', () => {
		const f = make([b('img', 'cap', undefined, 'img'), b('z', 'after')]);
		const { at } = place(
			f,
			{ block: 'img', offset: 3 },
			{ lines: [run('x', 'X'), { ...run('y', 'Y'), children: [sb(b('k', 'kid'))] }] }
		);
		expect(tree(f)).toEqual([['img', 'img', 'capX\nY'], P('z', 'after')]);
		expect(at).toEqual({ block: 'img', offset: 6 });
	});
});

describe('flow.shape — the admitted flow', () => {
	row('an empty flow changes nothing: noop, zero bytes (F-P10 on the document)', () => {
		const d = made([b('e', '', undefined, 'heading', { level: 'h2' })]);
		const f = d.facade;
		const doc = d.doc;
		const before = JSON.stringify(f.toJSON());
		const o = observe(doc, () =>
			f.apply(f.prepare.insertFlow({ block: 'e', offset: 0 }, { lines: [] }))
		);
		expect(o.result.status).toBe('noop');
		expect(o.untouched).toBe(true);
		expect(JSON.stringify(f.toJSON())).toBe(before);
	});

	row('a line id that is taken refuses the op before any write (ids are fresh at ingress)', () => {
		const f = make([b('h', 'HelloWorld'), b('taken', 'x')]);
		for (const lines of [
			[run('x', 'X'), run('taken', 'Y')],
			[run('x', 'X'), { ...run('y', 'Y'), children: [sb(b('taken', 'k'))] }]
		]) {
			expect(f.prepare.insertFlow({ block: 'h', offset: 5 }, { lines }).status).toBe('refused');
		}
		expect(tree(f)).toEqual([P('h', 'HelloWorld'), P('taken', 'x')]);
	});

	row('a position must name shown text: a dead block or a list container refuses', () => {
		const f = make([b('l', '', [b('i', 'one', undefined, 'list-item')], 'ordered-list')]);
		const flow = { lines: [run('x', 'X')] };
		expect(f.prepare.insertFlow({ block: 'ghost', offset: 0 }, flow).status).toBe('refused');
		expect(f.prepare.insertFlow({ block: 'l', offset: 0 }, flow).status).toBe('refused');
	});

	row('one plan of named steps; prepare writes nothing', () => {
		const d = made([b('h', 'HelloWorld')]);
		const o = observe(d.doc, () =>
			d.facade.prepare.insertFlow(
				{ block: 'h', offset: 5 },
				{ lines: [run('x', 'X'), run('y', 'Y')] }
			)
		);
		expect(o.untouched).toBe(true);
		expect(o.result.writes.map((w) => w.op).sort()).toEqual(
			['insertText', 'insertText', 'splitBlock'].sort()
		);
		expect(o.result.effect.creates).toEqual(['y']);
	});
});

// ── F-O11 over flow placement (the D5 oracle) ──────────────────────────────

describe('F-O11 — the flow plan changes exactly its effect', () => {
	const E = bindEdytorDoc(Y);
	const roles = (t: string) =>
		t === 'box' ? { island: true } : t === 'img' ? { void: true } : undefined;
	for (const seed of [1, 2, 3]) {
		row(`seed ${seed}`, () => {
			const rand = rng(seed);
			const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
			const doc = new Y.Doc();
			doc.clientID = seed + 90;
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
				b(freshId(), ''),
				b(freshId(), 'cap', undefined, 'img'),
				b(freshId(), 'gamma', [b(freshId(), 'deep', [b(freshId(), 'deeper')])])
			];
			const spec = (x) => ({
				...x,
				content: x.content.map((c) => ({ kind: 'text', ...c })),
				...(x.children ? { children: x.children.map(spec) } : {})
			});
			f.init({ content: corpus().map(spec) });
			const randomLine = () => {
				const content =
					rand() < 0.2
						? []
						: [
								{ kind: 'text', text: pick(['X', 'yy', 'zzz']) },
								...(rand() < 0.3 ? [{ kind: 'inline', id: freshId(), type: 'mention' }] : [])
							];
				const kinded = rand() < 0.5;
				return {
					id: freshId(),
					...(kinded ? { type: pick(['paragraph', 'quote', 'heading']) } : {}),
					...(kinded && rand() < 0.5 ? { data: { level: 'h1' } } : {}),
					content,
					...(rand() < 0.2 ? { children: [spec(b(freshId(), 'kid'))] } : {})
				};
			};
			const seen = { refused: 0, noop: 0, applied: 0 };
			for (let step = 0; step < 150; step++) {
				const ids = [...f.listBlockIds(), 'ghost'];
				const target =
					rand() < 0.2
						? { replace: [pick(ids), pick(ids)] }
						: { block: pick(ids), offset: Math.floor(rand() * 7) };
				const n = Math.floor(rand() * 4);
				const flow = { lines: Array.from({ length: n }, randomLine), whole: rand() < 0.2 };
				const plan = f.prepare.insertFlow(target, flow);
				const r = prepareApply(f, doc, 'insertFlow', () => plan, `${step} insertFlow`);
				seen[r.status]++;
				if (r.status === 'applied') {
					// The caret names a live block, inside its display.
					expect(f.isVisibleBlock(plan.at.block), `${step}: caret block live`).toBe(true);
					expect(plan.at.offset).toBeLessThanOrEqual(f.displayLength(plan.at.block));
				}
				if (f.listBlockIds().length > 60) {
					f.deleteBlocks(f.childrenIds(null));
					f.insertBlocks({ parent: null, index: 0 }, corpus().map(spec));
				}
			}
			expect(seen.refused).toBeGreaterThan(0);
			expect(seen.applied).toBeGreaterThan(0);
		});
	}
});
