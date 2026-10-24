/**
 * The menus' placement: Floating UI places an element by a controller's
 * `anchor` (the caret, the selection, a handle, a button: the package's
 * `ChromeAnchor`, a virtual element read live), fixed in the viewport,
 * `gap` from it, flipping to the other side when there is no room, kept
 * 8px inside the viewport and below what a sticky header hides (the root's
 * `scroll-padding-top`), and following scrolls, resizes and the caret.
 */
import {
	autoUpdate,
	computePosition,
	flip,
	offset,
	shift,
	type OffsetOptions,
	type Placement,
	type VirtualElement
} from '@floating-ui/dom';
import type { Attachment } from 'svelte/attachments';

export type FloatOptions = {
	placement?: Placement;
	/** The distance from the anchor (Floating UI's `offset`). */
	gap?: OffsetOptions;
	/** Where it goes when `placement` has no room (default: the opposite side). */
	fallback?: Placement[];
};

/** `{@attach float(() => controller.anchor, options)}` on the menu's outer element. */
export const float =
	(
		anchor: () => VirtualElement | Element | null | undefined,
		{ placement = 'bottom-start', gap = 8, fallback }: FloatOptions = {}
	): Attachment<HTMLElement> =>
	(node) => {
		const reference = anchor();
		if (!reference) return;
		Object.assign(node.style, { position: 'fixed', left: '0px', top: '0px' });
		const root = node.ownerDocument.documentElement;
		const header = parseFloat(getComputedStyle(root).scrollPaddingTop) || 0;
		const padding = { top: 8 + header, right: 8, bottom: 8, left: 8 };
		const update = () =>
			computePosition(reference, node, {
				strategy: 'fixed',
				placement,
				middleware: [
					offset(gap),
					flip({ fallbackPlacements: fallback, padding }),
					shift({ padding, crossAxis: true })
				]
			}).then(({ x, y }) => Object.assign(node.style, { left: `${x}px`, top: `${y}px` }));
		// Every frame: a caret's or a selection's box moves with the typing.
		return autoUpdate(reference, node, update, { animationFrame: true });
	};
