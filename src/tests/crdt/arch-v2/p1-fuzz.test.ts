/**
 * arch-v2 phase 2 P1.1 — the native review's multi-replica fuzz campaign
 * (`review-probes/fuzz-lib.ts`, `fuzz.test.ts`) re-targeted at arch-v2.
 *
 * 3–5 replicas, each a real document driven through the facade: insert,
 * delete, replace, range delete, format, split, merge (backward and
 * forward), move, nest, unnest, block delete (subtree and keep-children),
 * block create, multi-line paste, retype (incl. an island and a void kind),
 * inline atoms, undo and redo. Delivery is random: batches from one replica
 * to another, shuffled, with duplicates; replicas go offline (neither send
 * nor receive) and come back; occasional full syncs.
 *
 * Asserted per program (the native probe's failure kinds, arch-v2 terms):
 * - `throw`: no facade op, undo or redo throws (a local refusal is a
 *   result, not a failure);
 * - `refused`: no inbound update is refused by the admission gate or left
 *   unapplied;
 * - `stuck-pending`: nothing is held back after full delivery;
 * - `diverge`: every replica agrees; an observer fed every update in
 *   reverse order (each twice) agrees; a binary reload of every replica
 *   agrees (the native `fastpath` check: the maintained index equals a
 *   document rebuilt from bytes);
 * - `tree` / `dup-atom`: every block reachable once with a consistent
 *   parent, every visible character identity once.
 *
 * A failing seed is shrunk to a minimal replayable program (the recorded
 * steps carry concrete arguments) and printed in the assertion message.
 *
 * Knobs: `P1_FUZZ_SEEDS` (default 200), `P1_FUZZ_START` (1), `P1_FUZZ_LEN`
 * (40), `P1_FUZZ_WIDE` (seeds of the 5-replica pass, default 40).
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import {
	quiesce,
	reloadCanonical,
	replica,
	seedUpdate,
	syncAll,
	wellFormed,
	type Replica
} from './p1-harness.js';
import { ACTIONS, apply, genAction, rngOf } from './p1-ops.js';

const SEEDS = [
	{
		id: 'A',
		text: 'alpha',
		children: [
			{ id: 'A1', text: 'one' },
			{ id: 'A2', text: 'two' }
		]
	},
	{ id: 'B', text: 'bravo' },
	{ id: 'C', text: 'charlie', children: [{ id: 'C1', text: 'x' }] },
	{ id: 'D', text: 'delta' }
];
const SEMANTICS = { roles: { callout: { island: true }, divider: { void: true } } };
const SEED = seedUpdate(SEEDS, SEMANTICS);

type Step =
	| { t: 'op'; r: number; action: string; args: unknown[] }
	| { t: 'deliver'; to: number; from: number; n: number; shuffle: number; dup: boolean }
	| { t: 'offline'; r: number; on: boolean }
	| { t: 'sync' };
type Failure = { kind: string; detail: string };

/** Outcome counts per action (`insert:applied`, `undo:item`, …) — the campaign's coverage. */
const STATS = new Map<string, number>();

type World = { reps: Replica[]; sentTo: number[][]; online: boolean[] };

const world = (n: number, seed: number): World => ({
	reps: Array.from({ length: n }, (_, i) =>
		replica(`R${i}`, SEED, 1 + ((seed * 31 + i * 7) % 5000) + i * 5000, {
			semantics: SEMANTICS,
			salt: seed
		})
	),
	sentTo: Array.from({ length: n }, () => Array(n).fill(0)),
	online: Array(n).fill(true)
});

const deliver = (w: World, to: number, from: number, n = Infinity, shuffle = 0, dup = false) => {
	if (to === from || !w.online[to] || !w.online[from]) return;
	const src = w.reps[from];
	const start = w.sentTo[from][to];
	const batch = src.log.slice(start, start + n);
	w.sentTo[from][to] = start + batch.length;
	const order = [...batch];
	if (shuffle) {
		const r = rngOf(shuffle);
		for (let i = order.length - 1; i > 0; i--) {
			const j = r(i + 1);
			[order[i], order[j]] = [order[j], order[i]];
		}
		if (dup && batch.length) order.push(batch[r(batch.length)]);
	}
	w.reps[to].receiveAll(order);
};

const execute = (w: World, step: Step, failures: Failure[]) => {
	if (step.t === 'op') {
		const r = w.reps[step.r];
		try {
			const res = apply(r, step.action, structuredClone(step.args));
			const k = `${step.action}:${res === null ? 'null' : (res?.status ?? (res ? 'item' : String(res)))}`;
			STATS.set(k, (STATS.get(k) ?? 0) + 1);
		} catch (e) {
			failures.push({
				kind: 'throw',
				detail: `${r.name} ${step.action}(${JSON.stringify(step.args)}): ${e?.stack ?? e}`
			});
		}
	} else if (step.t === 'deliver') deliver(w, step.to, step.from, step.n, step.shuffle, step.dup);
	else if (step.t === 'offline') w.online[step.r] = !step.on;
	else for (const to of w.reps.keys()) for (const from of w.reps.keys()) deliver(w, to, from);
};

/** Finish: everyone online, full sync, then every check. */
const verdict = (w: World, failures: Failure[]) => {
	w.online.fill(true);
	for (let k = 0; k < 2; k++)
		for (const to of w.reps.keys()) for (const from of w.reps.keys()) deliver(w, to, from);
	syncAll(w.reps); // belt and braces: re-deliver everything (duplicates)
	for (const r of w.reps) {
		for (const p of r.problems) failures.push({ kind: 'refused', detail: p });
		if (r.pending()) failures.push({ kind: 'stuck-pending', detail: r.name });
	}
	// An observer fed every update in reverse order, each twice: nothing may
	// stay pending once it holds every update.
	const all = w.reps.flatMap((r) => r.log).reverse();
	const obs = replica('obs', SEED, 7777, { semantics: SEMANTICS });
	for (const u of all) {
		obs.receive(u);
		obs.receive(u);
	}
	if (obs.pending()) failures.push({ kind: 'observer-pending', detail: '' });
	// Then its own writes (the engine's formatting cleanup) propagate like
	// anyone's, and everybody must agree (`quiesce`).
	try {
		quiesce([...w.reps, obs]);
	} catch (e) {
		failures.push({ kind: 'no-quiescence', detail: String(e) });
	}
	for (const p of obs.problems) failures.push({ kind: 'observer-refused', detail: p });
	const canon = w.reps.map((r) => r.canonical());
	if (new Set(canon).size !== 1) failures.push({ kind: 'diverge', detail: canon.join('\n') });
	if (obs.canonical() !== canon[0])
		failures.push({ kind: 'observer-diverge', detail: obs.canonical() });
	for (const r of w.reps) {
		const reloaded = reloadCanonical(r);
		if (reloaded !== canon[0]) failures.push({ kind: 'reload', detail: `${r.name}: ${reloaded}` });
	}
	obs.destroy();
	for (const p of wellFormed(w.reps[0].ed))
		failures.push({ kind: p.startsWith('duplicate atom') ? 'dup-atom' : 'tree', detail: p });
	for (const r of w.reps) r.destroy();
};

/** Generate and run one program; returns the recorded (replayable) steps and failures. */
const generate = (seed: number, n: number, length: number) => {
	const next = rngOf(seed);
	const w = world(n, seed);
	const counter = { n: 0 };
	const steps: Step[] = [];
	const failures: Failure[] = [];
	for (let i = 0; i < length; i++) {
		const roll = next(20);
		let step: Step | null = null;
		if (roll < 13) {
			const r = next(n);
			const a = genAction(w.reps[r], next, counter);
			if (a) step = { t: 'op', r, ...a };
		} else if (roll < 17) {
			const to = next(n);
			const from = next(n);
			if (to !== from)
				step = {
					t: 'deliver',
					to,
					from,
					n: 1 + next(4),
					shuffle: 1 + next(1e9),
					dup: next(3) === 0
				};
		} else if (roll < 19) {
			const r = next(n);
			step = { t: 'offline', r, on: w.online[r] };
		} else step = { t: 'sync' };
		if (!step) continue;
		steps.push(step);
		execute(w, step, failures);
	}
	verdict(w, failures);
	return { steps, failures };
};

const replay = (seed: number, n: number, steps: Step[]) => {
	const w = world(n, seed);
	const failures: Failure[] = [];
	for (const s of steps) execute(w, s, failures);
	verdict(w, failures);
	return failures;
};

/** Delta-debug `steps` down to a minimal program that still fails with `kind`. */
const shrink = (seed: number, n: number, steps: Step[], kind: string) => {
	let cur = steps;
	const fails = (s: Step[]) => replay(seed, n, s).some((f) => f.kind === kind);
	for (let chunk = Math.max(1, cur.length >> 1); chunk >= 1; chunk >>= 1) {
		for (let i = 0; i + chunk <= cur.length; ) {
			const cand = [...cur.slice(0, i), ...cur.slice(i + chunk)];
			if (fails(cand)) cur = cand;
			else i += chunk;
		}
	}
	return cur;
};

const campaign = (n: number, seeds: number, start: number, length: number) => {
	const byKind = new Map<string, { seed: number; detail: string }[]>();
	for (let seed = start; seed < start + seeds; seed++) {
		const { failures } = generate(seed, n, length);
		for (const k of new Set(failures.map((f) => f.kind))) {
			const list = byKind.get(k) ?? [];
			list.push({ seed, detail: failures.find((f) => f.kind === k)!.detail });
			byKind.set(k, list);
		}
	}
	const report: Record<string, unknown> = {};
	for (const [kind, list] of byKind) {
		const first = list[0];
		const { steps } = generate(first.seed, n, length);
		report[kind] = {
			seeds: list.map((x) => x.seed).slice(0, 15),
			count: list.length,
			detail: first.detail.slice(0, 2000),
			minimal: shrink(first.seed, n, steps, kind)
		};
	}
	return report;
};

const env = (k: string, d: number) => Number(process.env[k] ?? d);
const START = env('P1_FUZZ_START', 1);
const LEN = env('P1_FUZZ_LEN', 40);

describe('P1 fuzz — multi-replica campaign through the facade (review-probes/fuzz)', () => {
	it(`3 replicas × ${env('P1_FUZZ_SEEDS', 200)} seeds × ${LEN} steps: converge, no refusal, nothing pending, well-formed`, () => {
		STATS.clear();
		const report = campaign(3, env('P1_FUZZ_SEEDS', 200), START, LEN);
		expect(report, JSON.stringify(report, null, 1)).toEqual({});
		// Not vacuous: every action wrote at least once (undo/redo popped a step).
		const wrote = new Set(
			[...STATS.keys()].filter((k) => /:(applied|item)$/.test(k)).map((k) => k.split(':')[0])
		);
		expect([...new Set(ACTIONS)].filter((a) => !wrote.has(a))).toEqual([]);
	});

	it(`5 replicas × ${env('P1_FUZZ_WIDE', 40)} seeds × ${LEN + 20} steps, offline churn`, () => {
		const report = campaign(5, env('P1_FUZZ_WIDE', 40), START + 5000, LEN + 20);
		expect(report, JSON.stringify(report, null, 1)).toEqual({});
	});
});
