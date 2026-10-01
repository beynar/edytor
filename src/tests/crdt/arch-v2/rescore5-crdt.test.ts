/**
 * Re-score 5 (`docs/reviews/2026-09-30-rescore-5.md`), CRDT units YW-02,
 * YW-07 and YW-08. Every `converge` row runs under the plan §8 multi-replica
 * rule (three client-id assignments, both delivery orders, duplicate
 * delivery, binary reload) and every replica is held to `wellFormed` after
 * every write and delivery. Expected trees are hand-authored from the
 * units' "Done when" lines and Notion's behaviour.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { converge, tree } from './p1-harness.js';
import { createDocument } from '../../../lib/crdt/index.js';
import { readData } from '../../../lib/crdt/data.js';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../oracles/model-ops.js';

const M = bindModel(Y);

/** Lists and a table island (rows and cells), code as an island of lines. */
const semantics = {
	roles: {
		code: { island: true, lines: true },
		table: { island: true }
	},
	rendersContent: {
		code: false,
		table: false,
		row: false,
		'unordered-list': false,
		'ordered-list': false
	},
	defaultChild: {
		code: 'codeLine',
		'unordered-list': 'list-item',
		'ordered-list': 'list-item',
		table: 'row',
		row: 'cell'
	}
};

/** `id:type[children]` of the visible tree. */
const typed = (ed) => {
	const show = (b) =>
		`${b.id}:${b.type}${b.children?.length ? `[${b.children.map(show).join(',')}]` : ''}`;
	return ed.toJSON().children.map(show).join(' ');
};

/** Every outcome converged and well-formed. */
const one = (outcomes) => {
	for (const o of outcomes) {
		expect(o.problems, 'no refusal, nothing pending, well-formed').toEqual([]);
		expect(o.results.size, 'every replica, observer order and reload agrees').toBe(1);
	}
	return outcomes;
};

const item = (id: string, text = id, children = []) => ({ id, type: 'list-item', text, children });
const listOf = (type: string, ...items) => [
	{ id: 'P', text: 'p' },
	{ id: 'U', type, text: '', children: items }
];

/**
 * YW-02: a container that renders no content of its own (a list, a table
 * row) is never merged away by a key merge. Delete above it pulls its first
 * item's text up and leaves the container with the rest (Notion); Backspace
 * at the start of its first item lifts the item out, as its new parent's
 * default child. A container left with no child goes too
 * (`del.range.empty-container`). Inside an island nothing leaves: a first
 * cell stays refused.
 */
describe('YW-02: a key merge next to a container that renders no content keeps the container', () => {
	for (const kind of ['unordered-list', 'ordered-list']) {
		it(`Delete above a ${kind} pulls its first item up; the list keeps the rest`, () => {
			for (const o of one(
				converge(
					listOf(kind, item('I1', 'a'), item('I2', 'b')),
					1,
					([a]) => {
						expect(a.ed.canMerge('U', 'P')).toBe(false);
						expect(a.ed.mergeForward('P').status).toBe('applied');
					},
					{ semantics }
				)
			)) {
				expect(tree(o.ed)).toBe('P:"pa" U:""[I2:"b"]');
				expect(typed(o.ed)).toBe(`P:paragraph U:${kind}[I2:list-item]`);
			}
		});

		it(`Delete above a one-item ${kind} pulls the item up; the emptied list goes`, () => {
			for (const o of one(
				converge(
					listOf(kind, item('I1', 'a')),
					1,
					([a]) => expect(a.ed.mergeForward('P').status).toBe('applied'),
					{ semantics }
				)
			))
				expect(tree(o.ed)).toBe('P:"pa"');
		});

		it(`Backspace at the first item of a ${kind} lifts it out as a paragraph`, () => {
			for (const o of one(
				converge(
					listOf(kind, item('I1', 'a', [item('J', 'j')]), item('I2', 'b')),
					1,
					([a]) => expect(a.ed.mergeBackward('I1').status).toBe('applied'),
					{ semantics }
				)
			)) {
				expect(tree(o.ed)).toBe('P:"p" I1:"a"[J:"j"] U:""[I2:"b"]');
				expect(typed(o.ed)).toBe(`P:paragraph I1:paragraph[J:list-item] U:${kind}[I2:list-item]`);
			}
		});

		it(`Backspace at the only item of a ${kind} lifts it out; the emptied list goes`, () => {
			for (const o of one(
				converge(
					listOf(kind, item('I1', 'a')),
					1,
					([a]) => expect(a.ed.mergeBackward('I1').status).toBe('applied'),
					{ semantics }
				)
			))
				expect(typed(o.ed)).toBe('P:paragraph I1:paragraph');
		});
	}

	it('the first item’s children stay in the list, in its place', () => {
		for (const o of one(
			converge(
				listOf('unordered-list', item('I1', 'a', [item('J', 'j')]), item('I2', 'b')),
				1,
				([a]) => expect(a.ed.mergeForward('P').status).toBe('applied'),
				{ semantics }
			)
		))
			expect(tree(o.ed)).toBe('P:"pa" U:""[J:"j",I2:"b"]');
	});

	it('a container never merges as a whole: canMerge, mergeBlocks and mergeBackward refuse it', () => {
		for (const o of one(
			converge(
				listOf('unordered-list', item('I1', 'a')),
				1,
				([a]) => {
					expect(a.ed.canMerge('U', 'P')).toBe(false);
					expect(a.ed.mergeBlocks('U', 'P').status).toBe('refused');
					expect(a.ed.mergeBackward('U').status).toBe('refused');
					expect(a.ed.mergeForward('U').status).toBe('refused');
				},
				{ semantics }
			)
		))
			expect(tree(o.ed)).toBe('P:"p" U:""[I1:"a"]');
	});

	it('Ada pulls the first item up ‖ Bob adds an item above it → the list keeps Bob’s item', () => {
		for (const o of one(
			converge(
				listOf('unordered-list', item('I1', 'a'), item('I2', 'b')),
				2,
				([a, b]) => {
					expect(a.ed.mergeForward('P').status).toBe('applied');
					expect(
						b.ed.insertBlocks({ parent: 'U', index: 0 }, [
							{ id: 'I0', type: 'list-item', content: [{ kind: 'text', text: 'z' }] }
						]).status
					).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(tree(o.ed)).toBe('P:"pa" U:""[I0:"z",I2:"b"]');
	});

	it('Ada lifts the only item ‖ Bob adds a second one → Bob’s item is kept', () => {
		for (const o of one(
			converge(
				listOf('unordered-list', item('I1', 'a')),
				2,
				([a, b]) => {
					expect(a.ed.mergeBackward('I1').status).toBe('applied');
					expect(
						b.ed.insertBlocks({ parent: 'U', index: 1 }, [
							{ id: 'I2', type: 'list-item', content: [{ kind: 'text', text: 'b' }] }
						]).status
					).toBe('applied');
				},
				{ semantics }
			)
		)) {
			// Bob's item leaves the removed list as a paragraph (DR-crdt-2).
			expect(tree(o.ed)).toBe('P:"p" I1:"a" I2:"b"');
			expect(typed(o.ed)).toBe('P:paragraph I1:paragraph I2:paragraph');
		}
	});

	describe('table island', () => {
		const table = (...rows) => [
			{ id: 'P', text: 'p' },
			{ id: 'T', type: 'table', text: '', children: rows }
		];
		const row = (id: string, ...cells: string[]) => ({
			id,
			type: 'row',
			text: '',
			children: cells.map((c) => ({ id: `c${c}`, type: 'cell', text: c }))
		});

		it('Delete at the end of a row’s last cell pulls the next row’s first cell into it', () => {
			for (const o of one(
				converge(
					table(row('R1', '1'), row('R2', '2', '3')),
					1,
					([a]) => expect(a.ed.mergeForward('c1').status).toBe('applied'),
					{ semantics }
				)
			))
				expect(tree(o.ed)).toBe('P:"p" T:""[R1:""[c1:"12"],R2:""[c3:"3"]]');
		});

		it('…and a row left with no cell goes; no cell ever sits directly under the table', () => {
			for (const o of one(
				converge(
					table(row('R1', '1'), row('R2', '2')),
					1,
					([a]) => expect(a.ed.mergeForward('c1').status).toBe('applied'),
					{ semantics }
				)
			))
				expect(typed(o.ed)).toBe('P:paragraph T:table[R1:row[c1:cell]]');
		});

		it('Backspace at a row’s first cell stays refused (nothing leaves an island)', () => {
			for (const o of one(
				converge(
					table(row('R1', '1'), row('R2', '2')),
					1,
					([a]) => {
						expect(a.ed.mergeBackward('c2').status).toBe('refused');
						expect(a.ed.mergeBackward('c1').status).toBe('refused');
					},
					{ semantics }
				)
			))
				expect(tree(o.ed)).toBe('P:"p" T:""[R1:""[c1:"1"],R2:""[c2:"2"]]');
		});
	});
});

/**
 * YW-07: a split's explicit tail type can be the `''` a view reads while a
 * peer's retype is half-delivered (the type attr's old value deleted, the
 * new one pending). The facade takes an empty tail type as "copy the kind",
 * which falls back to the parent's default child (SW7-crdt-1), never `''`.
 * This covers every explicit-tail caller: the view's Enter (`liftContent`,
 * `splitHeader`), `block.split` and room `transact`.
 */
describe('YW-07: a split never writes an explicit empty tail type', () => {
	const typeless = () => {
		const document = createDocument({
			value: {
				children: [
					{
						id: 'Q',
						type: 'quote',
						content: [{ text: 'q' }],
						children: [
							{
								id: 'A',
								type: 'paragraph',
								content: [{ text: 'hello' }],
								children: [{ id: 'A1', type: 'paragraph', content: [{ text: 'a1' }] }]
							}
						]
					}
				]
			},
			semantics
		});
		M.blockNodeOf(document.doc, 'A').deleteAttr('type');
		return document;
	};

	it('splitBlock with tail { type: "" } → the tail is its parent’s default child', () => {
		const document = typeless();
		const ed = document.facade;
		expect(ed.splitBlock('A', 5, 'B', { type: '', data: { x: 1 } }).status).toBe('applied');
		expect(M.blockNodeOf(document.doc, 'B').getAttr('type')).toBe('paragraph');
		expect(readData(M.blockNodeOf(document.doc, 'B'))).toEqual({ x: 1 });
		document.destroy();
	});

	it('block.split and transact take the same path', () => {
		const document = typeless();
		const ed = document.facade;
		expect(ed.block('A').split(5, 'B', { type: '' }).status).toBe('applied');
		ed.transact(() => ed.splitBlock('B', 0, 'C', { type: '' }));
		for (const id of ['B', 'C'])
			expect(M.blockNodeOf(document.doc, id).getAttr('type')).toBe('paragraph');
		document.destroy();
	});
});

/**
 * A mirror of the shown kinds an onChange-tracked view holds: seeded from
 * `toJSON()`, then fed only the reports (`added` subtrees and `meta`).
 * `stale()` lists every visible block whose mirrored kind is not the one
 * the model shows.
 */
const mirror = (ed) => {
	const kinds = new Map<string, string>();
	const take = (b) => {
		kinds.set(b.id, b.type);
		for (const c of b.children ?? []) take(c);
	};
	for (const b of ed.toJSON().children) take(b);
	ed.onChange((c) => {
		for (const b of c.added.values()) take(b);
		for (const [id, { type }] of c.meta) kinds.set(id, type);
	});
	return {
		stale: () => {
			const out: string[] = [];
			const visit = (b) => {
				if (kinds.get(b.id) !== b.type)
					out.push(`${b.id}: view ${kinds.get(b.id)}, model ${b.type}`);
				for (const c of b.children ?? []) visit(c);
			};
			for (const b of ed.toJSON().children) visit(b);
			return out;
		}
	};
};

/**
 * YW-08: a retype into (or out of) a line kind changes which kind the block
 * shows (a line kind outside its island shows its parent's default child),
 * so the index must re-place it: otherwise it is not among the blocks a
 * later parent retype re-reads, and a view keeps a stale kind.
 */
describe('YW-08: a retype into a line kind is re-indexed', () => {
	const seed = [
		{ id: 'Q', text: 'q', children: [{ id: 'X', text: 'x' }] },
		{ id: 'C', type: 'code', text: '', children: [{ id: 'L1', type: 'codeLine', text: 'l' }] }
	];

	it('X becomes a codeLine outside the code block, then Q a list → the view shows a list item', () => {
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => {
					const view = mirror(a.ed);
					expect(a.ed.setBlockType('X', 'codeLine').status).toBe('applied');
					expect(view.stale()).toEqual([]);
					expect(a.ed.setBlockType('Q', 'unordered-list').status).toBe('applied');
					expect(view.stale()).toEqual([]);
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('Q:unordered-list[X:list-item] C:code[L1:codeLine]');
	});

	it('…and back out of the line kind: a later parent retype still reaches the view', () => {
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => {
					const view = mirror(a.ed);
					a.ed.setBlockType('X', 'codeLine');
					a.ed.setBlockType('X', 'heading');
					a.ed.setBlockType('Q', 'unordered-list');
					expect(view.stale()).toEqual([]);
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('Q:unordered-list[X:heading] C:code[L1:codeLine]');
	});

	it('Ada retypes X to a codeLine ‖ Bob retypes Q to a list → every replica agrees', () => {
		for (const o of one(
			converge(
				seed,
				2,
				([a, b]) => {
					const view = mirror(a.ed);
					a.ed.setBlockType('X', 'codeLine');
					b.ed.setBlockType('Q', 'unordered-list');
					a.receive(b.log.at(-1));
					expect(view.stale()).toEqual([]);
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('Q:unordered-list[X:list-item] C:code[L1:codeLine]');
	});
});

/**
 * SW8-roles-1 (cleanup-wave note): the attribution reader kept its own
 * `'getAttr' in v` node guard. A replicated `blockattr` record value that is
 * plain JSON with a `getAttr` key (a buggy or hostile peer) passed it, and
 * the next read or stamp threw — the block's attribution read and every
 * local edit of that block. It is now the shared `isNodeLike` guard: a
 * malformed record reads as no record.
 */
describe('SW8-roles-1: a malformed attribution record never breaks reads or edits', () => {
	it('blockattr b/P = { getAttr: 1 } → attribution reads, edits apply', () => {
		const document = createDocument({
			value: { children: [{ id: 'P', type: 'paragraph', content: [{ text: 'p' }] }] }
		});
		const ed = document.facade;
		document.doc.transact(() => document.doc.get('blockattr').setAttr('b/P', { getAttr: 1 }));
		expect(() => ed.block('P').attribution).not.toThrow();
		expect(ed.insertText('P', 1, 'q').status).toBe('applied');
		expect(tree(ed)).toBe('P:"pq"');
		document.destroy();
	});
});

/** YW-02 under the §8 rule: the key merges next to a list against concurrent edits. */
describe('YW-02 sweep: concurrent edits around a container', () => {
	const three = listOf('unordered-list', item('I1', 'a'), item('I2', 'b')).concat([
		{ id: 'Z', text: 'z' }
	]);
	const single = listOf('unordered-list', item('I1', 'a')).concat([{ id: 'Z', text: 'z' }]);
	const rows: [string, typeof three, (reps) => void, string][] = [
		[
			'Ada pulls the first item up ‖ Bob deletes the list → Bob’s delete promotes the rest',
			three,
			([a, b]) => {
				a.ed.mergeForward('P');
				b.ed.deleteBlocks(['U']);
			},
			'P:"pa" I2:"b" Z:"z"'
		],
		[
			'Ada lifts the only item ‖ Bob pulls it up from above → one copy of its text',
			single,
			([a, b]) => {
				a.ed.mergeBackward('I1');
				b.ed.mergeForward('P');
			},
			'P:"pa" Z:"z"'
		],
		[
			'both pull the first item up → its text once',
			three,
			([a, b]) => {
				a.ed.mergeForward('P');
				b.ed.mergeForward('P');
			},
			'P:"pa" U:""[I2:"b"] Z:"z"'
		],
		[
			'Ada pulls the first item up ‖ Bob types in it → Bob’s text follows it',
			three,
			([a, b]) => {
				a.ed.mergeForward('P');
				b.ed.insertText('I1', 1, 'x');
			},
			'P:"pax" U:""[I2:"b"] Z:"z"'
		],
		[
			'Ada lifts the first item ‖ Bob retypes the list → the item is a paragraph, the list Bob’s kind',
			three,
			([a, b]) => {
				a.ed.mergeBackward('I1');
				b.ed.setBlockType('U', 'ordered-list');
			},
			'P:"p" I1:"a" U:""[I2:"b"] Z:"z"'
		]
	];
	for (const [name, seed, program, expected] of rows)
		it(name, () => {
			for (const o of one(converge(seed, 2, program, { semantics })))
				expect(tree(o.ed)).toBe(expected);
		});

	it('one undo restores a lift and a pull-up; redo applies them again', () => {
		for (const o of one(
			converge(
				single,
				1,
				([a]) => {
					a.ed.mergeBackward('I1');
					a.undo();
					expect(typed(a.ed)).toBe('P:paragraph U:unordered-list[I1:list-item] Z:paragraph');
					a.ed.mergeForward('P');
					a.undo();
					expect(tree(a.ed)).toBe('P:"p" U:""[I1:"a"] Z:"z"');
					a.redo();
				},
				{ semantics }
			)
		))
			expect(tree(o.ed)).toBe('P:"pa" Z:"z"');
	});
});

/**
 * SW8-roles-2: deleting every item of a list as blocks (the block menu's
 * Delete on a one-item list, a block selection of the items) left the list
 * container with no child. It renders nothing, the caret never reaches it,
 * and it sealed its neighbours: Delete above it and Backspace below it did
 * nothing, for good. A block delete now removes a container it empties
 * (`del.range.empty-container`), and a container concurrent edits leave
 * empty is removed by the key next to it.
 */
describe('SW8-roles-2: no key or block delete leaves a list with no item', () => {
	const seed = listOf('unordered-list', item('I1', 'a'), item('I2', 'b')).concat([
		{ id: 'Z', text: 'z' }
	]);

	it('deleteBlocks of every item → the list goes; one undo brings it back', () => {
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => {
					expect(a.ed.deleteBlocks(['I1', 'I2']).status).toBe('applied');
					expect(tree(a.ed)).toBe('P:"p" Z:"z"');
					a.undo();
					expect(tree(a.ed)).toBe('P:"p" U:""[I1:"a",I2:"b"] Z:"z"');
				},
				{ semantics }
			)
		))
			expect(tree(o.ed)).toBe('P:"p" U:""[I1:"a",I2:"b"] Z:"z"');
	});

	it('deleteBlock of the only item, whole-subtree or not → the list goes', () => {
		const one_ = listOf('unordered-list', item('I1', 'a', [item('J', 'j')]));
		for (const [keep, expected] of [
			[true, 'P:"p" U:""[J:"j"]'],
			[false, 'P:"p"']
		] as const)
			for (const o of one(
				converge(one_, 1, ([a]) => a.ed.deleteBlock('I1', { keepChildren: keep }), { semantics })
			))
				expect(tree(o.ed)).toBe(expected);
	});

	it('Ada lifts the first item ‖ Bob merges the second into it → Delete or Backspace removes the empty list', () => {
		for (const key of ['Delete', 'Backspace'])
			for (const o of one(
				converge(
					seed,
					2,
					([a, b]) => {
						a.ed.mergeBackward('I1');
						b.ed.mergeBackward('I2');
						a.receiveAll(b.log);
						expect(tree(a.ed)).toBe('P:"p" I1:"ab" U:"" Z:"z"');
						const status =
							key === 'Delete' ? a.ed.mergeForward('I1').status : a.ed.mergeBackward('Z').status;
						expect(status).toBe('applied');
					},
					{ semantics }
				)
			))
				expect(tree(o.ed)).toBe('P:"p" I1:"ab" Z:"z"');
	});
});

/**
 * SW8-roles-3: a container never loses text it hides, and never splits.
 * A list that holds text of its own (a peer retyped a paragraph with text
 * into a list) is not an "empty container" the keys remove. Splitting a
 * block that renders no content moved all its items into a copy of it and
 * left it empty; it is refused, like a void's.
 */
describe('SW8-roles-3: containers keep hidden text and never split', () => {
	it('Delete above / Backspace below a list holding only hidden text → refused, the text kept', () => {
		for (const o of one(
			converge(
				[
					{ id: 'P', text: 'p' },
					{ id: 'U', type: 'unordered-list', text: 'hid' },
					{ id: 'Z', text: 'z' }
				],
				1,
				([a]) => {
					expect(a.ed.mergeForward('P').status).toBe('refused');
					expect(a.ed.mergeBackward('Z').status).toBe('refused');
				},
				{ semantics }
			)
		))
			expect(tree(o.ed)).toBe('P:"p" U:"hid" Z:"z"');
	});

	it('splitBlock of a list or a table row → refused', () => {
		const seed = [
			...listOf('unordered-list', item('I1', 'a')),
			{
				id: 'T',
				type: 'table',
				text: '',
				children: [
					{ id: 'R', type: 'row', text: '', children: [{ id: 'c', type: 'cell', text: 'c' }] }
				]
			}
		];
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => {
					expect(a.ed.splitBlock('U', 0, 'U2').status).toBe('refused');
					expect(a.ed.splitBlock('R', 0, 'R2').status).toBe('refused');
				},
				{ semantics }
			)
		))
			expect(tree(o.ed)).toBe('P:"p" U:""[I1:"a"] T:""[R:""[c:"c"]]');
	});
});

/**
 * SW8-roles-4 (review of this wave's container rule): an item leaving a
 * nested list for its parent item is still inside the outer list — it
 * stays a list item (`li > ul > li`, from JSON or the API). Only an item
 * that leaves every list of its kind becomes its new parent's default child.
 */
describe('SW8-roles-4: an item outdented within an outer list stays an item', () => {
	const nested = [
		{ id: 'P', text: 'p' },
		{
			id: 'U',
			type: 'unordered-list',
			text: '',
			children: [
				item('I1', 'a', [
					{ id: 'U2', type: 'unordered-list', text: '', children: [item('J', 'j')] }
				])
			]
		}
	];
	for (const [name, op] of [
		['unNestBlock', (ed) => ed.unNestBlock('J')],
		['mergeBackward (Backspace at its start)', (ed) => ed.mergeBackward('J')]
	] as const)
		it(`${name} of the inner list's only item → an item of the outer one`, () => {
			for (const o of one(
				converge(nested, 1, ([a]) => expect(op(a.ed).status).toBe('applied'), { semantics })
			))
				expect(typed(o.ed)).toBe('P:paragraph U:unordered-list[I1:list-item[J:list-item]]');
		});
});

/**
 * SW8-roles-5: moving a list's last item out of it (a drag, Alt/Mod+Shift
 * arrows, a consumer's `moveBlocks`) and Shift+Tab on a first item (its
 * siblings follow it) left the list with no item — an invisible block that
 * sealed its neighbours. The list goes with its last item; a list the
 * blocks move within, or land in, stays.
 */
describe('SW8-roles-5: a move never leaves a list with no item', () => {
	const seed = listOf('unordered-list', item('I1', 'a')).concat([{ id: 'Z', text: 'z' }]);

	it('moveBlocks of the only item to the root → the list goes; undo brings it back', () => {
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => {
					expect(a.ed.moveBlocks(['I1'], { parent: null, index: 3 }).status).toBe('applied');
					expect(tree(a.ed)).toBe('P:"p" Z:"z" I1:"a"');
					a.undo();
				},
				{ semantics }
			)
		))
			expect(tree(o.ed)).toBe('P:"p" U:""[I1:"a"] Z:"z"');
	});

	it('moving within the list, or into a nested list of it, keeps it', () => {
		const two = listOf('unordered-list', item('I1', 'a', [item('J', 'j')]), item('I2', 'b'));
		for (const o of one(
			converge(
				two,
				1,
				([a]) => {
					a.ed.moveBlocks(['I2'], { parent: 'U', index: 0 });
					a.ed.moveBlocks(['I2', 'I1'], { parent: 'U', index: 0 });
				},
				{ semantics }
			)
		))
			expect(tree(o.ed)).toBe('P:"p" U:""[I2:"b",I1:"a"[J:"j"]]');
	});

	it('Shift+Tab (unNestBlock) on the first of two items → it goes before the list (DR-crdt-3)', () => {
		for (const o of one(
			converge(
				listOf('unordered-list', item('I1', 'a'), item('I2', 'b')),
				1,
				([a]) => expect(a.ed.unNestBlock('I1').status).toBe('applied'),
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('P:paragraph I1:paragraph U:unordered-list[I2:list-item]');
	});

	it('Ada moves the only item out ‖ Bob adds a second → Bob’s item is kept', () => {
		for (const o of one(
			converge(
				seed,
				2,
				([a, b]) => {
					a.ed.moveBlocks(['I1'], { parent: null, index: 0 });
					b.ed.insertBlocks({ parent: 'U', index: 1 }, [
						{ id: 'I2', type: 'list-item', content: [{ kind: 'text', text: 'b' }] }
					]);
				},
				{ semantics }
			)
		)) {
			// A move keeps the item's kind; Bob's item leaves the removed list as a paragraph.
			expect(tree(o.ed)).toBe('I1:"a" P:"p" I2:"b" Z:"z"');
			expect(typed(o.ed)).toBe('I1:list-item P:paragraph I2:paragraph Z:paragraph');
		}
	});
});

/** `typed`, with a block id minted by the op (a fresh list) shown as `NEW`. */
const typedFresh = (ed) => typed(ed).replace(/\bb_[A-Za-z0-9_-]+/g, 'NEW');
/** A bullet item Bob inserts into `U`. */
const bobItem = (id: string, text: string) => [
	{ id, type: 'list-item', content: [{ kind: 'text', text }] }
];

/**
 * DR-crdt-1: the container rule never retypes a block into a kind that
 * renders no content, and nothing lands directly in a container it cannot
 * be an item of. With nested custom containers (columns of columns), a
 * paragraph lifted or outdented out of a column was retyped `column`: its
 * text vanished on every replica.
 */
describe('DR-crdt-1: nested custom containers never hide a lifted block’s text', () => {
	const columns = {
		...semantics,
		rendersContent: { ...semantics.rendersContent, columns: false, column: false },
		defaultChild: { ...semantics.defaultChild, columns: 'column' }
	};
	const seed = [
		{ id: 'P', text: 'p' },
		{
			id: 'C',
			type: 'columns',
			text: '',
			children: [
				{
					id: 'K1',
					type: 'column',
					text: '',
					children: [
						{ id: 'A', text: 'a' },
						{ id: 'A2', text: 'a2' }
					]
				},
				{ id: 'K2', type: 'column', text: '', children: [{ id: 'B', text: 'b' }] }
			]
		}
	];
	const before =
		'P:paragraph C:columns[K1:column[A:paragraph,A2:paragraph],K2:column[B:paragraph]]';

	it('Backspace at a column’s first paragraph (mergeBackward) → refused, as before YW-02', () => {
		for (const o of one(
			converge(seed, 1, ([a]) => expect(a.ed.mergeBackward('A').status).toBe('refused'), {
				semantics: columns
			})
		))
			expect(typed(o.ed)).toBe(before);
	});

	// Re-decided in ZW-14: nothing but a column lands directly in a columns layout.
	it('Backspace/Shift+Tab at a column’s last paragraph (unNestBlock) → refused (ZW-14)', () => {
		for (const o of one(
			converge(seed, 1, ([a]) => expect(a.ed.unNestBlock('A2').status).toBe('refused'), {
				semantics: columns
			})
		))
			expect(typed(o.ed)).toBe(before);
	});

	it('a list inside a column still lifts its first item into the column, as a paragraph', () => {
		const inColumn = [
			{
				id: 'C',
				type: 'columns',
				text: '',
				children: [
					{
						id: 'K1',
						type: 'column',
						text: '',
						children: [{ id: 'U', type: 'unordered-list', text: '', children: [item('I1', 'a')] }]
					}
				]
			}
		];
		for (const o of one(
			converge(inColumn, 1, ([a]) => expect(a.ed.mergeBackward('I1').status).toBe('applied'), {
				semantics: columns
			})
		))
			expect(typed(o.ed)).toBe('C:columns[K1:column[I1:paragraph]]');
	});

	it('Ada deletes a column ‖ Bob adds a paragraph to it → Bob’s paragraph shows as one', () => {
		for (const o of one(
			converge(
				seed,
				2,
				([a, b]) => {
					expect(a.ed.deleteBlocks(['K2']).status).toBe('applied');
					b.ed.insertBlocks({ parent: 'K2', index: 1 }, [
						{ id: 'B2', type: 'paragraph', content: [{ kind: 'text', text: 'b2' }] }
					]);
				},
				{ semantics: columns }
			)
		)) {
			expect(typed(o.ed)).toBe(
				'P:paragraph C:columns[K1:column[A:paragraph,A2:paragraph],B:paragraph,B2:paragraph]'
			);
			expect(tree(o.ed)).toContain('B2:"b2"');
		}
	});
});

/**
 * DR-crdt-2: a list removed because it was emptied (a delete, lift,
 * pull-up or move of its only item) promoted an item a peer added
 * meanwhile to the root with its `list-item` kind: a bare <li> with no
 * list. A block promoted out of a deleted container now shows as its new
 * parent's default child, as the container rule retypes the items it saw
 * (inside an outer list of that kind it stays an item). An explicit delete
 * of the list retypes the items it promotes the same way.
 */
describe('DR-crdt-2: a peer’s item never survives its removed list as a bare list-item', () => {
	for (const kind of ['unordered-list', 'ordered-list']) {
		const single = listOf(kind, item('I1', 'a')).concat([{ id: 'Z', text: 'z' }]);
		const rows: [string, (ed) => unknown, string][] = [
			['deletes', (ed) => ed.deleteBlocks(['I1']), 'P:paragraph I2:paragraph Z:paragraph'],
			[
				'lifts (Backspace)',
				(ed) => ed.mergeBackward('I1'),
				'P:paragraph I1:paragraph I2:paragraph Z:paragraph'
			],
			[
				'pulls up (Delete above)',
				(ed) => ed.mergeForward('P'),
				'P:paragraph I2:paragraph Z:paragraph'
			],
			[
				'drags away',
				(ed) => ed.moveBlocks(['I1'], { parent: null, index: 0 }),
				// A moved item keeps its kind (a move never retypes); Bob's item follows the list.
				'I1:list-item P:paragraph I2:paragraph Z:paragraph'
			]
		];
		for (const [name, op, expected] of rows)
			it(`${kind}: Ada ${name} the only item ‖ Bob adds a second → Bob’s item is a paragraph`, () => {
				for (const o of one(
					converge(
						single,
						2,
						([a, b]) => {
							expect(op(a.ed).status).toBe('applied');
							expect(b.ed.insertBlocks({ parent: 'U', index: 1 }, bobItem('I2', 'b')).status).toBe(
								'applied'
							);
						},
						{ semantics }
					)
				)) {
					expect(typed(o.ed)).toBe(expected);
					expect(tree(o.ed)).toContain('I2:"b"');
				}
			});

		it(`${kind}: Ada deletes the list itself → its items are paragraphs, a peer’s too`, () => {
			for (const o of one(
				converge(
					listOf(kind, item('I1', 'a')),
					2,
					([a, b]) => {
						expect(a.ed.deleteBlocks(['U']).status).toBe('applied');
						b.ed.insertBlocks({ parent: 'U', index: 1 }, bobItem('I2', 'b'));
					},
					{ semantics }
				)
			))
				expect(typed(o.ed)).toBe('P:paragraph I1:paragraph I2:paragraph');
		});
	}

	it('undo of Ada’s delete brings Bob’s item back into the list, as an item', () => {
		for (const o of one(
			converge(
				listOf('ordered-list', item('I1', 'a')),
				2,
				([a, b]) => {
					a.ed.deleteBlocks(['I1']);
					b.ed.insertBlocks({ parent: 'U', index: 1 }, bobItem('I2', 'b'));
					a.receiveAll(b.log);
					expect(typed(a.ed)).toBe('P:paragraph I2:paragraph');
					a.undo();
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('P:paragraph U:ordered-list[I1:list-item,I2:list-item]');
	});

	it('inside an outer list of that kind, a promoted item stays an item (SW8-roles-4)', () => {
		const nested = [
			{ id: 'P', text: 'p' },
			{
				id: 'U',
				type: 'unordered-list',
				text: '',
				children: [
					item('I1', 'a', [
						{ id: 'U2', type: 'unordered-list', text: '', children: [item('J', 'j')] }
					])
				]
			}
		];
		for (const o of one(
			converge(
				nested,
				2,
				([a, b]) => {
					expect(a.ed.mergeBackward('J').status).toBe('applied');
					b.ed.insertBlocks({ parent: 'U2', index: 1 }, bobItem('J2', 'k'));
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe(
				'P:paragraph U:unordered-list[I1:list-item[J:list-item,J2:list-item]]'
			);
	});
});

/**
 * DR-crdt-3: Shift+Tab (and Enter on an empty item, which outdents) on a
 * list item handed the items after it to the outdented block, which had
 * just become a paragraph: bare items under a paragraph, no list. The list
 * now splits around the outdented items (Notion): the items after them
 * stay a list of the same kind, and ones that were its first items go
 * before it.
 */
describe('DR-crdt-3: an item outdented out of its list never takes the items after it', () => {
	for (const kind of ['unordered-list', 'ordered-list']) {
		const three = listOf(kind, item('I1', 'a'), item('I2', 'b'), item('I3', 'c'));
		const rows: [string, (ed) => unknown, string, string][] = [
			[
				'the first item',
				(ed) => ed.unNestBlock('I1'),
				'P:"p" I1:"a" U:""[I2:"b",I3:"c"]',
				`P:paragraph I1:paragraph U:${kind}[I2:list-item,I3:list-item]`
			],
			[
				'the first two items',
				(ed) => ed.unNestBlocks(['I1', 'I2']),
				'P:"p" I1:"a" I2:"b" U:""[I3:"c"]',
				`P:paragraph I1:paragraph I2:paragraph U:${kind}[I3:list-item]`
			],
			[
				'a middle item (the list splits; it keeps the items after it, ZW-03)',
				(ed) => ed.unNestBlock('I2'),
				'P:"p" NEW:""[I1:"a"] I2:"b" U:""[I3:"c"]',
				`P:paragraph NEW:${kind}[I1:list-item] I2:paragraph U:${kind}[I3:list-item]`
			],
			[
				'the last item',
				(ed) => ed.unNestBlock('I3'),
				'P:"p" U:""[I1:"a",I2:"b"] I3:"c"',
				`P:paragraph U:${kind}[I1:list-item,I2:list-item] I3:paragraph`
			]
		];
		for (const [name, op, shape, kinds] of rows)
			it(`${kind}: Shift+Tab on ${name}`, () => {
				for (const o of one(
					converge(
						three,
						1,
						([a]) => {
							expect(op(a.ed).status).toBe('applied');
							a.undo();
							expect(typed(a.ed)).toBe(
								`P:paragraph U:${kind}[I1:list-item,I2:list-item,I3:list-item]`
							);
							a.redo();
						},
						{ semantics }
					)
				)) {
					expect(tree(o.ed).replace(/\bb_[A-Za-z0-9_-]+/g, 'NEW')).toBe(shape);
					expect(typedFresh(o.ed)).toBe(kinds);
				}
			});
	}

	it('Ada outdents a middle item ‖ Bob types in the next one → his text stays in the list', () => {
		for (const o of one(
			converge(
				listOf('ordered-list', item('I1', 'a'), item('I2', 'b'), item('I3', 'c')),
				2,
				([a, b]) => {
					expect(a.ed.unNestBlock('I2').status).toBe('applied');
					b.ed.insertText('I3', 1, 'x');
				},
				{ semantics }
			)
		)) {
			expect(tree(o.ed).replace(/\bb_[A-Za-z0-9_-]+/g, 'NEW')).toBe(
				'P:"p" NEW:""[I1:"a"] I2:"b" U:""[I3:"cx"]'
			);
			expect(typedFresh(o.ed)).toBe(
				'P:paragraph NEW:ordered-list[I1:list-item] I2:paragraph U:ordered-list[I3:list-item]'
			);
		}
	});
});

/**
 * DR-crdt-4: a text range across the seam between a block and a list (or
 * into it) dissolved the list: its later items were rescued to the root as
 * bare items. A container that renders no content dies in a range only
 * when the range empties it; the tail item merges and the list keeps the
 * rest, like the Delete key (`del.merge.container`).
 */
describe('DR-crdt-4: a text range into a list never dissolves it', () => {
	for (const kind of ['unordered-list', 'ordered-list']) {
		const seed = listOf(kind, item('I1', 'a'), item('I2', 'b'), item('I3', 'c')).concat([
			{ id: 'Z', text: 'z' }
		]);
		const rows: [string, [string, number], [string, number], string, string][] = [
			[
				'the seam p|a (Shift+Right, then Delete)',
				['P', 1],
				['I1', 0],
				'P:"pa" U:""[I2:"b",I3:"c"] Z:"z"',
				`P:paragraph U:${kind}[I2:list-item,I3:list-item] Z:paragraph`
			],
			[
				'into a middle item',
				['P', 1],
				['I2', 0],
				'P:"pb" U:""[I3:"c"] Z:"z"',
				`P:paragraph U:${kind}[I3:list-item] Z:paragraph`
			],
			[
				'from the head start into an item (the head dies)',
				['P', 0],
				['I1', 0],
				'U:""[I1:"a",I2:"b",I3:"c"] Z:"z"',
				`U:${kind}[I1:list-item,I2:list-item,I3:list-item] Z:paragraph`
			],
			['over every item → the emptied list goes', ['P', 1], ['Z', 0], 'P:"pz"', 'P:paragraph']
		];
		for (const [name, from, to, shape, kinds] of rows)
			it(`${kind}: ${name}`, () => {
				for (const o of one(
					converge(
						seed,
						1,
						([a]) =>
							expect(
								a.ed.deleteRange(
									{ block: from[0], offset: from[1] },
									{ block: to[0], offset: to[1] }
								).status
							).toBe('applied'),
						{ semantics }
					)
				)) {
					expect(tree(o.ed)).toBe(shape);
					expect(typed(o.ed)).toBe(kinds);
				}
			});
	}

	it('the range and the Delete key agree at the seam', () => {
		const seed = listOf('unordered-list', item('I1', 'a', [item('J', 'j')]), item('I2', 'b'));
		const results = [
			(ed) => ed.mergeForward('P'),
			(ed) => ed.deleteRange({ block: 'P', offset: 1 }, { block: 'I1', offset: 0 })
		].map((op) => {
			const [o] = one(converge(seed, 1, ([a]) => op(a.ed), { semantics }));
			return typed(o.ed) + ' ' + tree(o.ed);
		});
		expect(results[1]).toBe(results[0]);
	});
});

/**
 * DR-crdt-5: `mergeBlocks` (`block.mergeFrom`) of a list's only item left
 * the list with no item; every sibling op removes a container it empties.
 */
describe('DR-crdt-5: mergeBlocks never leaves a list with no item', () => {
	it('mergeBlocks of the only item into the block above → the list goes; undo restores it', () => {
		for (const o of one(
			converge(
				listOf('ordered-list', item('I1', 'a')).concat([{ id: 'Z', text: 'z' }]),
				1,
				([a]) => {
					expect(a.ed.mergeBlocks('I1', 'P').status).toBe('applied');
					expect(tree(a.ed)).toBe('P:"pa" Z:"z"');
					a.undo();
					expect(tree(a.ed)).toBe('P:"p" U:""[I1:"a"] Z:"z"');
					a.redo();
				},
				{ semantics }
			)
		))
			expect(tree(o.ed)).toBe('P:"pa" Z:"z"');
	});
});

/**
 * SW8-crdt-1: a lift or an outdent that emptied a list also removed the
 * containers above it that the block lands in (a list directly in a list,
 * from JSON or the API; a list alone in a column): the landing block
 * was promoted on up to the root. A container a block lands in stays.
 */
describe('SW8-crdt-1: a container a lifted or outdented block lands in is kept', () => {
	const direct = [
		{ id: 'P', text: 'p' },
		{
			id: 'U',
			type: 'unordered-list',
			text: '',
			children: [{ id: 'U2', type: 'unordered-list', text: '', children: [item('J', 'j')] }]
		}
	];
	for (const [name, op] of [
		['unNestBlock', (ed) => ed.unNestBlock('J')],
		['mergeBackward (Backspace at its start)', (ed) => ed.mergeBackward('J')]
	] as const)
		it(`${name} of a directly nested list's only item → an item of the outer list`, () => {
			for (const o of one(
				converge(direct, 1, ([a]) => expect(op(a.ed).status).toBe('applied'), { semantics })
			))
				expect(typed(o.ed)).toBe('P:paragraph U:unordered-list[J:list-item]');
		});
});
