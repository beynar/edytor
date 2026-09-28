/**
 * Per-writer text delete marks (`src/lib/crdt/text/deletes.ts`, fork patch
 * P11) — the delivery-order variants of the contract program
 * `history.concurrent-double-delete` (P1.3 open defect; ledger row).
 *
 * The rule the expected values come from (written before the fix, never
 * read off production output):
 *
 *   A character is visible iff no writer's delete of it is in effect, and at
 *   most one copy of it is visible. A writer's delete is in effect from the
 *   delete until that writer undoes it, and again after a redo.
 *
 * So one writer's undo never brings back a character another writer's delete
 * still holds, whichever order the updates arrive in, and when every writer
 * undid, exactly one copy returns — the D54 rule of blocks (F-D18) applied to
 * text.
 *
 * Every row runs through the facade on real documents (`p1-harness.ts`):
 * three client-id assignments, an observer fed every update in both orders
 * (each twice), a binary reload of every replica, and quiescence (a replica
 * that must hide or restore a copy after a remote change writes it in a
 * follow-up transaction, like the engine's formatting cleanup). Steps check
 * the text on the replicas that have seen the step; `settle` delivers
 * everything to everyone until nobody writes.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import {
	converge,
	permutations,
	quiesce,
	replica,
	seedUpdate,
	type Replica
} from './p1-harness.js';
import { mulberry32 } from '../harness/rng.js';
import { loadDocument } from '../../../lib/crdt/index.js';

const one = (outcomes) => {
	for (const o of outcomes) {
		expect(o.problems, 'no refusal, nothing pending, well-formed').toEqual([]);
		expect(o.results.size, 'every replica, observer order and reload agrees').toBe(1);
	}
	return outcomes;
};
const text = (r: Replica) => r.ed.blockText('p');
/** Deliver everything to everyone until nobody writes. */
const settle = (reps: Replica[]) => quiesce(reps);
/** Every replica shows `expected`. */
const all = (reps: Replica[], expected: string) =>
	expect(reps.map(text)).toEqual(reps.map(() => expected));

const ABC = [{ id: 'p', text: 'abc' }];

describe('text delete marks — two writers', () => {
	it('A undoes after seeing B’s delete → `ac` (B still holds `b`); B undoes → `abc`', () => {
		one(
			converge(ABC, 2, (reps) => {
				const [a, b] = reps;
				a.ed.deleteText('p', 1, 1);
				b.ed.deleteText('p', 1, 1);
				settle(reps);
				a.undo();
				expect(text(a)).toBe('ac');
				settle(reps);
				all(reps, 'ac');
				b.undo();
				expect(text(b)).toBe('abc');
				settle(reps);
				all(reps, 'abc');
			})
		).forEach((o) => expect(o.ed.blockText('p')).toBe('abc'));
	});

	it('B undoes first → `ac`; then A → `abc`', () => {
		one(
			converge(ABC, 2, (reps) => {
				const [a, b] = reps;
				a.ed.deleteText('p', 1, 1);
				b.ed.deleteText('p', 1, 1);
				settle(reps);
				b.undo();
				settle(reps);
				all(reps, 'ac');
				a.undo();
				settle(reps);
				all(reps, 'abc');
			})
		);
	});

	it('A undoes before B’s delete reached it → A shows `abc`; once B’s delete arrives, `ac` everywhere; B undoes → `abc`', () => {
		one(
			converge(ABC, 2, (reps) => {
				const [a, b] = reps;
				a.ed.deleteText('p', 1, 1);
				b.ed.deleteText('p', 1, 1);
				a.undo();
				expect(text(a)).toBe('abc');
				settle(reps);
				all(reps, 'ac');
				b.undo();
				settle(reps);
				all(reps, 'abc');
			})
		).forEach((o) => expect(o.ed.blockText('p')).toBe('abc'));
	});

	it('A’s restoration reaches B while B’s delete is in effect: B hides it, and A shows `ac` once B’s hold reaches it', () => {
		one(
			converge(ABC, 2, (reps) => {
				const [a, b] = reps;
				a.ed.deleteText('p', 1, 1);
				const dB = b.capture(() => b.ed.deleteText('p', 1, 1));
				b.receiveAll(a.capture(() => a.undo()));
				expect(text(b)).toBe('ac');
				// B's delete alone does not tell A that B still holds `b`: the
				// hold is B's to enforce, and it arrives with B's next update.
				a.receiveAll(dB);
				expect(text(a)).toBe('abc');
				a.receiveAll(b.log);
				expect(text(a)).toBe('ac');
				settle(reps);
				all(reps, 'ac');
			})
		);
	});

	it('both undo before either saw the other’s delete → one copy: `abc`', () => {
		one(
			converge(ABC, 2, (reps) => {
				const [a, b] = reps;
				a.ed.deleteText('p', 1, 1);
				b.ed.deleteText('p', 1, 1);
				a.undo();
				b.undo();
				expect([text(a), text(b)]).toEqual(['abc', 'abc']);
				settle(reps);
				all(reps, 'abc');
			})
		).forEach((o) => expect(o.ed.blockText('p')).toBe('abc'));
	});

	it('both undo concurrently after seeing both deletes → each still `ac` alone; together `abc` (one copy)', () => {
		one(
			converge(ABC, 2, (reps) => {
				const [a, b] = reps;
				a.ed.deleteText('p', 1, 1);
				b.ed.deleteText('p', 1, 1);
				settle(reps);
				a.undo();
				b.undo();
				expect([text(a), text(b)]).toEqual(['ac', 'ac']);
				settle(reps);
				all(reps, 'abc');
			})
		).forEach((o) => expect(o.ed.blockText('p')).toBe('abc'));
	});

	it('the concurrent undos cross one update at a time, in both directions', () => {
		one(
			converge(ABC, 2, (reps) => {
				const [a, b] = reps;
				a.ed.deleteText('p', 1, 1);
				b.ed.deleteText('p', 1, 1);
				settle(reps);
				const uA = a.capture(() => a.undo());
				const uB = b.capture(() => b.undo());
				b.receiveAll(uA);
				a.receiveAll(uB);
				settle(reps);
				all(reps, 'abc');
			})
		);
	});

	it('overlapping ranges: A deletes `bc`, B deletes `b` → A’s undo returns only `c`; B’s returns `b`', () => {
		one(
			converge([{ id: 'p', text: 'abcd' }], 2, (reps) => {
				const [a, b] = reps;
				a.ed.deleteText('p', 1, 2);
				b.ed.deleteText('p', 1, 1);
				settle(reps);
				all(reps, 'ad');
				a.undo();
				settle(reps);
				all(reps, 'acd');
				b.undo();
				settle(reps);
				all(reps, 'abcd');
			})
		);
	});
});

describe('text delete marks — inline atoms', () => {
	it('A and B remove the same inline atom; A undoes → still gone; B undoes → back once, with its id, type and data', () => {
		const atom = (r: Replica) =>
			(r.ed.blockJSON('p').content ?? []).filter((c) => c.text === undefined);
		one(
			converge(ABC, 2, (reps) => {
				const [a, b] = reps;
				a.ed.insertInline('p', 1, { type: 'mention', id: 'm1', data: { name: 'x' } });
				settle(reps);
				a.ed.removeInline('p', 'm1');
				b.ed.removeInline('p', 'm1');
				settle(reps);
				a.undo();
				settle(reps);
				expect(reps.map(atom)).toEqual([[], []]);
				b.undo();
				settle(reps);
				for (const r of reps)
					expect(atom(r)).toEqual([{ type: 'mention', id: 'm1', data: { name: 'x' } }]);
			})
		);
	});
});

describe('text delete marks — redo and repeated undo', () => {
	it('redo puts the writer’s delete back in effect, whoever restored the character', () => {
		one(
			converge(ABC, 2, (reps) => {
				const [a, b] = reps;
				a.ed.deleteText('p', 1, 1);
				b.ed.deleteText('p', 1, 1);
				settle(reps);
				a.undo();
				settle(reps);
				all(reps, 'ac');
				b.undo();
				settle(reps);
				all(reps, 'abc');
				a.redo();
				expect(text(a)).toBe('ac');
				settle(reps);
				all(reps, 'ac');
				b.redo();
				settle(reps);
				all(reps, 'ac');
				a.undo();
				settle(reps);
				all(reps, 'ac');
				b.undo();
				settle(reps);
				all(reps, 'abc');
			})
		).forEach((o) => expect(o.ed.blockText('p')).toBe('abc'));
	});

	it('one writer undoes, redoes and undoes again while the other holds → `ac` throughout; the other’s undo → `abc`', () => {
		one(
			converge(ABC, 2, (reps) => {
				const [a, b] = reps;
				a.ed.deleteText('p', 1, 1);
				b.ed.deleteText('p', 1, 1);
				settle(reps);
				for (const step of [() => a.undo(), () => a.redo(), () => a.undo()]) {
					step();
					settle(reps);
					all(reps, 'ac');
				}
				b.undo();
				settle(reps);
				all(reps, 'abc');
			})
		);
	});

	it('the last holder undoes, redoes, undoes: `abc`, `ac`, `abc`', () => {
		one(
			converge(ABC, 2, (reps) => {
				const [a, b] = reps;
				a.ed.deleteText('p', 1, 1);
				b.ed.deleteText('p', 1, 1);
				settle(reps);
				b.undo();
				settle(reps);
				for (const [step, expected] of [
					[() => a.undo(), 'abc'],
					[() => a.redo(), 'ac'],
					[() => a.undo(), 'abc']
				] as const) {
					step();
					settle(reps);
					all(reps, expected);
				}
			})
		);
	});

	it('text typed and deleted inside one capture group is no step: undo reaches the step before (a canceled preview)', () => {
		const document = loadDocument(seedUpdate(ABC), { history: { captureTimeout: 60_000 } });
		const ed = document.facade;
		ed.insertText('p', 0, 'Y');
		document.history.stopCapturing();
		ed.insertText('p', 1, 'X');
		ed.deleteText('p', 1, 1);
		expect(ed.blockText('p')).toBe('Yabc');
		document.history.undo();
		expect(ed.blockText('p')).toBe('abc');
		document.history.redo();
		expect(ed.blockText('p')).toBe('Yabc');
		document.destroy();
	});

	it('a single writer’s delete, undo, redo, undo is unchanged (`ac`, `abc`, `ac`, `abc`)', () => {
		one(
			converge(ABC, 1, ([a]) => {
				a.ed.deleteText('p', 1, 1);
				expect(text(a)).toBe('ac');
				a.undo();
				expect(text(a)).toBe('abc');
				a.redo();
				expect(text(a)).toBe('ac');
				a.undo();
				expect(text(a)).toBe('abc');
			})
		);
	});
});

describe('text delete marks — three writers', () => {
	for (const order of permutations([0, 1, 2])) {
		it(`undo order ${order.map((i) => 'ABC'[i]).join('')}: \`ac\`, \`ac\`, then \`abc\``, () => {
			one(
				converge(ABC, 3, (reps) => {
					for (const r of reps) r.ed.deleteText('p', 1, 1);
					settle(reps);
					order.forEach((i, n) => {
						reps[i].undo();
						settle(reps);
						all(reps, n < 2 ? 'ac' : 'abc');
					});
				})
			);
		});
	}

	it('the first undo reaches the others before either delete reached it → `ac` until the last undo', () => {
		one(
			converge(ABC, 3, (reps) => {
				const [a, b, c] = reps;
				a.ed.deleteText('p', 1, 1);
				b.ed.deleteText('p', 1, 1);
				c.ed.deleteText('p', 1, 1);
				a.undo();
				settle(reps);
				all(reps, 'ac');
				b.undo();
				settle(reps);
				all(reps, 'ac');
				c.undo();
				settle(reps);
				all(reps, 'abc');
			})
		);
	});

	it('all three undo concurrently → one copy', () => {
		one(
			converge(ABC, 3, (reps) => {
				for (const r of reps) r.ed.deleteText('p', 1, 1);
				settle(reps);
				for (const r of reps) r.undo();
				settle(reps);
				all(reps, 'abc');
			})
		);
	});
});

/**
 * Random programs: three writers delete overlapping ranges of a text of
 * unique letters (a letter IS its character's identity, across copies),
 * undo and redo, over FIFO links delivered in random order. The oracle is
 * the rule itself: once everything is delivered, every replica shows the
 * original letters minus those some writer's in-effect step deletes; once
 * every writer has undone everything, the original text.
 */
describe('text delete marks — random programs', () => {
	const LETTERS = 'abcdefghijkl';
	const SEEDS = Number(process.env.TEXT_DELETE_SEEDS ?? 150);
	type Mode = { writers: number; steps: number; typing: boolean };

	const run = (seed: number, mode: Mode) => {
		const rand = mulberry32(seed);
		const pick = (n: number) => Math.floor(rand() * n);
		const seedBytes = seedUpdate([{ id: 'p', text: LETTERS }]);
		const reps = [20, 30, 7, 55]
			.slice(0, mode.writers)
			.map((cid, i) => replica('ABCD'[i], seedBytes, cid + seed * 5));
		const n = reps.length;
		// Each writer's history as letters (deletes only): undo stack and redo stack.
		const undo = reps.map(() => [] as string[][]);
		const redo = reps.map(() => [] as string[][]);
		const sent = reps.map(() => reps.map(() => 0));
		let typed = 0;
		const expected = () => {
			const held = new Set(undo.flat(2));
			return [...LETTERS].filter((l) => !held.has(l)).join('');
		};
		for (let step = 0; step < mode.steps; step++) {
			const i = pick(n);
			const r = reps[i];
			const op = rand();
			if (op < 0.35) {
				const view = text(r);
				if (view.length === 0) continue;
				const at = pick(view.length);
				const len = 1 + pick(Math.min(3, view.length - at));
				r.ed.deleteText('p', at, len);
				undo[i].push([...view.slice(at, at + len)]);
				redo[i] = [];
			} else if (mode.typing && op < 0.45) {
				const ch = String.fromCharCode(0x41 + (typed++ % 26));
				r.ed.insertText('p', pick(text(r).length + 1), ch);
			} else if (op < 0.6) {
				if (mode.typing ? !r.document.history.canUndo() : undo[i].length === 0) continue;
				r.undo();
				if (!mode.typing) redo[i].push(undo[i].pop()!);
			} else if (op < 0.7) {
				if (mode.typing ? !r.document.history.canRedo() : redo[i].length === 0) continue;
				r.redo();
				if (!mode.typing) undo[i].push(redo[i].pop()!);
			} else {
				// deliver the next updates one peer sent, in its order
				const j = (i + 1 + pick(n - 1)) % n;
				const from = reps[j].log;
				const to = Math.min(from.length, sent[j][i] + 1 + pick(3));
				r.receiveAll(from.slice(sent[j][i], to));
				sent[j][i] = to;
			}
		}
		quiesce(reps);
		const mid = mode.typing ? null : expected();
		const midTexts = reps.map(text);
		for (const r of reps)
			while (r.document.history.canUndo()) {
				r.undo();
			}
		quiesce(reps);
		const end = reps.map(text);
		const problems = reps.flatMap((r) => [
			...r.problems,
			...(r.pending() ? [`${r.name} pending`] : [])
		]);
		for (const r of reps) r.destroy();
		return { mid, midTexts, end, problems };
	};

	const check = (mode: Mode) => {
		const failures: string[] = [];
		for (let seed = 1; seed <= SEEDS; seed++) {
			const o = run(seed, mode);
			const at = `seed ${seed}`;
			if (o.problems.length > 0) failures.push(`${at}: ${o.problems.join(', ')}`);
			if (new Set(o.midTexts).size !== 1 || new Set(o.end).size !== 1)
				failures.push(`${at}: diverged ${JSON.stringify([o.midTexts, o.end])}`);
			if (o.mid !== null && o.midTexts[0] !== o.mid)
				failures.push(`${at}: after delivery ${o.midTexts[0]}, expected ${o.mid}`);
			for (const t of [o.midTexts[0], o.end[0]])
				if (new Set(t).size !== t.length) failures.push(`${at}: a letter shows twice in ${t}`);
			const original = [...o.end[0]].filter((l) => LETTERS.includes(l)).join('');
			if (original !== LETTERS) failures.push(`${at}: after every undo ${o.end[0]}`);
			if (!mode.typing && o.end[0] !== LETTERS)
				failures.push(`${at}: after every undo ${o.end[0]}`);
		}
		return failures;
	};

	it(`${SEEDS} seeds, three writers deleting: after delivery the in-effect deletes; after every undo the original`, () => {
		expect(check({ writers: 3, steps: 14, typing: false })).toEqual([]);
	});

	it(`${SEEDS} seeds, four writers deleting, longer programs`, () => {
		expect(check({ writers: 4, steps: 24, typing: false })).toEqual([]);
	});

	it(`${SEEDS} seeds, three writers deleting and typing: converged, no letter twice, every original letter back in order after every undo`, () => {
		expect(check({ writers: 3, steps: 18, typing: true })).toEqual([]);
	});
});
