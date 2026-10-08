/**
 * Re-score 6 (`docs/archive/reviews/2026-09-30-rescore-6.md`), CRDT units ZW-01,
 * ZW-03, ZW-05, ZW-06 and ZW-14: the container rule has one owner, `fits`
 * — a list holds only its items (and lists of them), a columns layout only
 * its columns, a column any block. Every `converge` row runs under the plan
 * §8 multi-replica rule (three client-id assignments, both delivery orders,
 * duplicate delivery, binary reload) and every replica is held to
 * `wellFormed` after every write and delivery. Expected trees are
 * hand-authored from Notion's behaviour.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { allText, converge, tree } from './replica-harness.js';

/**
 * Lists, a table island (rows and cells), code as an island of lines, columns of columns.
 * Columns, C0 (`docs/columns-plan.md`): `columns` is a layout (`layout.*` in the delete contract).
 */
const semantics = {
	roles: {
		code: { island: true, lines: true },
		table: { island: true },
		divider: { void: true },
		image: { void: true },
		columns: { layout: true }
	},
	rendersContent: {
		code: false,
		divider: false,
		table: false,
		row: false,
		'unordered-list': false,
		'ordered-list': false,
		columns: false,
		column: false
	},
	defaultChild: {
		code: 'codeLine',
		'unordered-list': 'list-item',
		'ordered-list': 'list-item',
		table: 'row',
		row: 'cell',
		columns: 'column'
	}
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

/** Every outcome converged and well-formed. */
const one = (outcomes) => {
	for (const o of outcomes) {
		expect(o.problems, 'no refusal, nothing pending, well-formed').toEqual([]);
		expect(o.results.size, 'every replica, observer order and reload agrees').toBe(1);
	}
	return outcomes;
};

const item = (id: string, text = id, children = []) => ({ id, type: 'list-item', text, children });
const para = (id: string, text = id, children = []) => ({ id, text, children });
const list = (id: string, ...items) => ({ id, type: 'unordered-list', text: '', children: items });

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

/**
 * ZW-01: blocks a merge, an outdent, a delete or a range sheds landed
 * directly in the list they were shed into: a bullet-less paragraph inside
 * the `<ul>`, or a list with no item at all. A block landing directly in a
 * container it is no item of now becomes its item; a move (which never
 * retypes) is refused there, and Tab after a list nests under its last item.
 */
describe('ZW-01: nothing but an item lands directly in a list', () => {
	it('Delete above a list whose first item has a paragraph child → the child is an item', () =>
		row(
			[para('P', 'p'), list('U', item('I1', 'a', [para('C', 'child')]), item('I2', 'b'))],
			(ed) => ed.mergeForward('P'),
			'P:"pa" U:""[C:"child",I2:"b"]',
			'P:paragraph U:unordered-list[C:list-item,I2:list-item]'
		));

	it('…and of a one-item list → the list keeps the child as its item', () =>
		row(
			[para('P', 'p'), list('U', item('I1', 'a', [para('C', 'child')]))],
			(ed) => ed.mergeForward('P'),
			'P:"pa" U:""[C:"child"]',
			'P:paragraph U:unordered-list[C:list-item]'
		));

	it('Backspace at a middle item with a paragraph child → the child is an item', () =>
		row(
			[
				para('P', 'p'),
				list('U', item('I1', 'a'), item('I2', 'b', [para('C', 'child')]), item('I3', 'c'))
			],
			(ed) => ed.mergeBackward('I2'),
			'P:"p" U:""[I1:"ab",C:"child",I3:"c"]',
			'P:paragraph U:unordered-list[I1:list-item,C:list-item,I3:list-item]'
		));

	it('Tab on a paragraph right after a list → it nests under the last item (Notion)', () =>
		row(
			[para('P', 'p'), list('U', item('I1', 'a'), item('I2', 'b')), para('Q', 'q')],
			(ed) => ed.nestBlock('Q', 'U'),
			'P:"p" U:""[I1:"a",I2:"b"[Q:"q"]]',
			'P:paragraph U:unordered-list[I1:list-item,I2:list-item[Q:paragraph]]'
		));

	it('a move never lands a non-item in a list: canPlace and moveBlocks refuse it', () => {
		for (const o of one(
			converge(
				[para('P', 'p'), list('U', item('I1', 'a'), item('I2', 'b')), para('Q', 'q')],
				1,
				([a]) => {
					expect(a.ed.canPlace(['Q'], 'U')).toBe(false);
					expect(a.ed.moveBlocks(['Q'], { parent: 'U', index: 1 }).status).toBe('refused');
					expect(a.ed.moveBlock('Q', { parent: 'U', index: 2 }).status).toBe('refused');
					// Items, and a list of items, still move in.
					expect(a.ed.canPlace(['I2'], 'U')).toBe(true);
					expect(a.ed.canPlace(['Q'], 'I1')).toBe(true);
				},
				{ semantics }
			)
		))
			expect(tree(o.ed)).toBe('P:"p" U:""[I1:"a",I2:"b"] Q:"q"');
	});

	it('Shift+Tab on a paragraph nested under an item → an item of the list', () =>
		row(
			[para('P', 'p'), list('U', item('I1', 'a', [para('X', 'x'), para('Y', 'y')]))],
			(ed) => ed.unNestBlock('X'),
			'P:"p" U:""[I1:"a",X:"x"[Y:"y"]]',
			'P:paragraph U:unordered-list[I1:list-item,X:list-item[Y:paragraph]]'
		));

	it('deleting an item keeps its paragraph child in the list, as an item', () =>
		row(
			[para('P', 'p'), list('U', item('I1', 'a', [para('C', 'child')]), item('I2', 'b'))],
			(ed) => ed.deleteBlocks(['I1']),
			'P:"p" U:""[C:"child",I2:"b"]',
			'P:paragraph U:unordered-list[C:list-item,I2:list-item]'
		));

	it('a range whose rescue lands in the list → the rescued block is an item', () =>
		row(
			[
				para('P', 'p'),
				list('U', item('I1', 'a'), item('I2', 'b', [para('C', 'c', [para('D', 'd')])]))
			],
			(ed) => ed.deleteRange({ block: 'I1', offset: 1 }, { block: 'C', offset: 1 }),
			'P:"p" U:""[I1:"a",D:"d"]',
			'P:paragraph U:unordered-list[I1:list-item,D:list-item]'
		));

	it('an item retyped to a void sheds its paragraph child into the list as an item', () =>
		row(
			[para('P', 'p'), list('U', item('I1', 'a', [para('C', 'child')]))],
			(ed) => ed.setBlockType('I1', 'divider'),
			'P:"p" U:""[I1:"a",C:"child"]',
			'P:paragraph U:unordered-list[I1:divider,C:list-item]'
		));

	it('Ada pulls the first item up ‖ Bob adds a paragraph under it → Bob’s block is an item', () => {
		for (const o of one(
			converge(
				[para('P', 'p'), list('U', item('I1', 'a'), item('I2', 'b'))],
				2,
				([a, b]) => {
					expect(a.ed.mergeForward('P').status).toBe('applied');
					b.ed.insertBlocks({ parent: 'I1', index: 0 }, [
						{ id: 'C', type: 'paragraph', content: [{ kind: 'text', text: 'c' }] }
					]);
				},
				{ semantics }
			)
		)) {
			expect(allText(o.ed)).toBe('pacb');
			expect(typed(o.ed)).not.toMatch(/unordered-list\[[^\]]*:paragraph/);
		}
	});
});

/**
 * ZW-14: the contract promised that a block never lands directly in a
 * container it is no item of, while a pinned row outdented a column's last
 * paragraph into the columns layout. The rule wins (Notion: nothing sits
 * directly in a column list): the outdent, and Backspace at a one-paragraph
 * column (an outdent: its only paragraph is its last), are refused; a move
 * there is refused; Tab after the layout nests in its last column.
 *
 * Changed by the columns plan (D4, `layout.merge`): Backspace at a column's
 * first paragraph (`mergeBackward`) is no longer refused — it merges into
 * the previous line in reading order. The outdent refusals stay.
 */
describe('ZW-14: nothing lands directly in a columns layout but a column', () => {
	const seed = [
		para('P', 'p'),
		{
			id: 'C',
			type: 'columns',
			text: '',
			children: [
				{ id: 'K1', type: 'column', text: '', children: [para('A', 'a'), para('A2', 'a2')] },
				{ id: 'K2', type: 'column', text: '', children: [para('B', 'b')] }
			]
		},
		para('Z', 'z')
	];
	const before =
		'P:paragraph C:columns[K1:column[A:paragraph,A2:paragraph],K2:column[B:paragraph]] Z:paragraph';

	it('Backspace/Shift+Tab at a column’s last or only paragraph, and a move into the layout → refused', () => {
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => {
					expect(a.ed.unNestBlock('A2').status).toBe('refused');
					expect(a.ed.unNestBlock('B').status).toBe('refused');
					expect(a.ed.moveBlocks(['Z'], { parent: 'C', index: 1 }).status).toBe('refused');
					// A column holds any block: a heading moves into one.
					expect(a.ed.canPlace(['Z'], 'K1')).toBe(true);
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe(before);
	});

	it('Backspace at the second column’s first paragraph → it joins the first column’s last (D4)', () =>
		row(
			seed,
			(ed) => ed.mergeBackward('B'),
			'P:"p" A:"a" A2:"a2b" Z:"z"',
			'P:paragraph A:paragraph A2:paragraph Z:paragraph'
		));

	it('Backspace at the first column’s first paragraph → it joins the line before (D4)', () =>
		row(
			seed,
			(ed) => ed.mergeBackward('A'),
			'P:"pa" C:""[K1:""[A2:"a2"],K2:""[B:"b"]] Z:"z"',
			'P:paragraph C:columns[K1:column[A2:paragraph],K2:column[B:paragraph]] Z:paragraph'
		));

	it('Tab on the paragraph after the layout → it nests in the last column', () =>
		row(
			seed,
			(ed) => ed.nestBlock('Z', 'C'),
			'P:"p" C:""[K1:""[A:"a",A2:"a2"],K2:""[B:"b",Z:"z"]]',
			'P:paragraph C:columns[K1:column[A:paragraph,A2:paragraph],K2:column[B:paragraph,Z:paragraph]]'
		));
});

/**
 * ZW-03: Shift+Tab on a middle item moved the items after it into a new
 * list, so an item a peer appended to the list meanwhile (Enter at the end
 * of its last item) stayed in the upper half, above the outdented block.
 * The list now keeps the items after the outdented ones and a new list
 * takes the items before them.
 */
describe('ZW-03: a list split by Shift+Tab keeps a peer’s concurrent append in its lower half', () => {
	const three = [para('P', 'p'), list('U', item('I1', 'a'), item('I2', 'b'), item('I3', 'c'))];

	it('Ada outdents I2 ‖ Bob splits I3 at its end and types → Bob’s item follows I3', () => {
		for (const o of one(
			converge(
				three,
				2,
				([a, b]) => {
					expect(a.ed.unNestBlock('I2').status).toBe('applied');
					expect(b.ed.splitBlock('I3', 1, 'I4').status).toBe('applied');
					expect(b.ed.insertText('I4', 0, 'd').status).toBe('applied');
				},
				{ semantics }
			)
		)) {
			expect(shape(o.ed)).toBe('P:"p" NEW:""[I1:"a"] I2:"b" U:""[I3:"c",I4:"d"]');
			expect(typed(o.ed)).toBe(
				'P:paragraph NEW:unordered-list[I1:list-item] I2:paragraph U:unordered-list[I3:list-item,I4:list-item]'
			);
		}
	});

	it('Ada outdents I2 ‖ Bob appends an item → Bob’s item follows I3', () => {
		for (const o of one(
			converge(
				three,
				2,
				([a, b]) => {
					a.ed.unNestBlock('I2');
					b.ed.insertBlocks({ parent: 'U', index: 3 }, [
						{ id: 'I4', type: 'list-item', content: [{ kind: 'text', text: 'd' }] }
					]);
				},
				{ semantics }
			)
		))
			expect(shape(o.ed)).toBe('P:"p" NEW:""[I1:"a"] I2:"b" U:""[I3:"c",I4:"d"]');
	});

	it('…and Ada’s undo after hearing Bob puts I2 back; Bob’s item stays last', () => {
		for (const o of one(
			converge(
				three,
				2,
				([a, b]) => {
					a.ed.unNestBlock('I2');
					b.ed.insertBlocks({ parent: 'U', index: 3 }, [
						{ id: 'I4', type: 'list-item', content: [{ kind: 'text', text: 'd' }] }
					]);
					a.receiveAll(b.log);
					a.undo();
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe(
				'P:paragraph U:unordered-list[I1:list-item,I2:list-item,I3:list-item,I4:list-item]'
			);
	});

	/**
	 * Case D (both peers outdent): the text keeps its order and every
	 * replica converges; a list the two outdents together leave with no
	 * item shows nothing and the next key next to it removes it
	 * (`del.merge.container`).
	 */
	it('Ada outdents I2 ‖ Bob outdents I3 → b before c; the emptied list shows nothing', () => {
		for (const o of one(
			converge(
				three,
				2,
				([a, b]) => {
					a.ed.unNestBlock('I2');
					b.ed.unNestBlock('I3');
				},
				{ semantics }
			)
		)) {
			expect(shape(o.ed)).toBe('P:"p" NEW:""[I1:"a"] I2:"b" U:"" I3:"c"');
			expect(o.ed.mergeForward('I2').status).toBe('applied');
			expect(shape(o.ed)).toBe('P:"p" NEW:""[I1:"a"] I2:"b" I3:"c"');
		}
	});

	it('both outdent I2 → a, b, c keep their order; one of the two new lists shows nothing', () => {
		for (const o of one(
			converge(
				three,
				2,
				([a, b]) => {
					a.ed.unNestBlock('I2');
					b.ed.unNestBlock('I2');
				},
				{ semantics }
			)
		)) {
			expect(allText(o.ed)).toBe('pabc');
			// Each peer made a list for I1; one of them is left empty, before or after I2.
			expect(shape(o.ed)).toMatch(
				/^P:"p" (NEW:"" )?NEW:""\[I1:"a"\] (NEW:"" )?I2:"b" (NEW:"" )?U:""\[I3:"c"\]$/
			);
			expect(shape(o.ed).match(/NEW:"" /g)?.length ?? 0).toBe(1);
		}
	});
});

/**
 * ZW-05: the empty-container rule had two definitions. A text range over
 * the seam into a list holding hidden text of its own (a peer's retype)
 * removed the list with that text; the Delete key keeps it.
 */
describe('ZW-05: a range keeps a list holding hidden text, as the key does', () => {
	const seed = [
		para('P', 'p'),
		{ id: 'U', type: 'unordered-list', text: 'hid', children: [item('I1', 'a')] },
		para('Z', 'z')
	];

	it('deleteRange(P@1 → I1@1) → the list stays, with its text and no item', () => {
		for (const o of one(
			converge(
				seed,
				1,
				([a]) =>
					expect(
						a.ed.deleteRange({ block: 'P', offset: 1 }, { block: 'I1', offset: 1 }).status
					).toBe('applied'),
				{ semantics }
			)
		))
			expect(tree(o.ed)).toBe('P:"p" U:"hid" Z:"z"');
	});

	it('the key path agrees: Delete above pulls the item up, the list keeps its text', () => {
		for (const o of one(
			converge(seed, 1, ([a]) => expect(a.ed.mergeForward('P').status).toBe('applied'), {
				semantics
			})
		))
			expect(tree(o.ed)).toBe('P:"pa" U:"hid" Z:"z"');
	});
});

/**
 * ZW-06: a line kind stored outside its island shows its slot's default
 * child — and where that renders no content (a column in a columns
 * layout), the document's default kind: never a line kind outside its
 * island (FW-01).
 *
 * Changed by the columns plan (`layout.only-items`, `layout.single`): a
 * column retyped to a line kind is no column, so it leaves the layout and
 * shows right after it — still as a paragraph, never a line kind — and the
 * layout, left with one column, dissolves into its blocks.
 */
describe('ZW-06: a line kind never shows outside its island', () => {
	const seed = [
		{
			id: 'C',
			type: 'columns',
			text: '',
			children: [
				{ id: 'K1', type: 'column', text: '', children: [para('A', 'a')] },
				{ id: 'K2', type: 'column', text: '', children: [para('B', 'b')] }
			]
		}
	];

	it('setBlockType(K2, codeLine) under a columns layout → K2 shows a paragraph', () => {
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => expect(a.ed.setBlockType('K2', 'codeLine').status).toBe('applied'),
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('A:paragraph K2:paragraph[B:paragraph]');
	});
});

/**
 * SW9-containers-1: pasted paragraphs landed in the list as they were: a
 * bullet-less paragraph inside the `<ul>`, the ZW-01 shape through paste. A
 * plain line that lands directly in a container takes its item kind, as a
 * shed block does; any other kind keeps its kind and data (DR-crdt-1).
 */
describe('SW9-containers-1: pasted plain lines land in a list as its items', () => {
	const seed = [para('P', 'p'), list('U', item('I1', 'ab'), item('I2', 'c'))];
	const line = (id: string, type: string, text: string) => ({
		id,
		type,
		content: [{ kind: 'text', text }]
	});

	it('three lines into an item → the middle paragraph is an item; the heading stays a heading', () =>
		row(
			seed,
			(ed) =>
				ed.insertFlow(
					{ block: 'I1', offset: 1 },
					{
						lines: [
							line('L1', 'paragraph', 'x'),
							line('L2', 'paragraph', 'm'),
							line('L3', 'heading', 'y')
						]
					}
				),
			'P:"p" U:""[I1:"ax",L2:"m",L3:"yb",I2:"c"]',
			'P:paragraph U:unordered-list[I1:list-item,L2:list-item,L3:heading,I2:list-item]'
		));

	it('a whole-block paste after an item → an item', () =>
		row(
			seed,
			(ed) =>
				ed.insertFlow(
					{ block: 'I1', offset: 2 },
					{ lines: [line('W', 'paragraph', 'w')], whole: true }
				),
			'P:"p" U:""[I1:"ab",W:"w",I2:"c"]',
			'P:paragraph U:unordered-list[I1:list-item,W:list-item,I2:list-item]'
		));

	it('a paragraph line into an empty item keeps it an item; a heading line makes it a heading', () => {
		row(
			[para('P', 'p'), list('U', item('I1', ''), item('I2', 'c'))],
			(ed) => ed.insertFlow({ block: 'I1', offset: 0 }, { lines: [line('L1', 'paragraph', 'h')] }),
			'P:"p" U:""[I1:"h",I2:"c"]',
			'P:paragraph U:unordered-list[I1:list-item,I2:list-item]'
		);
		row(
			[para('P', 'p'), list('U', item('I1', ''), item('I2', 'c'))],
			(ed) => ed.insertFlow({ block: 'I1', offset: 0 }, { lines: [line('L1', 'heading', 'h')] }),
			'P:"p" U:""[I1:"h",I2:"c"]',
			'P:paragraph U:unordered-list[I1:heading,I2:list-item]'
		);
	});
});

/**
 * SW9-containers-2: deleting a list's last item together with the last item
 * of a list nested directly in it removed the nested list but left the
 * outer one with no item — an invisible block that seals its neighbours.
 * The containers a set of leaving blocks empties are found together.
 */
describe('SW9-containers-2: a block set emptying nested lists removes them all', () => {
	it('deleteBlocks([U3, J]) of U[O[J], U3] → both lists go; one undo restores them', () =>
		row(
			[
				para('P', 'p'),
				list(
					'U',
					{ id: 'O', type: 'ordered-list', text: '', children: [item('J', 'j')] },
					item('U3', 'c')
				),
				para('Z', 'z')
			],
			(ed) => ed.deleteBlocks(['U3', 'J']),
			'P:"p" Z:"z"',
			'P:paragraph Z:paragraph'
		));

	it('moving both out to the root → both lists go', () =>
		row(
			[
				para('P', 'p'),
				list(
					'U',
					{ id: 'O', type: 'ordered-list', text: '', children: [item('J', 'j')] },
					item('U3', 'c')
				)
			],
			(ed) => ed.moveBlocks(['J', 'U3'], { parent: null, index: 0 }),
			'J:"j" U3:"c" P:"p"',
			'J:list-item U3:list-item P:paragraph'
		));
});

/**
 * SW9-containers-3 (found by the container fuzz): Ada deletes a list item,
 * keeping its paragraph child (which becomes an item), while Bob splits
 * that paragraph. Bob's new block, promoted out of the deleted item into
 * the list at read time, showed as a bare paragraph inside the list on
 * every replica. A block promoted into a container shows its item kind as
 * a written one takes it (`settledKind`).
 */
describe('SW9-containers-3: a block promoted into a list at read time shows as an item', () => {
	it('Ada deletes I1 (keeping its child) ‖ Bob splits the child → both are items', () => {
		for (const o of one(
			converge(
				[para('P', 'p'), list('U', item('I1', 'a', [para('C', 'child')]), item('I2', 'b'))],
				2,
				([a, b]) => {
					expect(a.ed.deleteBlock('I1').status).toBe('applied');
					expect(b.ed.splitBlock('C', 2, 'C2').status).toBe('applied');
				},
				{ semantics }
			)
		)) {
			expect(tree(o.ed)).toBe('P:"p" U:""[C:"ch",C2:"ild",I2:"b"]');
			expect(typed(o.ed)).toBe(
				'P:paragraph U:unordered-list[C:list-item,C2:list-item,I2:list-item]'
			);
		}
	});
});

/**
 * DR-crdt-1 (follow-up review of ZW-01): the container rule turned every
 * block it shed or pasted into a list into the list's item — an image
 * nested under a bullet became an empty bullet, a code block a list item
 * over paragraphs, a pasted image lost its `src`, a to-do its check. Only a
 * plain block (the document's default kind) is refitted; any other kind
 * keeps its kind and data where it lands, as a peer's concurrent promotion
 * shows it, and an outdent that would place one directly in a list is
 * refused, as a move there is.
 */
describe('DR-crdt-1: a void or an island shed into a list keeps its kind and data', () => {
	const img = (id: string) => ({ id, type: 'image', text: '', data: { src: 'x.png' } });
	const code = (id: string) => ({
		id,
		type: 'code',
		text: '',
		data: { language: 'js' },
		children: [{ id: `${id}l`, type: 'codeLine', text: 'let x' }]
	});
	const dataOf = (ed, id: string) => {
		const find = (bs) => {
			for (const b of bs ?? []) {
				if (b.id === id) return b;
				const hit = find(b.children);
				if (hit) return hit;
			}
		};
		return find(ed.toJSON().children)?.data;
	};
	/** `row`, and the block `id` keeps `data`. */
	const kept = (seed, op, shapeOut: string, kindsOut: string, id: string, data) => {
		row(seed, op, shapeOut, kindsOut);
		for (const o of converge(
			seed,
			1,
			([a]) => {
				op(a.ed);
			},
			{ semantics }
		))
			expect(dataOf(o.ed, id)).toEqual(data);
	};

	it('Backspace at a middle item with an image child → the image stays an image', () =>
		kept(
			[para('P', 'p'), list('U', item('I1', 'a'), item('I2', 'b', [img('IMG')]), item('I3', 'c'))],
			(ed) => ed.mergeBackward('I2'),
			'P:"p" U:""[I1:"ab",IMG:"",I3:"c"]',
			'P:paragraph U:unordered-list[I1:list-item,IMG:image,I3:list-item]',
			'IMG',
			{ src: 'x.png' }
		));

	it('Backspace at a middle item with a code child → the code block keeps its kind and lines', () =>
		kept(
			[para('P', 'p'), list('U', item('I1', 'a'), item('I2', 'b', [code('K')]), item('I3', 'c'))],
			(ed) => ed.mergeBackward('I2'),
			'P:"p" U:""[I1:"ab",K:""[Kl:"let x"],I3:"c"]',
			'P:paragraph U:unordered-list[I1:list-item,K:code[Kl:codeLine],I3:list-item]',
			'K',
			{ language: 'js' }
		));

	it('Delete above a list whose first item has an image child → the image stays an image', () =>
		kept(
			[para('P', 'p'), list('U', item('I1', 'a', [img('IMG')]), item('I2', 'b'))],
			(ed) => ed.mergeForward('P'),
			'P:"pa" U:""[IMG:"",I2:"b"]',
			'P:paragraph U:unordered-list[IMG:image,I2:list-item]',
			'IMG',
			{ src: 'x.png' }
		));

	it('deleting the item keeps its image child an image', () =>
		kept(
			[para('P', 'p'), list('U', item('I1', 'a', [img('IMG')]), item('I2', 'b'))],
			(ed) => ed.deleteBlocks(['I1']),
			'P:"p" U:""[IMG:"",I2:"b"]',
			'P:paragraph U:unordered-list[IMG:image,I2:list-item]',
			'IMG',
			{ src: 'x.png' }
		));

	it('an item retyped to a void sheds its code child as a code block', () =>
		kept(
			[para('P', 'p'), list('U', item('I1', 'a', [code('K')]))],
			(ed) => ed.setBlockType('I1', 'divider'),
			'P:"p" U:""[I1:"a",K:""[Kl:"let x"]]',
			'P:paragraph U:unordered-list[I1:divider,K:code[Kl:codeLine]]',
			'K',
			{ language: 'js' }
		));

	it('a range whose rescue lands an image in the list → it stays an image', () =>
		kept(
			[para('P', 'p'), list('U', item('I1', 'a'), item('I2', 'b', [para('C', 'c', [img('IMG')])]))],
			(ed) => ed.deleteRange({ block: 'I1', offset: 1 }, { block: 'C', offset: 1 }),
			'P:"p" U:""[I1:"a",IMG:""]',
			'P:paragraph U:unordered-list[I1:list-item,IMG:image]',
			'IMG',
			{ src: 'x.png' }
		));

	it('Backspace at a middle item with a heading child → the heading stays a heading', () =>
		kept(
			[
				para('P', 'p'),
				list(
					'U',
					item('I1', 'a'),
					item('I2', 'b', [{ id: 'H', type: 'heading', text: 'h', data: { level: 2 } }]),
					item('I3', 'c')
				)
			],
			(ed) => ed.mergeBackward('I2'),
			'P:"p" U:""[I1:"ab",H:"h",I3:"c"]',
			'P:paragraph U:unordered-list[I1:list-item,H:heading,I3:list-item]',
			'H',
			{ level: 2 }
		));

	it('Shift+Tab on an image under an item is refused (it would sit directly in the list)', () => {
		for (const o of one(
			converge(
				[para('P', 'p'), list('U', item('I1', 'a', [img('IMG'), para('X', 'x')]))],
				1,
				([a]) => {
					expect(a.ed.unNestBlock('IMG').status).toBe('refused');
					expect(a.ed.unNestBlocks(['IMG', 'X']).status).toBe('refused');
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('P:paragraph U:unordered-list[I1:list-item[IMG:image,X:paragraph]]');
	});

	it('a pasted whole image after an item stays an image with its src', () =>
		kept(
			[para('P', 'p'), list('U', item('I1', 'ab'), item('I2', 'c'))],
			(ed) =>
				ed.insertFlow(
					{ block: 'I1', offset: 2 },
					{ lines: [{ id: 'IMG', type: 'image', data: { src: 'x.png' } }], whole: true }
				),
			'P:"p" U:""[I1:"ab",IMG:"",I2:"c"]',
			'P:paragraph U:unordered-list[I1:list-item,IMG:image,I2:list-item]',
			'IMG',
			{ src: 'x.png' }
		));

	it('a pasted middle image line stays an image, a to-do a to-do with its check', () =>
		kept(
			[para('P', 'p'), list('U', item('I1', 'ab'), item('I2', 'c'))],
			(ed) =>
				ed.insertFlow(
					{ block: 'I1', offset: 1 },
					{
						lines: [
							{ id: 'L1', type: 'paragraph', content: [{ kind: 'text', text: 'x' }] },
							{ id: 'IMG', type: 'image', data: { src: 'x.png' } },
							{
								id: 'T',
								type: 'todo',
								data: { checked: true },
								content: [{ kind: 'text', text: 't' }]
							},
							{ id: 'L3', type: 'paragraph', content: [{ kind: 'text', text: 'y' }] }
						]
					}
				),
			'P:"p" U:""[I1:"ax",IMG:"",T:"t",L3:"yb",I2:"c"]',
			'P:paragraph U:unordered-list[I1:list-item,IMG:image,T:todo,L3:list-item,I2:list-item]',
			'T',
			{ checked: true }
		));
});
