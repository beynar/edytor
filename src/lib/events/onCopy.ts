import {
	createEdytorClipboardFragment,
	writeEdytorClipboardData
} from '$lib/clipboard/clipboard.js';
import type { Edytor } from '../edytor.svelte.js';
import { prevent } from '$lib/utils.js';
import { observeInternalDragSources } from './onDrop.js';
import { observeShiftPasteModifier } from './onPaste.js';
import { ownsEvent } from './nativeInteractiveControl.js';

/**
 * Copy (and the first half of cut): the guards, the extensions' `hook`, then
 * the selection's fragment written to the clipboard. Answers whether it wrote.
 */
export const copySelection = (edytor: Edytor, e: ClipboardEvent, hook: 'onCopy' | 'onCut') => {
	// A copy or cut in a kind's own control (a bound field, a nested
	// editable island) is the control's: overriding it would put the model
	// selection's fragment on the clipboard, and a cut would delete it (`ownsEvent`).
	if (edytor.selection.state.isVoidEditableElement || ownsEvent(edytor.node, e)) return false;

	observeInternalDragSources(edytor.node?.getRootNode());
	observeShiftPasteModifier(edytor.node?.getRootNode());

	const claimed = (plugin: Edytor['plugins'][number]) => plugin[hook]?.({ prevent, e });
	if (edytor.dispatcher.intercept(claimed, () => e.preventDefault())) return false;

	const fragment = createEdytorClipboardFragment(edytor);
	if (!fragment) return false;
	e.preventDefault();
	writeEdytorClipboardData(e.clipboardData, fragment, edytor);
	return true;
};

export function onCopy(this: Edytor, e: ClipboardEvent) {
	copySelection(this, e, 'onCopy');
}
