import {
	createEdytorClipboardFragment,
	writeEdytorClipboardData
} from '$lib/clipboard/clipboard.js';
import type { Edytor } from '../edytor.svelte.js';
import { prevent } from '$lib/utils.js';
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

	if (
		this.dispatcher.intercept(
			(plugin) => plugin.onCopy?.({ prevent, e }),
			() => e.preventDefault()
		)
	)
		return;

	const fragment = createEdytorClipboardFragment(this);
	if (!fragment) {
		return;
	}

	e.preventDefault();
	writeEdytorClipboardData(e.clipboardData, fragment);
}
