/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Edytor } from '$lib/edytor.svelte.js';
import { prevent, PreventionError } from '$lib/utils.js';
export function onKeyDown(this: Edytor, e: KeyboardEvent) {
	try {
		if (this.readonly) return;

		if (e.key === 'Tab') {
			this.edytor.plugins.forEach((plugin) => {
				plugin.onTab?.({ prevent, e });
			});
			e.preventDefault();
			e.stopPropagation();
			this.selection.state.startText?.parent.nestBlock();
		}

		if (this.hotKeys.isHotkey(e)) {
			return;
		}
	} catch (error) {
		if (error instanceof PreventionError) {
			error.cb?.();
		} else {
			throw error;
		}
	}
}
