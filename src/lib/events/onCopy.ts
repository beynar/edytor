import {
	createEdytorClipboardFragment,
	writeEdytorClipboardData
} from '$lib/clipboard/clipboard.js';
import type { Edytor } from '../edytor.svelte.js';
import { prevent, PreventionError } from '$lib/utils.js';

export function onCopy(this: Edytor, e: ClipboardEvent) {
	if (this.selection.state.isVoidEditableElement) {
		return;
	}

	try {
		for (const plugin of this.plugins) {
			plugin.onCopy?.({ prevent, e });
		}
	} catch (error) {
		if (error instanceof PreventionError) {
			e.preventDefault();
			return error.cb?.();
		}
		throw error;
	}

	const fragment = createEdytorClipboardFragment(this);
	if (!fragment) {
		return;
	}

	e.preventDefault();
	writeEdytorClipboardData(e.clipboardData, fragment);
}
