/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Edytor } from '$lib/edytor.svelte.js';
import { prevent } from '$lib/utils.js';
export function onKeyDown(this: Edytor, e: KeyboardEvent) {
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
}
