/**
 * arch-v2 R7 — the truth invariant (plan §8.7 F-O10, R12; §12.5 BI2-9): after
 * a settle, every block's content equals its cell's current text (a nonempty
 * content its kind renders keeps its text elements), every strict container
 * (the root, text elements) holds only what the cells render, and every
 * registered element is connected — except the live composition host, and
 * read-only text divergence until the flip back.
 *
 * Test-side and implementation-free: it reads the host DOM, the view's cells
 * and the declared kind records only, never the observer. Self-contained (no
 * imports, no closures) so the browser lanes can hand it to `page.evaluate`.
 * Returns one line per divergence; empty when the host is the projection of
 * its cells.
 */
export const truthOf = (edytor: any): string[] => {
	const out: string[] = [];
	const root: HTMLElement | undefined = edytor?.node;
	const cells = edytor?.cells;
	if (!root?.isConnected || !cells || edytor.destroyed) return out;
	const ATOM = '\uFFFC';
	const strip = (value: string) => value.replace(/\u200B/g, '');
	const isAnchor = (node: Node) =>
		node.nodeType === Node.COMMENT_NODE || (node.nodeType === Node.TEXT_NODE && !node.nodeValue);
	const live: string | null = edytor.composition?.live
		? (edytor.composition.host?.parent?.id ?? null)
		: null;

	const shown: string[] = [];
	for (const child of Array.from(root.childNodes)) {
		if (isAnchor(child)) continue;
		if (child instanceof Element && child.hasAttribute('data-edytor-render-anchor')) continue;
		// A suggestion's preview is view-only content, not a block (`session/suggestions`).
		if (child instanceof Element && child.hasAttribute('data-edytor-suggestion')) continue;
		if (child instanceof Element && child.getAttribute('data-edytor-block') === 'true') {
			shown.push(child.getAttribute('data-edytor-id') ?? '?');
			continue;
		}
		out.push(`root: a foreign ${child.nodeName} child`);
	}
	if (shown.join() !== cells.rootIds.join())
		out.push(`root: blocks [${shown.join()}] ≠ cells [${cells.rootIds.join()}]`);

	const elements = new Map<string, Element>();
	for (const element of Array.from(root.querySelectorAll('[data-edytor-block="true"]')))
		elements.set(element.getAttribute('data-edytor-id') ?? '', element);

	const walk = (id: string) => {
		const cell = cells.get(id);
		if (!cell) return;
		const element = elements.get(id);
		if (!element) out.push(`${id}: no block element`);
		else if (id !== live && !edytor.readonly) {
			const parts = Array.from(
				element.querySelectorAll('[data-edytor-text="true"], [data-edytor-inline-block]')
			).filter(
				(part) =>
					part.closest('[data-edytor-block="true"]') === element &&
					!part.closest('[data-edytor-text-suggestion], [data-edytor-suggestion]') &&
					!part.parentElement?.closest('[data-edytor-inline-block]')
			);
			const want = strip(
				cell.runs
					.map((run: { kind: string; text?: string }) => (run.kind === 'text' ? run.text : ATOM))
					.join('')
			);
			// A kind that declares no content of its own (`rendersContent: false`: a list,
			// a divider) and a void block show no text element; every other kind renders
			// one text element per segment, so a nonempty cell with no content element in
			// the DOM lost its text hosts (review 2026-09-29).
			const renders =
				edytor.blocks?.get?.(cell.type)?.rendersContent !== false &&
				element.getAttribute('data-edytor-void') !== 'true';
			if (!parts.length && want && renders)
				out.push(`${id}: no text element for cell ${JSON.stringify(want)}`);
			if (parts.length) {
				const text = parts
					.map((part) =>
						part.hasAttribute('data-edytor-inline-block') ? ATOM : strip(part.textContent ?? '')
					)
					.join('');
				if (text !== want)
					out.push(`${id}: DOM ${JSON.stringify(text)} ≠ cell ${JSON.stringify(want)}`);
				for (const part of parts) {
					if (!part.hasAttribute('data-edytor-text')) continue;
					for (const child of Array.from(part.childNodes))
						if (
							child instanceof Element &&
							!child.hasAttribute('data-edytor-mark') &&
							!child.hasAttribute('data-edytor-trailing-newline')
						)
							out.push(`${id}: a foreign ${child.nodeName} in a text element`);
				}
			}
		}
		for (const child of cell.childIds) walk(child);
	};
	for (const id of cells.rootIds) walk(id);
	return out;
};
