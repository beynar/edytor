/**
 * `del.range.whole-doc` (2026-09-28 follow-up): a text range delete that
 * leaves nothing to hold the caret keeps its head block — its id, type and
 * data — emptied, instead of writing a new paragraph. The user's contract:
 * preserve content the user did not remove, and never let peers create
 * duplicates just by performing the same action. Two peers deleting the
 * whole document keep the same block, so they converge to one empty block.
 *
 * Every row runs through the facade on real replicas (`p1-harness.ts`):
 * delivery through the providers' admission, quiescence, then each replica
 * checked for problems, pending structs and a binary reload equal to its
 * canonical value, under every two-replica client-id assignment. Expected
 * values are hand-written from the contract.
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

const peers = (seed: SeedBlock[], ids: number[]) => {
	const bytes = seedUpdate(seed);
	const pair = ids.map((id, i) => replica(`c${i}`, bytes, id));
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

const each = (title: string, row: (ids: number[]) => void) => {
	for (const ids of CLIENT_IDS[2]) it(`${title} (${ids.join('/')})`, () => row(ids));
};

const FLAT: SeedBlock[] = [
	{ id: 'A', text: 'alpha' },
	{ id: 'B', text: 'beta' },
	{ id: 'C', text: 'gamma' }
];
const FLAT_TREE = 'A:"alpha" B:"beta" C:"gamma"';

/** Delete `A@0 → C@5` (the whole document), forward or reversed endpoints. */
const wipe = (r: Replica, reversed = false) => {
	const [from, to] = [
		{ block: 'A', offset: 0 },
		{ block: 'C', offset: 5 }
	];
	const plan = reversed ? r.ed.prepare.deleteRange(to, from) : r.ed.prepare.deleteRange(from, to);
	expect(plan.effect.creates, 'the delete writes no block').toEqual([]);
	expect(plan.at).toEqual({ block: 'A', offset: 0 });
	expect(r.ed.apply(plan).status).toBe('applied');
};

describe('del.range.whole-doc — the head is kept, emptied', () => {
	each('one writer: the head keeps its id, type and data; its atoms and children go', (ids) => {
		const [a, b] = peers(
			[
				{
					id: 'H',
					type: 'heading',
					data: { level: 2 },
					content: [{ text: 'ti' }, { type: 'mention', id: 'm1', data: {} }, { text: 'tle' }],
					children: [{ id: 'K', text: 'kid' }]
				},
				{ id: 'P', text: 'para' },
				{ id: 'Q', text: 'last' }
			],
			ids
		);
		const plan = a.ed.prepare.deleteRange({ block: 'H', offset: 0 }, { block: 'Q', offset: 4 });
		expect(plan.effect.creates).toEqual([]);
		expect(plan.at).toEqual({ block: 'H', offset: 0 });
		a.ed.apply(plan);
		settle([a, b], 'H:""');
		for (const r of [a, b]) {
			expect(r.ed.blockTypeOf('H'), r.name).toBe('heading');
			expect(r.ed.blockDataOf('H'), r.name).toEqual({ level: 2 });
		}
		// One undo step brings everything back, on both replicas.
		a.undo();
		settle([a, b], 'H:"ti⟨mention⟩tle"[K:"kid"] P:"para" Q:"last"');
	});

	each('two writers delete the whole document concurrently: one empty block, the head', (ids) => {
		const [a, b] = peers(FLAT, ids);
		wipe(a);
		wipe(b, true);
		settle([a, b], 'A:""');
		// Each writer's delete holds on its own: the first undo leaves the other one's.
		a.undo();
		settle([a, b], 'A:""');
		b.undo();
		settle([a, b], FLAT_TREE);
	});

	each('the same, undone in the other order', (ids) => {
		const [a, b] = peers(FLAT, ids);
		wipe(a);
		wipe(b);
		settle([a, b], 'A:""');
		b.undo();
		settle([a, b], 'A:""');
		a.undo();
		settle([a, b], FLAT_TREE);
	});

	each('a writer deletes the whole document after receiving the other’s: nothing more', (ids) => {
		const [a, b] = peers(FLAT, ids);
		wipe(a);
		quiesce([a, b]);
		// B sees one empty block; selecting it all is a collapsed range: nothing to write.
		expect(
			b.ed.apply(b.ed.prepare.deleteRange({ block: 'A', offset: 0 }, { block: 'A', offset: 0 }))
				.status
		).toBe('noop');
		settle([a, b], 'A:""');
	});

	each('a peer types at the end of the head meanwhile: the head keeps the peer’s text', (ids) => {
		const [a, b] = peers(FLAT, ids);
		wipe(a);
		b.ed.insertText('A', 5, '!');
		settle([a, b], 'A:"!"');
	});

	each(
		'a peer types in another block meanwhile: it goes with the block (conc.delete-wins-block)',
		(ids) => {
			const [a, b] = peers(FLAT, ids);
			wipe(a);
			b.ed.insertText('B', 4, '!');
			settle([a, b], 'A:""');
		}
	);

	each('a peer deletes every block meanwhile: the document is empty (doc.empty.virtual)', (ids) => {
		const [a, b] = peers(FLAT, ids);
		wipe(a);
		expect(b.ed.deleteBlocks(['A', 'B', 'C']).status).toBe('applied');
		settle([a, b], '');
		b.undo();
		settle([a, b], 'A:""');
	});

	each('a range that leaves another block to hold the caret still removes the head', (ids) => {
		const [a, b] = peers(FLAT, ids);
		const plan = a.ed.prepare.deleteRange({ block: 'A', offset: 0 }, { block: 'B', offset: 4 });
		expect(plan.at).toEqual({ block: 'C', offset: 0 });
		a.ed.apply(plan);
		settle([a, b], 'C:"gamma"');
	});
});
