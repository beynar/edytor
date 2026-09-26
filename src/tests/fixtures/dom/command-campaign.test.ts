// @ts-nocheck
/**
 * Bounded qualification campaign (execution-ledger acceptance gate):
 * 32 fixed seeds × 24 commands through the SAME program the pinned
 * schedule spec uses (command-schedule-program.ts) — mounted editors,
 * real beforeinput commands, controlled transport, mid-run partition,
 * final heal.
 *
 * Env-gated so the suite does not pay ~minutes per run:
 *   COMMAND_CAMPAIGN=1 pnpm vitest --config ./vitest.dom.config.ts --run \
 *     src/tests/fixtures/dom/command-campaign.test.ts
 *
 * What it proves beyond the pinned seeds: breadth. Each seed must converge
 * to an identical canonical signature on both peers (identity ids included),
 * and the run reports realized coverage — actor mix, op kinds, delivery
 * volume, withheld deliveries, out-of-horizon remainders — so the campaign
 * cannot pass on a narrow or silent program. The summary line is ledger
 * evidence; it is printed once at the end.
 *
 * Bounds: same honest boundary as the schedule spec — caret-level text ops
 * plus one flat merge class; structural op breadth stays in the
 * hand-written programs; real jsdom timers (accounted, not virtualized).
 */
import { describe, expect, it } from 'vitest';
import { runSchedule } from './command-schedule-program.js';

const CAMPAIGN = !!process.env.COMMAND_CAMPAIGN;
const SEEDS = Array.from({ length: 32 }, (_, i) => i + 1);
const STEPS = 24;

describe.skipIf(!CAMPAIGN)('bounded command campaign (32 seeds × 24 commands)', () => {
	const coverage = {
		ops: { insertText: 0, deleteContentBackward: 0, deleteContentForward: 0 },
		actors: { A: 0, B: 0 },
		delivered: 0,
		withheld: 0,
		partitions: 0,
		heals: 0,
		outOfHorizonRemainders: 0
	};

	it.each(SEEDS)('seed %i converges to an identical signature', async (seed) => {
		const { events, signature } = await runSchedule(seed, STEPS);
		expect(signature.A.length).toBeGreaterThan(0);
		expect(signature.A).toEqual(signature.B);

		for (const e of events) {
			if (e.kind === 'command') {
				if (e.i) {
					coverage.actors[e.a as 'A' | 'B']++;
					if (e.i in coverage.ops) coverage.ops[e.i as keyof typeof coverage.ops]++;
				} else if (e.d?.includes(' quiesce settled ')) {
					const m = e.d.match(/\((\d+) out-of-horizon pending\)/);
					if (m && +m[1] > 0) coverage.outOfHorizonRemainders++;
				}
			} else if (e.kind === 'deliver') {
				if ((e.n ?? 0) === 0) coverage.withheld++;
				else coverage.delivered++;
			} else if (e.kind === 'partition') coverage.partitions++;
			else if (e.kind === 'heal') coverage.heals++;
		}
	});

	it('reports realized coverage for the ledger', () => {
		// Runs last (spec order) — prints once all seeds contributed.
		console.log(
			`CAMPAIGN-COVERAGE ${JSON.stringify({ seeds: SEEDS.length, steps: STEPS, ...coverage })}`
		);
		expect(coverage.actors.A).toBeGreaterThan(0);
		expect(coverage.actors.B).toBeGreaterThan(0);
		expect(coverage.ops.insertText).toBeGreaterThan(0);
		expect(coverage.ops.deleteContentBackward).toBeGreaterThan(0);
		expect(coverage.delivered).toBeGreaterThan(0);
	});
});
