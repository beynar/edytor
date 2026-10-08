/**
 * The 2026-09-28 contracts: "preserve content the user did not remove".
 *
 * 1. `del.blocks.promote` — deleting a block deletes only what was selected;
 *    its unselected children (with their subtrees) take its slot, in order.
 * 2. `hist.undo.withdraw` — undoing a block's creation removes only the
 *    undoer's own contributions; the block stays while it holds content
 *    from others (text, a child).
 * 3. `doc.empty.virtual` — see `src/tests/fixtures/dom/contracts-virtual-paragraph.test.tsx`
 *    and the browser specs (the document layer writes nothing for it).
 *
 * Every row runs through the facade on real replicas (`p1-harness.js`):
 * delivery through the providers' admission, then quiescence, and each
 * replica checked for problems, pending structs and a binary reload equal
 * to its canonical value. Expected values are hand-written from the
 * contracts, never read from production output. The reviewer's reproduction
 * rows stay in `preserve-regressions.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	CLIENT_IDS,
	quiesce,
	reloadCanonical,
	replica,
	seedUpdate,
	type Replica,
	type SeedBlock
} from './p1-harness.js';

const opened: Replica[] = [];
afterEach(() => {
	for (const peer of opened.splice(0)) peer.destroy();
});

const peers = (seed: SeedBlock[], ids: number[], semantics?: unknown) => {
	const bytes = seedUpdate(seed, semantics);
	const pair = ids.map((id, i) => replica(`c${i}`, bytes, id, { semantics }));
	opened.push(...pair);
	return pair;
};

/** Converge, then check every replica: no problem, nothing pending, reload = canonical, the tree. */
const settle = (reps: Replica[], expected: string) => {
	quiesce(reps);
	for (const r of reps) {
		expect(r.problems, r.name).toEqual([]);
		expect(r.pending(), r.name).toBe(false);
		expect(r.tree(), r.name).toBe(expected);
		expect(reloadCanonical(r), r.name).toBe(r.canonical());
	}
};

/** Each row runs under every two-replica client-id assignment (plan §8 multi-replica rule). */
const each = (title: string, row: (ids: number[]) => void) => {
	for (const ids of CLIENT_IDS[2]) it(`${title} (${ids.join('/')})`, () => row(ids));
};

const FAMILY: SeedBlock[] = [
	{
		id: 'P',
		text: 'parent',
		children: [
			{ id: 'C', text: 'child', children: [{ id: 'G', text: 'grand' }] },
			{ id: 'D', text: 'second' }
		]
	},
	{ id: 'Z', text: 'after' }
];
const ORIGINAL = 'P:"parent"[C:"child"[G:"grand"],D:"second"] Z:"after"';

describe('del.blocks.promote — only the selected blocks leave', () => {
	each(
		'a selected parent and its selected child: the grandchild and the sibling take the parent slot',
		(ids) => {
			const [a, b] = peers(FAMILY, ids);
			expect(a.ed.deleteBlocks(['P', 'C']).status).toBe('applied');
			settle([a, b], 'G:"grand" D:"second" Z:"after"');
		}
	);

	each(
		'a selected block under an unselected child of a selected parent takes its own slot',
		(ids) => {
			const [a, b] = peers(
				[
					{
						id: 'P',
						text: 'p',
						children: [
							{
								id: 'C',
								text: 'c',
								children: [
									{ id: 'X', text: 'x', children: [{ id: 'K', text: 'k' }] },
									{ id: 'Y', text: 'y' }
								]
							}
						]
					}
				],
				ids
			);
			expect(a.ed.deleteBlocks(['P', 'X']).status).toBe('applied');
			settle([a, b], 'C:"c"[K:"k",Y:"y"]');
		}
	);

	each('two selected siblings: each one’s children take its own slot, in order', (ids) => {
		const [a, b] = peers(
			[
				{ id: 'A', text: 'a', children: [{ id: 'A1', text: 'a1' }] },
				{ id: 'B', text: 'b', children: [{ id: 'B1', text: 'b1' }] },
				{ id: 'Z', text: 'z' }
			],
			ids
		);
		expect(a.ed.deleteBlocks(['A', 'B']).status).toBe('applied');
		settle([a, b], 'A1:"a1" B1:"b1" Z:"z"');
	});

	each(
		'undo restores the parent and puts the children back under it; redo promotes again',
		(ids) => {
			const [a, b] = peers(FAMILY, ids);
			expect(a.ed.deleteBlocks(['P']).status).toBe('applied');
			settle([a, b], 'C:"child"[G:"grand"] D:"second" Z:"after"');
			expect(a.undo()).not.toBeNull();
			settle([a, b], ORIGINAL);
			expect(a.redo()).not.toBeNull();
			settle([a, b], 'C:"child"[G:"grand"] D:"second" Z:"after"');
		}
	);

	each(
		'a peer’s concurrent typing inside a promoted child survives, and so does its new grandchild',
		(ids) => {
			const [a, b] = peers(FAMILY, ids);
			expect(a.ed.deleteBlocks(['P']).status).toBe('applied');
			expect(b.ed.insertText('C', 5, '!').status).toBe('applied');
			expect(
				b.ed.insertBlock({ parent: 'G', index: 0 }, { id: 'N', type: 'paragraph' }).status
			).toBe('applied');
			settle([a, b], 'C:"child!"[G:"grand"[N:""]] D:"second" Z:"after"');
		}
	);

	each(
		'a concurrent edit inside a promoted child survives the undo too: back under the parent',
		(ids) => {
			const [a, b] = peers(FAMILY, ids);
			expect(a.ed.deleteBlocks(['P']).status).toBe('applied');
			expect(b.ed.insertText('D', 0, '>').status).toBe('applied');
			quiesce([a, b]);
			expect(a.undo()).not.toBeNull();
			settle([a, b], 'P:"parent"[C:"child"[G:"grand"],D:">second"] Z:"after"');
		}
	);

	// UW-08: promotion is derived when the document is read, so what a peer
	// wrote under the deleted parent without seeing the delete takes the
	// parent's slot too, in its own order among the promoted children.
	each('a child a peer adds under the deleted parent takes the parent’s slot too', (ids) => {
		const [a, b] = peers(FAMILY, ids);
		expect(a.ed.deleteBlocks(['P']).status).toBe('applied');
		expect(b.ed.insertBlock({ parent: 'P', index: 2 }, { id: 'N', type: 'paragraph' }).status).toBe(
			'applied'
		);
		settle([a, b], 'C:"child"[G:"grand"] D:"second" N:"" Z:"after"');
	});

	each(
		'a peer’s Enter inside a promoted child: the tail and the grandchild it carries stay visible',
		(ids) => {
			const [a, b] = peers(FAMILY, ids);
			expect(a.ed.deleteBlocks(['P']).status).toBe('applied');
			expect(b.ed.splitBlock('C', 2, 'T').status).toBe('applied');
			settle([a, b], 'C:"ch" T:"ild"[G:"grand"] D:"second" Z:"after"');
		}
	);

	each('typing into the split tail survives, and the tail is live for the deleter', (ids) => {
		const [a, b] = peers(FAMILY, ids);
		expect(a.ed.deleteBlocks(['P']).status).toBe('applied');
		expect(b.ed.splitBlock('C', 2, 'T').status).toBe('applied');
		expect(b.ed.insertText('T', 3, '!').status).toBe('applied');
		settle([a, b], 'C:"ch" T:"ild!"[G:"grand"] D:"second" Z:"after"');
		expect(a.ed.insertText('T', 0, '>').status).toBe('applied');
		settle([a, b], 'C:"ch" T:">ild!"[G:"grand"] D:"second" Z:"after"');
	});

	each(
		'nested promote-deletes: the parent and its child deleted by two peers — the grandchild stays',
		(ids) => {
			const [a, b] = peers(FAMILY, ids);
			expect(a.ed.deleteBlocks(['P']).status).toBe('applied');
			expect(b.ed.deleteBlocks(['C']).status).toBe('applied');
			settle([a, b], 'G:"grand" D:"second" Z:"after"');
		}
	);

	each('explicit keepChildren: false removes the whole subtree', (ids) => {
		const [a, b] = peers(FAMILY, ids);
		expect(a.ed.deleteBlock('P', { keepChildren: false }).status).toBe('applied');
		settle([a, b], 'Z:"after"');
	});

	each(
		'a whole-subtree delete marks every member: a child added concurrently under one takes the subtree’s slot',
		(ids) => {
			const [a, b] = peers(FAMILY, ids);
			expect(a.ed.deleteBlock('P', { keepChildren: false }).status).toBe('applied');
			expect(
				b.ed.insertBlock({ parent: 'G', index: 0 }, { id: 'N', type: 'paragraph' }).status
			).toBe('applied');
			settle([a, b], 'N:"" Z:"after"');
		}
	);

	it('a deleted island’s children take the default child type of the slot’s parent', () => {
		const semantics = {
			roles: { box: { island: true } },
			defaultChild: { 'ordered-list': 'list-item' }
		};
		const [a, b] = peers(
			[
				{
					id: 'L',
					type: 'ordered-list',
					children: [
						{ id: 'one', type: 'list-item', text: 'one' },
						{ id: 'box', type: 'box', text: 'box', children: [{ id: 'in', text: 'inside' }] }
					]
				}
			],
			[20, 30],
			semantics
		);
		expect(a.ed.deleteBlocks(['box']).status).toBe('applied');
		settle([a, b], 'L:""[one:"one",in:"inside"]');
		for (const r of [a, b])
			expect(r.ed.toJSON().children[0].children.map((c) => c.type)).toEqual([
				'list-item',
				'list-item'
			]);
	});
});

const N = (id = 'N') => ({ id, type: 'paragraph' });
/** A creates an empty block `N` after `P`; B receives it. */
const created = (ids: number[]) => {
	const [a, b] = peers([{ id: 'P', text: 'abc' }], ids);
	b.receiveAll(a.capture(() => a.ed.insertBlock({ parent: null, index: 1 }, N())));
	return [a, b];
};

describe('hist.undo.withdraw — an undone creation keeps what others put in the block', () => {
	each(
		'B types into A’s new block, A undoes the creation: the block stays with B’s text',
		(ids) => {
			const [a, b] = created(ids);
			a.receiveAll(b.capture(() => b.ed.insertText('N', 0, 'foreign')));
			expect(a.undo()).not.toBeNull();
			settle([a, b], 'P:"abc" N:"foreign"');
		}
	);

	each('A’s own typing in the block goes with the undo; B’s stays', (ids) => {
		const [a, b] = created(ids);
		expect(a.ed.insertText('N', 0, 'mine').status).toBe('applied');
		quiesce([a, b]);
		expect(b.ed.insertText('N', 4, '+theirs').status).toBe('applied');
		quiesce([a, b]);
		expect(a.undo()).not.toBeNull(); // the typing
		expect(a.undo()).not.toBeNull(); // the creation
		settle([a, b], 'P:"abc" N:"+theirs"');
	});

	each('B’s text arrives after A’s undo (concurrent): the block stays with it', (ids) => {
		const [a, b] = created(ids);
		expect(a.undo()).not.toBeNull();
		expect(a.tree()).toBe('P:"abc"');
		expect(b.ed.insertText('N', 0, 'late').status).toBe('applied');
		settle([a, b], 'P:"abc" N:"late"');
	});

	each('control: nothing foreign in it, the undone block is gone; redo brings it back', (ids) => {
		const [a, b] = created(ids);
		expect(a.undo()).not.toBeNull();
		settle([a, b], 'P:"abc"');
		expect(a.redo()).not.toBeNull();
		settle([a, b], 'P:"abc" N:""');
		expect(a.ed.insertText('N', 0, 'again').status).toBe('applied');
		settle([a, b], 'P:"abc" N:"again"');
	});

	each('A redoes the creation after the withdrawal: A’s typing returns beside B’s', (ids) => {
		const [a, b] = created(ids);
		expect(a.ed.insertText('N', 0, 'mine').status).toBe('applied');
		quiesce([a, b]);
		expect(b.ed.insertText('N', 4, '+theirs').status).toBe('applied');
		quiesce([a, b]);
		a.undo();
		a.undo();
		settle([a, b], 'P:"abc" N:"+theirs"');
		expect(a.redo()).not.toBeNull(); // the creation: nothing of A's to show yet
		settle([a, b], 'P:"abc" N:"+theirs"');
		expect(a.redo()).not.toBeNull(); // the typing
		settle([a, b], 'P:"abc" N:"mine+theirs"');
		a.undo();
		a.undo();
		settle([a, b], 'P:"abc" N:"+theirs"');
	});

	each('B nests a child inside A’s new block: the undone block stays as its holder', (ids) => {
		const [a, b] = created(ids);
		expect(
			b.ed.insertBlock(
				{ parent: 'N', index: 0 },
				{ id: 'K', type: 'paragraph', content: [{ kind: 'text', text: 'kid' }] }
			).status
		).toBe('applied');
		quiesce([a, b]);
		expect(a.undo()).not.toBeNull();
		settle([a, b], 'P:"abc" N:""[K:"kid"]');
	});

	each('B’s child arrives after A’s undo: the same', (ids) => {
		const [a, b] = created(ids);
		expect(a.undo()).not.toBeNull();
		expect(
			b.ed.insertBlock(
				{ parent: 'N', index: 0 },
				{ id: 'K', type: 'paragraph', content: [{ kind: 'text', text: 'kid' }] }
			).status
		).toBe('applied');
		settle([a, b], 'P:"abc" N:""[K:"kid"]');
	});

	each(
		'the block stays while it holds: B deleting its text removes it, B’s undo brings it back',
		(ids) => {
			const [a, b] = created(ids);
			a.receiveAll(b.capture(() => b.ed.insertText('N', 0, 'x')));
			a.undo();
			settle([a, b], 'P:"abc" N:"x"');
			expect(b.ed.deleteText('N', 0, 1).status).toBe('applied');
			settle([a, b], 'P:"abc"');
			expect(b.undo()).not.toBeNull();
			settle([a, b], 'P:"abc" N:"x"');
		}
	);

	each(
		'an undone paste: the pasted parent stays empty while the child B typed into holds',
		(ids) => {
			const [a, b] = peers([{ id: 'P', text: 'abc' }], ids);
			const tree = {
				id: 'Q',
				type: 'paragraph',
				content: [{ kind: 'text', text: 'q' }],
				children: [
					{ id: 'Q1', type: 'paragraph', content: [{ kind: 'text', text: 'one' }] },
					{ id: 'Q2', type: 'paragraph', content: [{ kind: 'text', text: 'two' }] }
				]
			};
			expect(a.ed.insertBlock({ parent: null, index: 1 }, tree).status).toBe('applied');
			quiesce([a, b]);
			expect(b.ed.insertText('Q2', 3, '!').status).toBe('applied');
			quiesce([a, b]);
			expect(a.undo()).not.toBeNull();
			settle([a, b], 'P:"abc" Q:""[Q2:"!"]');
		}
	);

	each('control (reviewer): an explicit delete still wins over an unseen insertion', (ids) => {
		const [a, b] = created(ids);
		expect(a.ed.deleteBlocks(['N']).status).toBe('applied');
		expect(b.ed.insertText('N', 0, 'unseen').status).toBe('applied');
		settle([a, b], 'P:"abc"');
	});
});

describe('hist.undo.withdraw — splits: the text the tail received rides back into the source', () => {
	each('A splits, B types into the tail, A undoes the split: one block with B’s text', (ids) => {
		const [a, b] = peers([{ id: 'A', text: 'abcd' }], ids);
		expect(a.ed.splitBlock('A', 2, 'T').status).toBe('applied');
		quiesce([a, b]);
		expect(b.ed.insertText('T', 1, 'X').status).toBe('applied');
		quiesce([a, b]);
		expect(a.undo()).not.toBeNull();
		settle([a, b], 'A:"abcXd"');
	});

	each('B’s tail typing arrives after A’s undo: the same block, the same text', (ids) => {
		const [a, b] = peers([{ id: 'A', text: 'abcd' }], ids);
		expect(a.ed.splitBlock('A', 2, 'T').status).toBe('applied');
		quiesce([a, b]);
		expect(a.undo()).not.toBeNull();
		expect(b.ed.insertText('T', 1, 'X').status).toBe('applied');
		settle([a, b], 'A:"abcXd"');
	});

	each(
		'Enter at the end, B types in the new line, A undoes: B’s text joins the line above',
		(ids) => {
			const [a, b] = peers([{ id: 'A', text: 'ab' }], ids);
			expect(a.ed.splitBlock('A', 2, 'T').status).toBe('applied');
			quiesce([a, b]);
			expect(b.ed.insertText('T', 0, 'new').status).toBe('applied');
			quiesce([a, b]);
			expect(a.undo()).not.toBeNull();
			settle([a, b], 'A:"abnew"');
			expect(a.redo()).not.toBeNull();
			settle([a, b], 'A:"ab" T:"new"');
		}
	);

	each('B nests a child under the tail: the tail stays, empty, holding it', (ids) => {
		const [a, b] = peers([{ id: 'A', text: 'abcd' }], ids);
		expect(a.ed.splitBlock('A', 2, 'T').status).toBe('applied');
		quiesce([a, b]);
		expect(
			b.ed.insertBlock(
				{ parent: 'T', index: 0 },
				{ id: 'K', type: 'paragraph', content: [{ kind: 'text', text: 'kid' }] }
			).status
		).toBe('applied');
		quiesce([a, b]);
		expect(a.undo()).not.toBeNull();
		settle([a, b], 'A:"abcd" T:""[K:"kid"]');
	});
});
