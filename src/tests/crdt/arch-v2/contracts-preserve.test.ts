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
 * rows stay in `review-20260929-core.test.ts`.
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

	each(
		'control: a child a peer adds under the deleted parent, unseen by the deleter, hides with it',
		(ids) => {
			const [a, b] = peers(FAMILY, ids);
			expect(a.ed.deleteBlocks(['P']).status).toBe('applied');
			expect(
				b.ed.insertBlock({ parent: 'P', index: 2 }, { id: 'N', type: 'paragraph' }).status
			).toBe('applied');
			settle([a, b], 'C:"child"[G:"grand"] D:"second" Z:"after"');
		}
	);

	each('control: explicit keepChildren: false still removes the whole subtree', (ids) => {
		const [a, b] = peers(FAMILY, ids);
		expect(a.ed.deleteBlock('P', { keepChildren: false }).status).toBe('applied');
		settle([a, b], 'Z:"after"');
	});

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
