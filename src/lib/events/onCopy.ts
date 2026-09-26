import {
	createEdytorClipboardFragment,
	writeEdytorClipboardData
} from '$lib/clipboard/clipboard.js';
import type { Edytor } from '../edytor.svelte.js';
import { prevent, PreventionError } from '$lib/utils.js';
import { observeInternalDragSources } from './onDrop.js';
import { observeShiftPasteModifier } from './onPaste.js';
import { isNestedForeignEditableTarget } from './nativeInteractiveControl.js';

export function onCopy(this: Edytor, e: ClipboardEvent) {
	if (this.selection.state.isVoidEditableElement) {
		return;
	}

	// A copy inside a nested `contenteditable` island belongs to the
	// island — overriding it would clobber the clipboard with the stale
	// model selection's fragment.
	if (isNestedForeignEditableTarget(this.node, e.target)) {
		return;
	}

	observeInternalDragSources(this.node?.getRootNode());
	observeShiftPasteModifier(this.node?.getRootNode());

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
