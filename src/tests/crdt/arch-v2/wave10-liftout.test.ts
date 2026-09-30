/**
 * Wave 10, AW-01 and AW-03: `liftOut` places a block where a kind fits —
 * out of every list around it that the kind does not fit, each split
 * around it — as one plan, so the view's Turn into (a heading out of a list
 * nested right in a list, a divider after an item) is one refusal and one
 * undo step. Every `converge` row runs under the plan §8 multi-replica rule
 * and holds every replica to `wellFormed`. Expected trees are hand-authored
 * from Notion's behaviour.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { allText, converge, tree } from './p1-harness.js';

const semantics = {
	roles: { divider: { void: true } },
	rendersContent: { divider: false, 'unordered-list': false },
	defaultChild: { 'unordered-list': 'list-item' }
};

/** `id:type[children]` of the visible tree, a block id an op minted shown as `NEW`. */
const typed = (ed) => {
	const show = (b) =>
		`${b.id}:${b.type}${b.children?.length ? `[${b.children.map(show).join(',')}]` : ''}`;
	return ed
		.toJSON()
		.children.map(show)
		.join(' ')
		.replace(/\bb_[A-Za-z0-9_-]+/g, 'NEW');
};
const shape = (ed) => tree(ed).replace(/\bb_[A-Za-z0-9_-]+/g, 'NEW');

const one = (outcomes) => {
	for (const o of outcomes) {
		expect(o.problems, 'no refusal, nothing pending, well-formed').toEqual([]);
		expect(o.results.size, 'every replica, observer order and reload agrees').toBe(1);
	}
	return outcomes;
};

const item = (id: string, text = id, children = []) => ({ id, type: 'list-item', text, children });
const para = (id: string, text = id) => ({ id, text });
const list = (id: string, ...items) => ({ id, type: 'unordered-list', text: '', children: items });

/** Lift `id` out as `kind`, retyped, as the view's Turn into composes it. */
const turnInto = (ed, id: string, kind: string, options?) =>
	ed.apply(ed.compose(ed.prepare.liftOut(id, kind, options), ed.prepare.setBlockType(id, kind)));

/** A single-replica row: `op` applies, the tree and kinds are as expected, one undo restores. */
const row = (seed, op: (ed) => { status: string }, shapeOut: string, kindsOut: string) => {
	for (const o of one(
		converge(
			seed,
			1,
			([a]) => {
				const before = typed(a.ed) + ' ' + tree(a.ed);
				expect(op(a.ed).status).toBe('applied');
				a.undo();
				expect(typed(a.ed) + ' ' + tree(a.ed)).toBe(before);
				a.redo();
			},
			{ semantics }
		)
	)) {
		expect(shape(o.ed)).toBe(shapeOut);
		expect(typed(o.ed)).toBe(kindsOut);
	}
};

/** `U[U2[b, c, x], d]`: c is a middle item of a list nested right in a list. */
const nested = () => [list('U', list('U2', item('b'), item('c'), item('x')), item('d'))];

describe('liftOut: a kind lands where it fits, every list around it split once (AW-01, AW-03)', () => {
	it('a middle item of a list nested right in a list leaves both, one plan and one undo', () =>
		row(
			nested(),
			(ed) => turnInto(ed, 'c', 'heading'),
			'NEW:""[NEW:""[b:"b"]] c:"c" U:""[U2:""[x:"x"],d:"d"]',
			'NEW:unordered-list[NEW:unordered-list[b:list-item]] c:heading U:unordered-list[U2:unordered-list[x:list-item],d:list-item]'
		));

	it('a first item leaves before both lists; the lists keep the rest', () =>
		row(
			nested(),
			(ed) => turnInto(ed, 'b', 'heading'),
			'b:"b" U:""[U2:""[c:"c",x:"x"],d:"d"]',
			'b:heading U:unordered-list[U2:unordered-list[c:list-item,x:list-item],d:list-item]'
		));

	it('a last item of the inner list splits only the outer one', () =>
		row(
			[list('U', list('U2', item('b'), item('c')), item('d'))],
			(ed) => turnInto(ed, 'c', 'heading'),
			'NEW:""[U2:""[b:"b"]] c:"c" U:""[d:"d"]',
			'NEW:unordered-list[U2:unordered-list[b:list-item]] c:heading U:unordered-list[d:list-item]'
		));

	it('an only item leaves both lists, which go', () =>
		row(
			[para('P'), list('U', list('U2', item('c'))), para('Q')],
			(ed) => turnInto(ed, 'c', 'heading'),
			'P:"P" c:"c" Q:"Q"',
			'P:paragraph c:heading Q:paragraph'
		));

	// As an outdent from the middle (ZW-03): a new list takes the items before the split.
	it('`keep`: a divider and a paragraph after an item go out, the list split after it', () =>
		row(
			[list('U', item('a'), item('b'), item('c'))],
			(ed) =>
				ed.liftOut('b', 'divider', {
					keep: true,
					after: [
						{ id: 'D', type: 'divider' },
						{ id: 'N', type: 'paragraph' }
					]
				}),
			'NEW:""[a:"a",b:"b"] D:"" N:"" U:""[c:"c"]',
			'NEW:unordered-list[a:list-item,b:list-item] D:divider N:paragraph U:unordered-list[c:list-item]'
		));

	it('a kind that fits where the block is only places `after` right after it', () =>
		row(
			[para('P'), para('Q')],
			(ed) => ed.liftOut('P', 'divider', { keep: true, after: [{ id: 'D', type: 'divider' }] }),
			'P:"P" D:"" Q:"Q"',
			'P:paragraph D:divider Q:paragraph'
		));
});

describe('liftOut under concurrency (AW-03)', () => {
	const ops = {
		'an item added after b': (ed) =>
			ed.insertBlock({ parent: 'U2', index: 1 }, { id: 'N', type: 'list-item' }),
		'x deleted': (ed) => ed.deleteBlock('x'),
		'b outdented': (ed) => ed.unNestBlock('b'),
		'd typed into': (ed) => ed.insertText('d', 1, '!')
	};
	for (const [name, op] of Object.entries(ops))
		it(`c turned into a heading ‖ ${name}: converges, well-formed, no text lost`, () => {
			for (const o of one(
				converge(
					nested(),
					2,
					([a, b]) => {
						expect(turnInto(a.ed, 'c', 'heading').status).toBe('applied');
						expect(op(b.ed).status).toBe('applied');
					},
					{ semantics }
				)
			)) {
				expect(typed(o.ed)).toMatch(/(^| )c:heading( |$)/);
				for (const text of ['b', 'c', 'd']) expect(allText(o.ed)).toContain(text);
			}
		});
});
