import { autoScrollApi } from '$lib/dnd/pragmatic.js';

/**
 * Auto-scroll for one block drag (Atlassian's auto-scroll package): the window
 * and every scrolling element from the editor up (the editor included) scroll
 * as the pointer nears their edges, faster the closer and the longer it stays,
 * innermost first. `ours` keeps it to this editor's drags. Registered at the
 * drag's start (the package allows it mid-drag); the answer releases it.
 */
export const autoScrollFor = (
	root: HTMLElement,
	ours: (data: Record<string | symbol, unknown>) => boolean
): (() => void) => {
	// The scroller hit-tests with `elementsFromPoint` every frame (jsdom has none),
	// so it is created only where that exists.
	if (typeof root.ownerDocument.elementsFromPoint !== 'function') return () => {};
	const { autoScroll, autoScrollWindow } = autoScrollApi();
	const canScroll = ({ source }: { source: { data: Record<string | symbol, unknown> } }) =>
		ours(source.data);
	const releases = [autoScrollWindow({ canScroll })];
	const { body, documentElement, defaultView } = root.ownerDocument;
	// The window is the document's scroller: stop below it.
	for (
		let element: Element | null = root;
		element && element !== body && element !== documentElement;
		element = element.parentElement
	) {
		const { overflowX, overflowY } = defaultView!.getComputedStyle(element);
		if (/auto|scroll|overlay/.test(`${overflowX} ${overflowY}`))
			releases.push(autoScroll({ element, canScroll }));
	}
	return () => releases.forEach((release) => release());
};
