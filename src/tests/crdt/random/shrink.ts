/**
 * Auto-minimizer for failing corpus schedules (U02 §5).
 *
 * Greedy chunk removal (delta-debugging lite): try removing halves, quarters,
 * … down to single steps, keeping any reduction that still reproduces the
 * failure. Runs only on the failure path — never in the green path.
 */
import type { Schedule, Step } from './generator.js';

/**
 * Remove steps from `schedule` while `stillFails` keeps reporting failure.
 * Returns a smaller schedule (same seed/peer count).
 */
export const minimizeSchedule = (
	schedule: Schedule,
	stillFails: (steps: Step[]) => boolean
): Schedule => {
	let steps = schedule.steps.slice();
	let chunk = Math.floor(steps.length / 2);
	while (chunk >= 1) {
		let reduced = false;
		for (let i = 0; i + chunk <= steps.length; i++) {
			const candidate = steps.slice(0, i).concat(steps.slice(i + chunk));
			if (candidate.length > 0 && stillFails(candidate)) {
				steps = candidate;
				reduced = true;
				break; // restart same chunk size on the shorter list
			}
		}
		if (!reduced) chunk = Math.floor(chunk / 2);
	}
	return { ...schedule, steps };
};

/** Render a minimized schedule as a readable transcript for a regression test. */
export const describeSchedule = (schedule: Schedule): string => {
	const lines = schedule.steps.map((s, i) => {
		const op = JSON.stringify(s.op);
		return `  ${i}. peer ${s.peer}: ${op}`;
	});
	return `seed ${schedule.seed} — ${schedule.steps.length} steps\n${lines.join('\n')}`;
};
