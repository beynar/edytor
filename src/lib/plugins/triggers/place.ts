import type { Edytor } from '$lib/edytor.svelte.js';

/**
 * The caret's box: the end of the DOM selection when it is in the editor,
 * else the caret's text element, else the editor's box.
 */
export const caretRect = (edytor: Edytor): DOMRect | undefined => {
	const editor = edytor.node;
	if (!editor) return undefined;
	const selection = editor.ownerDocument.getSelection();
	let rect: DOMRect | undefined;
	if (selection?.rangeCount && editor.contains(selection.anchorNode)) {
		const range = selection.getRangeAt(0).cloneRange();
		range.collapse(false);
		if (typeof range.getBoundingClientRect === 'function') rect = range.getBoundingClientRect();
	}
	if (!rect || (!rect.width && !rect.height)) {
		rect = edytor.selection.state.startText?.node?.getBoundingClientRect();
	}
	return rect ?? editor.getBoundingClientRect();
};
