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

/**
 * A menu's position below `rect` (above it when there is no room), kept in
 * the viewport: measured now, written by the returned function (the
 * overlay's read-then-write pass).
 */
export const placeBelow = (
	host: HTMLElement,
	rect: DOMRect,
	fallback: { width: number; height: number }
): (() => void) | void => {
	const view = host.ownerDocument.defaultView;
	if (!view) return;
	const box = host.firstElementChild?.getBoundingClientRect();
	const width = box?.width || fallback.width;
	const height = box?.height || fallback.height;
	const left = `${Math.max(8, Math.min(rect.left, view.innerWidth - width - 8))}px`;
	const top = `${Math.max(8, rect.bottom + height + 8 < view.innerHeight ? rect.bottom + 8 : rect.top - height - 8)}px`;
	return () => Object.assign(host.style, { left, top });
};
