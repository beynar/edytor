/**
 * Re-score 4 (`docs/archive/reviews/2026-09-30-rescore-4.md`), CRDT units XW-03,
 * XW-08, XW-10, XW-11 and XW-12. Every `converge` row runs under the plan §8
 * multi-replica rule (three client-id assignments, both delivery orders,
 * duplicate delivery, binary reload) and every replica is held to
 * `wellFormed` after every write and delivery. Expected trees are
 * hand-authored from the units' "Done when" lines.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it, vi } from 'vitest';
import { converge, tree } from './p1-harness.js';
import { createDocument, defaultSemantics } from '../../../lib/crdt/index.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../oracles/model-ops.js';

const M = bindModel(Y);

/** Code holds lines (`lines: true`); a table and a callout are islands that keep their structure. */
const semantics = {
	roles: {
		code: { island: true, lines: true },
		divider: { void: true },
		table: { island: true },
		callout: { island: true }
	},
	rendersContent: { code: false, table: false, row: false },
	defaultChild: {
		code: 'codeLine',
		'unordered-list': 'list-item',
		table: 'row',
		row: 'cell',
		callout: 'paragraph'
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

const line = (id: string, text = id) => ({ id, type: 'codeLine', text });

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
 * XW-03: the line rule is opt-in (`lines: true`, set for code only). An
 * island that declares a `defaultChild` but no `lines` keeps its structure:
 * a table's rows keep their cells, a callout's paragraph keeps its child,
 * and inserting under them applies.
 */
describe('XW-03: only an island that declares `lines` holds lines', () => {
	const table = [
		{
			id: 'T',
			type: 'table',
			text: '',
			children: [
				{
					id: 'R1',
					type: 'row',
					text: '',
					children: [
						{ id: 'c1', type: 'cell', text: '1' },
						{ id: 'c2', type: 'cell', text: '2' }
					]
				}
			]
		}
	];
	const callout = [
		{
			id: 'K',
			type: 'callout',
			text: 'k',
			children: [
				{ id: 'H', type: 'heading', text: 'h' },
				{ id: 'P', text: 'p', children: [{ id: 'Q', text: 'q' }] }
			]
		}
	];

	it('a table → row → cell island keeps its structure, and a cell inserts under a row', () => {
		for (const o of one(
			converge(
				table,
				2,
				([a]) => {
					expect(typed(a.ed)).toBe('T:table[R1:row[c1:cell,c2:cell]]');
					const cell = { id: 'c3', type: 'cell', content: [{ kind: 'text', text: '3' }] };
					expect(a.ed.insertBlock({ parent: 'R1', index: 2 }, cell).status).toBe('applied');
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe('T:table[R1:row[c1:cell,c2:cell,c3:cell]]');
		}
	});

	it('a callout island keeps a heading and a nested paragraph, and inserts under it', () => {
		for (const o of one(
			converge(
				callout,
				1,
				([a]) => {
					expect(typed(a.ed)).toBe('K:callout[H:heading,P:paragraph[Q:paragraph]]');
					const spec = { id: 'Z', type: 'paragraph', content: [{ kind: 'text', text: 'z' }] };
					expect(a.ed.insertBlock({ parent: 'P', index: 1 }, spec).status).toBe('applied');
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe('K:callout[H:heading,P:paragraph[Q:paragraph,Z:paragraph]]');
		}
	});

	it('delete a table ‖ a peer adds a cell to its row, then undo → the table is whole again', () => {
		for (const o of one(
			converge(
				table,
				2,
				([a, b]) => {
					b.receiveAll(a.capture(() => a.ed.deleteBlocks(['T'])));
					const cell = { id: 'c3', type: 'cell', content: [{ kind: 'text', text: '3' }] };
					a.receiveAll(
						b.capture(() =>
							expect(b.ed.insertBlock({ parent: 'R1', index: 2 }, cell).status).toBe('applied')
						)
					);
					expect(a.undo()).not.toBe(undefined);
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe('T:table[R1:row[c1:cell,c2:cell,c3:cell]]');
		}
	});

	it('the same island declared with `lines` flattens: code lines hold no children', () => {
		const ed = converge(
			[{ id: 'C', type: 'code', text: '', children: [line('L1')] }],
			1,
			() => {},
			{
				semantics
			}
		)[0].ed;
		expect(ed.insertBlock({ parent: 'L1', index: 0 }, { id: 'X', type: 'codeLine' }).status).toBe(
			'refused'
		);
	});

	it('`lines` without `island` or a `defaultChild` warns in development (it does nothing)', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		for (const roles of [{ board: { lines: true } }, { board: { island: true, lines: true } }]) {
			warn.mockClear();
			createDocument({ semantics: { roles } }).destroy();
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('"board" declares `lines`'));
		}
		warn.mockClear();
		createDocument({
			semantics: {
				roles: { board: { island: true, lines: true } },
				defaultChild: { board: 'card' }
			}
		}).destroy();
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it('a line kind shared with other kinds warns in development (it would recast them)', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		for (const defaultChild of [
			{ poem: 'paragraph' },
			{ poem: 'list-item', 'unordered-list': 'list-item' }
		]) {
			warn.mockClear();
			createDocument({
				semantics: { roles: { poem: { island: true, lines: true } }, defaultChild }
			}).destroy();
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('"poem" holds lines of'));
		}
		warn.mockRestore();
	});

	it('a document without `lines` on code keeps a block nested under a code line (no line rule)', () => {
		const document = createDocument({
			value: {
				children: [
					{
						id: 'C',
						type: 'code',
						children: [
							{
								id: 'L1',
								type: 'codeLine',
								content: [{ text: 'a' }],
								children: [{ id: 'N', type: 'paragraph', content: [{ text: 'n' }] }]
							}
						]
					}
				]
			},
			semantics: { roles: { code: { island: true } }, defaultChild: { code: 'codeLine' } }
		});
		expect(typed(document.facade)).toBe('C:code[L1:codeLine[N:paragraph]]');
		document.destroy();
	});
});

/**
 * XW-08: a retype re-derives the shown kinds of the blocks that follow their
 * display parent — a line promoted out of a deleted island, a stray line an
 * undo left outside its island — and reports them, so an onChange-tracked
 * view never keeps a stale kind.
 */
describe('XW-08: a retype reports the kinds it derives for promoted and stray lines', () => {
	it('delete the code block ‖ a peer adds a line to it, then retype the list → the view follows', () => {
		const seed = [
			{
				id: 'U',
				type: 'unordered-list',
				text: '',
				children: [{ id: 'C', type: 'code', text: '', children: [line('L1', 'a')] }]
			}
		];
		for (const o of one(
			converge(
				seed,
				2,
				([a, b]) => {
					const views = [mirror(a.ed), mirror(b.ed)];
					const del = a.capture(() => a.ed.deleteBlocks(['C']));
					const add = b.capture(() =>
						expect(b.ed.insertBlock({ parent: 'C', index: 1 }, line('L2', 'b')).status).toBe(
							'applied'
						)
					);
					b.receiveAll(del);
					a.receiveAll(add);
					expect(typed(a.ed)).toBe('U:unordered-list[L1:list-item,L2:list-item]');
					b.receiveAll(a.capture(() => a.ed.setBlockType('U', 'paragraph')));
					expect(a.ed.blockTypeOf('L2')).toBe('paragraph');
					for (const v of views) expect(v.stale()).toEqual([]);
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe('U:paragraph[L1:list-item,L2:paragraph]');
		}
	});

	it('an undo leaves a line nested under N, then N becomes a list → the view shows a list item', () => {
		const seed = [
			{ id: 'C', type: 'code', text: '', children: [line('L1', 'a'), line('L2', 'b')] },
			{ id: 'N', text: 'n' }
		];
		for (const o of one(
			converge(
				seed,
				2,
				([a, b]) => {
					const views = [mirror(a.ed), mirror(b.ed)];
					b.receiveAll(a.capture(() => a.ed.deleteBlocks(['C'])));
					a.receiveAll(b.capture(() => expect(b.ed.nestBlock('L1', 'N').status).toBe('applied')));
					expect(a.undo()).not.toBe(undefined);
					b.receiveAll(a.log);
					expect(typed(a.ed)).toBe('C:code[L2:codeLine] N:paragraph[L1:paragraph]');
					b.receiveAll(a.capture(() => a.ed.setBlockType('N', 'unordered-list')));
					for (const v of views) expect(v.stale()).toEqual([]);
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe('C:code[L2:codeLine] N:unordered-list[L1:list-item]');
		}
	});
});

/**
 * XW-10: after the FW-01 race (Ada deletes C, Bob nests N under L1, Ada
 * undoes) N shows right after the code block. Deleting L1 then must not
 * pull N back into the island as a sealed code line: a block promoted out
 * of a dead line takes the island's slot, like one under a live line.
 */
describe('XW-10: deleting a line never seals the block the FW-01 rule displaced', () => {
	const seed = [
		{
			id: 'C',
			type: 'code',
			text: '',
			children: [line('L0', 'x'), line('L1', 'a'), line('L2', 'b')]
		},
		{ id: 'N', text: 'n' }
	];
	const race = (after) =>
		converge(
			seed,
			2,
			([a, b]) => {
				b.receiveAll(a.capture(() => a.ed.deleteBlocks(['C'])));
				a.receiveAll(b.capture(() => expect(b.ed.nestBlock('N', 'L1').status).toBe('applied')));
				expect(a.undo()).not.toBe(undefined);
				b.receiveAll(a.log);
				expect(typed(a.ed)).toBe('C:code[L0:codeLine,L1:codeLine,L2:codeLine] N:paragraph');
				after(a, b);
			},
			{ semantics }
		);

	for (const who of ['Ada', 'Bob']) {
		it(`${who} deletes L1 → N stays a movable paragraph after the code block`, () => {
			for (const o of one(
				race((a, b) => {
					const r = who === 'Ada' ? a : b;
					expect(r.ed.deleteBlocks(['L1']).status).toBe('applied');
				})
			)) {
				expect(typed(o.ed)).toBe('C:code[L0:codeLine,L2:codeLine] N:paragraph');
				for (const r of o.reps) {
					expect(r.ed.canPlace(['N']), `${r.name}: N is movable`).toBe(true);
					expect(r.ed.islandOf('N')).toBe(null);
				}
			}
		});
	}

	it('…and undo of the line delete puts L1 back, N still after the code block', () => {
		for (const o of one(
			race((a) => {
				a.ed.deleteBlocks(['L1']);
				expect(a.undo()).not.toBe(undefined);
			})
		)) {
			expect(typed(o.ed)).toBe('C:code[L0:codeLine,L1:codeLine,L2:codeLine] N:paragraph');
		}
	});

	it('merging L1 into L0 (Backspace) → N stays a movable paragraph after the code block', () => {
		for (const o of one(race((a) => expect(a.ed.mergeBackward('L1').status).toBe('applied')))) {
			expect(typed(o.ed)).toBe('C:code[L0:codeLine,L2:codeLine] N:paragraph');
			expect(tree(o.ed)).toContain('L0:"xa"');
			for (const r of o.reps) expect(r.ed.canPlace(['N'])).toBe(true);
		}
	});

	it('Ada deletes L1 ‖ Bob moves N to the top → N is at the top, the code block whole', () => {
		for (const o of one(
			race((a, b) => {
				const del = a.capture(() => a.ed.deleteBlocks(['L1']));
				const mv = b.capture(() =>
					expect(b.ed.moveBlock('N', { parent: null, index: 0 }).status).toBe('applied')
				);
				a.receiveAll(mv);
				b.receiveAll(del);
			})
		)) {
			expect(typed(o.ed)).toBe('N:paragraph C:code[L0:codeLine,L2:codeLine]');
		}
	});
});

/**
 * XW-11: the line kinds come from the roles, not from the island blocks the
 * document holds: a line a peer adds to a code block another peer retypes
 * to a paragraph shows as a paragraph whether or not another code block
 * exists elsewhere.
 */
describe('XW-11: line kinds come from the roles config', () => {
	const code = { id: 'C', type: 'code', text: '', children: [line('L1', 'a')] };
	const other = { id: 'D', type: 'code', text: '', children: [line('M1', 'm')] };
	for (const [name, seed, rest] of [
		['alone', [code], ''],
		['with an unrelated code block', [code, other], ' D:code[M1:codeLine]']
	]) {
		it(`retype the code block ‖ a peer adds a line to it (${name}) → both lines are paragraphs`, () => {
			for (const o of one(
				converge(
					seed,
					2,
					([a, b]) => {
						const retype = a.capture(() =>
							expect(a.ed.setBlockType('C', 'paragraph').status).toBe('applied')
						);
						const add = b.capture(() =>
							expect(b.ed.insertBlock({ parent: 'C', index: 1 }, line('L3', 'c')).status).toBe(
								'applied'
							)
						);
						b.receiveAll(retype);
						a.receiveAll(add);
					},
					{ semantics }
				)
			)) {
				expect(typed(o.ed)).toBe(`C:paragraph[L1:paragraph,L3:paragraph]${rest}`);
				for (const r of o.reps) expect(r.ed.blockTypeOf('L3')).toBe('paragraph');
			}
		});
	}
});

/**
 * XW-12: a code block never renders its own content, so merging its first
 * line into it would hide the line's text. The facade refuses it (one line
 * or several), and so does the view's `mergeBlockBackward`.
 */
describe('XW-12: a first code line never merges into its code block', () => {
	const seeds = {
		'one line': [
			{ id: 'P', text: 'p' },
			{ id: 'C', type: 'code', text: '', children: [line('L1', 'a')] }
		],
		'two lines': [
			{ id: 'P', text: 'p' },
			{ id: 'C', type: 'code', text: '', children: [line('L1', 'a'), line('L2', 'b')] }
		]
	};
	for (const [name, seed] of Object.entries(seeds)) {
		it(`headless (${name}): mergeBackward, mergeForward and mergeBlocks into C → refused`, () => {
			for (const o of one(
				converge(
					seed,
					1,
					([a]) => {
						expect(a.ed.canMerge('L1', 'C')).toBe(false);
						expect(a.ed.mergeBackward('L1').status).toBe('refused');
						expect(a.ed.mergeForward('C').status).toBe('refused');
						expect(a.ed.mergeBlocks('L1', 'C').status).toBe('refused');
					},
					{ semantics }
				)
			)) {
				expect(tree(o.ed)).toBe(
					name === 'one line' ? 'P:"p" C:""[L1:"a"]' : 'P:"p" C:""[L1:"a",L2:"b"]'
				);
			}
		});

		it(`view (${name}): block.mergeBlockBackward() on the first line changes nothing`, () => {
			const children = seed.map(function toJSON(b) {
				return {
					id: b.id,
					type: b.type ?? 'paragraph',
					content: [{ text: b.text }],
					children: (b.children ?? []).map(toJSON)
				};
			});
			const document = createDocument({ value: { children } });
			const view = new Edytor({ document, plugins: [richTextPlugin, codePlugin] });
			const before = tree(document.facade);
			view.idToBlock.get('L1')!.mergeBlockBackward();
			expect(tree(document.facade)).toBe(before);
			view.destroy();
			document.destroy();
		});
	}

	it('a second line still merges into the first', () => {
		const ed = converge(seeds['two lines'], 1, () => {}, { semantics })[0].ed;
		expect(ed.mergeBackward('L2').status).toBe('applied');
		expect(tree(ed)).toBe('P:"p" C:""[L1:"ab"]');
	});
});

/**
 * SW7-crdt-1 (sweep; roles corpus seed 497 beyond the bounded corpus): a
 * block's type attr can be transiently missing — a peer's retype deleted
 * the old value and its new one is still pending (out-of-order delivery).
 * A split (Enter) or a paste flow in that window copied the missing type
 * into the new block, which then showed as `unknown` on every replica for
 * good. The new block takes its parent's default child instead.
 */
describe('SW7-crdt-1: a split never copies a missing type', () => {
	const typeless = () => {
		const document = createDocument({
			value: {
				children: [
					{
						id: 'Q',
						type: 'quote',
						content: [{ text: 'q' }],
						children: [{ id: 'A', type: 'paragraph', content: [{ text: 'hello' }] }]
					}
				]
			},
			semantics
		});
		// The transient state: the attr's current value deleted, its replacement not yet here.
		M.blockNodeOf(document.doc, 'A').deleteAttr('type');
		return document;
	};

	it('splitBlock of a block whose type is missing → the tail is its parent’s default child', () => {
		const document = typeless();
		const ed = document.facade;
		expect(ed.splitBlock('A', 2, 'B').status).toBe('applied');
		expect(M.blockNodeOf(document.doc, 'B').getAttr('type')).toBe('paragraph');
		document.destroy();
	});

	it('a paste flow ending in such a block → no block without a type', () => {
		const document = typeless();
		const ed = document.facade;
		const lines = [
			{ id: 'X', content: [{ kind: 'text', text: 'x' }] },
			{ id: 'Y', content: [{ kind: 'text', text: 'y' }] }
		];
		expect(ed.insertFlow({ block: 'A', offset: 2 }, { lines }).status).toBe('applied');
		for (const id of ed.order())
			if (id !== 'A') expect(typeof M.blockNodeOf(document.doc, id).getAttr('type')).toBe('string');
		document.destroy();
	});
});

/**
 * DR-crdt-1 (review of SW7-crdt-1): duplicating a block whose type attr is
 * transiently missing (a peer's retype half-delivered) wrote the copy with
 * the explicit type `''`, which never heals — the retype arrives for the
 * source only. The copy, and each typeless descendant, takes its parent's
 * default child instead, like a split tail.
 */
describe('DR-crdt-1: a duplicate never copies a missing type', () => {
	const typeless = (withSemantics = true) => {
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
								content: [{ text: 'a' }],
								children: [{ id: 'A1', type: 'quote', content: [{ text: 'a1' }] }]
							}
						]
					}
				]
			},
			...(withSemantics && { semantics })
		});
		M.blockNodeOf(document.doc, 'A').deleteAttr('type');
		M.blockNodeOf(document.doc, 'A1').deleteAttr('type');
		return document;
	};
	const fresh = () => {
		const ids = ['D0', 'D1'];
		return (_: string, kind: 'block' | 'inline') => (kind === 'block' ? ids.shift()! : 'i0');
	};

	it('headless duplicateBlock → the copy and its descendant take their parent’s default child', () => {
		const document = typeless();
		expect(document.facade.duplicateBlock('A', fresh()).status).toBe('applied');
		expect(M.blockNodeOf(document.doc, 'D0').getAttr('type')).toBe('paragraph');
		expect(M.blockNodeOf(document.doc, 'D1').getAttr('type')).toBe('paragraph');
		document.destroy();
	});

	it('view block.duplicateBlock() → no block with an empty type', () => {
		const document = typeless(false);
		const view = new Edytor({ document, plugins: [richTextPlugin, codePlugin] });
		view.idToBlock.get('A')!.duplicateBlock();
		for (const id of document.facade.order())
			if (id !== 'A' && id !== 'A1')
				expect(M.blockNodeOf(document.doc, id).getAttr('type')).toMatch(/^.+$/);
		expect(document.facade.order().length).toBe(5);
		view.destroy();
		document.destroy();
	});
});

/**
 * DR-crdt-2 (review of XW-12): the rule is "never merge into a block that
 * renders no content", not only into an island root. The first item of a
 * list or the first cell of a table merged its text into its container,
 * where no snippet shows it. Headless, room (same facade, defaultSemantics)
 * and the view's `mergeBlockBackward` all refuse it.
 */
describe('DR-crdt-2: nothing merges into a block that renders no content', () => {
	const list = [
		{ id: 'P', type: 'paragraph', content: [{ text: 'p' }] },
		{
			id: 'U',
			type: 'unordered-list',
			children: [
				{ id: 'I1', type: 'list-item', content: [{ text: 'a' }] },
				{ id: 'I2', type: 'list-item', content: [{ text: 'b' }] }
			]
		}
	];
	for (const kind of ['unordered-list', 'ordered-list']) {
		it(`headless (${kind}): mergeBlocks of the first item → refused; mergeBackward lifts it (YW-02)`, () => {
			const children = structuredClone(list);
			children[1]!.type = kind;
			const document = createDocument({ value: { children }, semantics: defaultSemantics });
			const ed = document.facade;
			const before = tree(ed);
			expect(ed.canMerge('I1', 'U')).toBe(false);
			expect(ed.mergeBlocks('I1', 'U').status).toBe('refused');
			expect(ed.mergeForward('U').status).toBe('refused');
			expect(tree(ed)).toBe(before);
			// A second item still merges into the first.
			expect(ed.mergeBackward('I2').status).toBe('applied');
			expect(tree(ed)).toBe('P:"p" U:""[I1:"ab"]');
			// Backspace at the first item leaves the list (YW-02): never into U.
			expect(ed.mergeBackward('I1').status).toBe('applied');
			expect(tree(ed)).toBe('P:"p" I1:"ab"');
			document.destroy();
		});
	}

	it('view: block.mergeBlockBackward() on the first list item lifts it out (YW-02)', () => {
		const document = createDocument({ value: { children: structuredClone(list) } });
		const view = new Edytor({ document, plugins: [richTextPlugin, codePlugin] });
		view.idToBlock.get('I1')!.mergeBlockBackward();
		expect(tree(document.facade)).toBe('P:"p" I1:"a" U:""[I2:"b"]');
		expect(document.facade.toJSON().children[1].type).toBe('paragraph');
		view.destroy();
		document.destroy();
	});

	it('table island: the first cell never merges into its row', () => {
		const seed = [
			{ id: 'P', text: 'p' },
			{
				id: 'T',
				type: 'table',
				text: '',
				children: [
					{
						id: 'R1',
						type: 'row',
						text: '',
						children: [
							{ id: 'c1', type: 'cell', text: '1' },
							{ id: 'c2', type: 'cell', text: '2' }
						]
					}
				]
			}
		];
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => {
					expect(a.ed.canMerge('c1', 'R1')).toBe(false);
					expect(a.ed.mergeBackward('c1').status).toBe('refused');
					expect(a.ed.mergeBackward('c2').status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(tree(o.ed)).toBe('P:"p" T:""[R1:""[c1:"12"]]');
	});
});
