/** One adapter's auto-scroll (Atlassian's auto-scroll package), its drags already chosen. */
export type Scrollers = {
	/** The window scrolls as the pointer nears its edges. */
	window(): () => void;
	/** `element` scrolls as the pointer nears its edges. */
	element(element: Element): () => void;
};

/**
 * Auto-scroll for one drag (a block's, a table row's or column's, files
 * dragged from outside): the window and every scrolling element from the
 * editor up (the editor included) scroll as the pointer nears their edges,
 * faster the closer and the longer it stays, innermost first. `scrollers`
 * is the drag's adapter's (`elementScrollers`, `externalScrollers`), kept to
 * this editor's drags. Registered at the drag's start (the package allows it
 * mid-drag); the answer releases it.
 */
export const autoScrollFor = (root: HTMLElement, scrollers: Scrollers): (() => void) => {
	const releases = [scrollers.window()];
	const { body, documentElement, defaultView } = root.ownerDocument;
	// The window is the document's scroller: stop below it.
	for (
		let element: Element | null = root;
		element && element !== body && element !== documentElement;
		element = element.parentElement
	) {
		const { overflowX, overflowY } = defaultView!.getComputedStyle(element);
		if (/auto|scroll|overlay/.test(`${overflowX} ${overflowY}`))
			releases.push(scrollers.element(element));
	}
	return () => releases.forEach((release) => release());
};
