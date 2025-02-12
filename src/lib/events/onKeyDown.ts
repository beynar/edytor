/* eslint-disable @typescript-eslint/no-explicit-any */
import { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { prevent, PreventionError } from '$lib/utils.js';

export function onKeyDown(this: Edytor, e: KeyboardEvent) {
	if (this.readonly) return;

	try {
		this.hotKeys.isHotkey(e);
	} catch (error) {
		if (error instanceof PreventionError) {
			error.cb?.();
		} else {
			throw error;
		}
	}
}
