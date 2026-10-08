// @ts-nocheck
/**
 * Generated deterministic command schedules — the expansion beyond the
 * single hand-written scenario: seeded programs drive REAL mounted
 * editors through REAL `runBeforeInputCommand` calls over the controlled
 * PeerSet transport, with a mid-run partition window and a final heal.
 *
 * Claims per seed:
 *  - determinism: two in-process runs produce byte-identical traces
 *    AND identical canonical signatures (structure + identity ids);
 *  - convergence: after the heal, all peers agree on one canonical tree
 *    including block/inline ids — a wrong-but-converged signature
 *    cannot hide, and a right-but-diverged one cannot pass;
 *  - per-command effect: EVERY generated op is checked against an
 *    independently computed post-state (expectedAfterOp) — a run whose
 *    commands are no-ops fails at the first step, not at convergence;
 *  - quiescence: every phase drains until NO settlement-class timer
 *    callback remains scheduled (installTimerAccounting classes by
 *    delay, so callbacks re-scheduled by callbacks must also drain);
 *  - replayability: the schedule (actor/block/offset/op + delivery
 *    decisions) is itself trace-recorded per step.
 *
 * Honest boundary: generated programs cover caret-level text ops and
 * delivery/partition scheduling. Structural op breadth (split/nest/
 * move) stays in the hand-written programs; expectedAfterOp's merge
 * model covers only flat-paragraph neighbors and throws (fails loudly)
 * outside it. Timer callbacks run on real jsdom timers — wall-time is
 * accounted, not virtualized (flushDomUpdates shares the same global
 * setTimeout, so full virtualization deadlocks the harness itself).
 *
 * The bounded 32-seed qualification campaign reuses this program via
 * command-campaign.test.ts (env-gated; see docs/archive/crdt-v14-execution-ledger.md).
 */
import { describe, expect, it } from 'vitest';
import { installTimerAccounting, runCommand } from './command-peer-set.js';
import { runSchedule } from './command-schedule-program.js';

describe('generated command schedules', () => {
	const seeds = [11, 42, 73, 101, 137];

	it.each(seeds)('seed %i: identical trace + signature across in-process repeats', async (seed) => {
		const first = await runSchedule(seed, 18);
		const second = await runSchedule(seed, 18);
		expect(second.trace).toBe(first.trace);
		expect(second.signature).toEqual(first.signature);
		// Converged: the canonical signatures ARE the same tree — the
		// equality above plus a non-trivial structure.
		expect(first.signature.A.length).toBeGreaterThan(0);
		expect(first.signature.A).toEqual(first.signature.B);
	});

	it.each([7, 55])('seed %i: different step count still converges identically', async (seed) => {
		const first = await runSchedule(seed, 30);
		const second = await runSchedule(seed, 30);
		expect(second.trace).toBe(first.trace);
		expect(first.signature.A).toEqual(first.signature.B);
	});

	it('fails the first step when commands produce no effect — repeatability is not the oracle', async () => {
		// The reviewer's probe made permanent: a no-op command executor
		// used to pass all seven schedules (an unchanged document satisfied
		// every assertion). expectedAfterOp now fails at the first step.
		await expect(runSchedule(11, 4, { runOp: () => {} })).rejects.toThrow();
	});

	it('fails when the command executor defers a corrupting write past the assertion', async () => {
		// The reviewer's second probe: wrap the REAL executor so every op
		// also schedules a 100ms mutation. Asserting before the local
		// settle lets the corrupted tree become the next step's accepted
		// baseline — every per-command check passed while both peers
		// converged to corruption. With settle-then-assert, the first
		// step's expectation sees 'CORRUPTION' and fails loudly.
		const corrupting: typeof runCommand = (edytor, inputType, data) => {
			runCommand(edytor, inputType, data);
			setTimeout(() => {
				edytor.root?.children[0]?.firstText.insertAt(0, 'CORRUPTION');
			}, 100);
		};
		const err = await runSchedule(11, 4, { runOp: corrupting }).then(
			() => null,
			(e: unknown) => e
		);
		expect(String(err)).toMatch(/CORRUPTION|Expected|toEqual/i);
	});

	it('a window still open at the end is drained, so the trace never records the wall clock', async () => {
		// The seed-73 flake: the final quiesce recorded how many timers past
		// the settlement horizon were still pending, which depends on how
		// long the run took. Every step here opens a 400 ms window: a fast
		// run ended with the last one pending, a slow one without.
		const windowed: typeof runCommand = (edytor, inputType, data) => {
			runCommand(edytor, inputType, data);
			setTimeout(() => {}, 400);
		};
		const { trace } = await runSchedule(11, 4, { runOp: windowed });
		expect(trace).toContain('final quiesce settled (0 out-of-horizon pending)');
	});

	it('quiesce crosses a microtask checkpoint — microtask-scheduled timers still drain', async () => {
		// `queueMicrotask(() => setTimeout(cb, 10))` registers its timer
		// AFTER quiesce's first inspection — an empty map at entry used to
		// report settlement while the callback was still pending.
		const timers = installTimerAccounting();
		try {
			let fired = false;
			queueMicrotask(() => setTimeout(() => (fired = true), 10));
			await timers.quiesce();
			expect(fired).toBe(true);
		} finally {
			timers.restore();
		}
	});

	it('quiesce crosses a real task boundary — chained microtasks cannot hide a timer', async () => {
		// `queueMicrotask(() => queueMicrotask(() => setTimeout(cb, 10)))`:
		// the inner µt registers its timer AFTER a promise-checkpoint
		// continuation resumes (the continuation is queued ahead of the
		// chained µt). Only a macrotask boundary — which runs once the
		// microtask queue is fully drained — observes it.
		const timers = installTimerAccounting();
		try {
			let fired = false;
			queueMicrotask(() => queueMicrotask(() => setTimeout(() => (fired = true), 10)));
			await timers.quiesce();
			expect(fired).toBe(true);
			expect(timers.inHorizon()).toBe(0);
		} finally {
			timers.restore();
		}
	});

	it('quiesce drains timers registered by microtasks queued inside timer callbacks', async () => {
		const timers = installTimerAccounting();
		try {
			let fired = false;
			setTimeout(() => queueMicrotask(() => setTimeout(() => (fired = true), 10)), 10);
			await timers.quiesce();
			expect(fired).toBe(true);
		} finally {
			timers.restore();
		}
	});

	it('quiesce fails the bounded check for a deliberately nonsettling chain', async () => {
		const timers = installTimerAccounting(250, 10);
		// `live` gates rescheduling: restoring the spy cannot stop an
		// already-scheduled real timer from firing — without it the chain
		// leaks past `restore` and infects later tests' accounting.
		let live = true;
		try {
			const reschedule = () => {
				if (live) setTimeout(reschedule, 10);
			};
			setTimeout(reschedule, 10);
			await expect(timers.quiesce()).rejects.toThrow(/quiescence not reached/);
		} finally {
			live = false;
			timers.restore();
		}
	});

	it('quiesce accounts animation-frame callbacks', async () => {
		const timers = installTimerAccounting();
		try {
			let fired = false;
			requestAnimationFrame(() => (fired = true));
			await timers.quiesce();
			expect(fired).toBe(true);
		} finally {
			timers.restore();
		}
	});
});
