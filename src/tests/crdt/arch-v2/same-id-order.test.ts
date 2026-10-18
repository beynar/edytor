/**
 * Two concurrent creations of one block id (`id.same.concurrent`) whose
 * slots reach the replicas in different orders keep one order everywhere
 * (fork patch YP22). The sort of two move records at one origin whose units
 * stand in different sequences reads the chain of home slots each record
 * names (the slot of the creation holding the unit's sequence — the
 * winner's, or the losing incarnation's), and a record waits for its chain,
 * so every replica that integrates the records compares them alike,
 * whichever creation it took first, in one update or in many.
 *
 * A seeded differential, as the order sweeps run: per seed, Ada and Bob each
 * create `N` (two children each) at once; Carol takes one of the two
 * creations first and moves a child of the `N` she sees to the root; Bob
 * moves one of his children to the same gap; Ada may move `N` or one of her
 * children; random partial deliveries follow. Every client-id assignment
 * (`clientTriples`, `clientPairs`), both observers' delivery orders (each
 * update twice) and every reload must read one tree, well formed.
 *
 * Expected values come from the contract (convergence, no loss), never from
 * running code.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../harness/rng.js';
import { clientPairs, clientTriples, converge } from './replica-harness.js';

const spec = (id: string, children: unknown[] = []) => ({
	id,
	type: 'paragraph',
	content: [{ kind: 'text', text: id }],
	children
});
const SEED = [
	{ id: 'p', text: 'p' },
	{ id: 'q', text: 'q' }
];
const SEEDS = Number(process.env.SAME_ID_SEEDS ?? 24);

/** One seeded program over two or three replicas. */
const program = (seed: number) => (reps) => {
	const rnd = mulberry32(seed);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
	const [A, B, C] = reps;
	const kids = (who: string) => [spec(`n${who}1`), spec(`n${who}2`)];
	const at = pick([1, 2]);
	A.ed.insertBlocks({ parent: null, index: at }, [spec('N', kids('A'))]);
	B.ed.insertBlocks({ parent: null, index: pick([1, 2]) }, [spec('N', kids('B'))]);
	const gap = pick([0, 1, 2]);
	if (C !== undefined) {
		const first = rnd() < 0.5 ? A : B;
		C.receiveAll(first.log);
		const who = first === A ? 'A' : 'B';
		C.ed.moveBlocks([pick([`n${who}1`, `n${who}2`])], { parent: null, index: gap });
	}
	B.ed.moveBlocks([pick(['nB1', 'nB2'])], { parent: null, index: gap });
	switch (pick(['none', 'moveN', 'nestChild', 'unNest'])) {
		case 'moveN':
			A.ed.moveBlocks(['N'], { parent: null, index: 0 });
			break;
		case 'nestChild':
			A.ed.nestBlock(pick(['nA1', 'nA2']), 'q');
			break;
		case 'unNest':
			A.ed.unNestBlock(pick(['nA1', 'nA2']));
			break;
	}
	// Partial deliveries in a random order before the harness delivers everything.
	for (let k = 0; k < 3; k++) {
		const from = pick(reps);
		const to = pick(reps);
		if (from !== to) to.receiveAll(from.log);
	}
	if (C !== undefined && rnd() < 0.5) C.ed.unNestBlock(pick(['nA1', 'nA2', 'nB1', 'nB2']));
};

/** The texts the tree shows, sorted. */
const texts = (ed): string[] =>
	ed
		.order()
		.map((id: string) => ed.blockText(id))
		.sort();

describe('id.same.concurrent: one order however the two creations arrive', () => {
	for (const count of [2, 3]) {
		it(`${count} replicas, ${SEEDS} seeds, every client-id assignment`, () => {
			const bad: string[] = [];
			const assignments = count === 2 ? clientPairs(8) : clientTriples(12);
			for (let seed = 1; seed <= SEEDS; seed++)
				for (const o of converge(SEED, count, program(seed), { assignments })) {
					// `N`'s registry value is the winning creation's (`id.same.concurrent`): the
					// node an id stands for changing is the contract here, nothing else is.
					const problems = o.problems.filter((p) => !/seed-displacement: N was node/.test(p));
					if (o.results.size !== 1 || problems.length > 0)
						bad.push(
							`seed ${seed} ${o.reps.map((r) => r.doc.clientID).join('/')}: ${o.results.size} results; ${problems.slice(0, 2).join('; ')}`
						);
					const seen = texts(o.ed);
					for (const t of ['p', 'q']) if (!seen.includes(t)) bad.push(`seed ${seed}: lost ${t}`);
					for (const r of o.reps) r.destroy();
				}
			expect(bad.slice(0, 8)).toEqual([]);
		});
	}
});
