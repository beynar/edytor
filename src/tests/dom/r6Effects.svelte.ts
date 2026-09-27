/**
 * arch-v2 R6 fixture (F-O8): an extension `$effect` that dispatches a command
 * when its trigger flips — a write made while Svelte flushes.
 */
export const effectDispatcher = (run: () => void) => {
	const trigger = $state({ on: false });
	const stop = $effect.root(() => {
		$effect(() => {
			if (!trigger.on) return;
			trigger.on = false;
			run();
		});
	});
	return {
		fire: () => {
			trigger.on = true;
		},
		stop
	};
};
