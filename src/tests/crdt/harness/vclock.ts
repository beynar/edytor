/**
 * Virtual clock for headless determinism (U3).
 *
 * The vendored `UndoManager` groups capture windows via
 * `time.getUnixTime()` from `lib0-v14/time` — a live namespace lookup,
 * so a module mock gives complete control of every time-dependent engine
 * behavior (undo coalescing is the concrete consumer today; awareness
 * expiry would go through the same seam).
 *
 * Importing this module installs the mock for the importer's module graph:
 * `vi.mock` registers per test context, so a single
 * `import { vclock } from './vclock.js'` is the entire setup. Advance time
 * with `vclock.advance(ms)` — never `Date.now()`/`setTimeout`, which stay
 * real and are outside this lane's controlled boundary.
 *
 * Wire a PeerSet's trace timestamps to the same clock:
 * `set.clock = () => vclock.now`.
 */
import { vi } from 'vitest';

/** The clock the mocked engine reads. Start at a nonzero base so `lastChange > 0` checks behave. */
export const vclock = {
	now: 1_000,
	advance(ms: number) {
		this.now += ms;
	},
	set(t: number) {
		this.now = t;
	}
};

vi.mock('lib0-v14/time', async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	return { ...original, getUnixTime: () => vclock.now };
});
