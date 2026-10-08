import { flushSync } from 'svelte';

/**
 * A reactive reader: `read` runs in an `$effect` (as a template or a
 * `$derived` would read it), and each run's value is recorded in `seen`.
 * `stop` ends the effect.
 */
export const watch = <T>(read: () => T) => {
	const seen: T[] = [];
	const stop = $effect.root(() => {
		$effect(() => {
			seen.push(read());
		});
	});
	flushSync();
	return { seen, stop };
};
