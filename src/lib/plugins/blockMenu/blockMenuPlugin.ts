import type { Plugin } from '$lib/plugins.js';
import { handleMenuEvents, mountChrome } from '../chrome.js';
import { getSelectedBlocksInDocumentOrder } from '$lib/selection/replaceSelection.js';
import {
	BlockMenuController,
	colorCommands,
	type BlockMenuOptions
} from './BlockMenuController.svelte.js';

/**
 * Notion's block menu: a handle click
 * opens it beside the handle — search, Turn into, Color, Duplicate, Move,
 * Delete, and Copy link when `linkTo` is given. Also binds Mod+D (duplicate
 * the selected blocks, or the caret's block), and adds the colours to the
 * slash menu by name (`/red`: "Red text", "Red background").
 */
export const createBlockMenuPlugin =
	(options: BlockMenuOptions = {}): Plugin =>
	(edytor) => {
		const controller = new BlockMenuController(edytor, options);

		/**
		 * Beside the handle: 8px right of it, top-aligned; left of it when the
		 * right has no room; flipped up when the space below is short. The Turn
		 * into flyout opens right of the menu, or left of it when the right has
		 * no room, top-aligned with it, moved up as far as the viewport needs
		 * (never above its top edge), and scrolls inside when taller (Notion):
		 * every row is in the viewport, reachable by the mouse. It follows
		 * scrolls and resizes, and closes when the handle leaves the view.
		 * Measured in the overlay's frame; the placement (or the close) is written after.
		 */
		const close = () => controller.close(false);
		const place = (host: HTMLElement) => {
			const anchor = controller.anchor;
			if (!controller.isOpen) return;
			if (!anchor?.isConnected) return close;
			const view = host.ownerDocument.defaultView;
			const menu =
				host.querySelector<HTMLElement>('[data-edytor-block-menu]') ??
				(host.firstElementChild as HTMLElement | null);
			if (!view || !menu) return;
			const [gap, edge, between] = [8, 8, 4];
			const rect = anchor.getBoundingClientRect();
			if (rect.bottom < 0 || rect.top > view.innerHeight) return close;
			// Layout sizes, not the box: the menus open with a scale (0.98 → 1), and a
			// box read mid-animation would place them up to 2% short of their size.
			const [width, height] = [menu.offsetWidth, menu.offsetHeight];
			const right = rect.right + gap;
			const left = rect.left - gap - width;
			let x =
				right + width <= view.innerWidth - edge
					? right
					: left >= edge
						? left
						: Math.max(edge, Math.min(right, view.innerWidth - edge - width));
			const y =
				rect.top + height <= view.innerHeight - edge
					? rect.top
					: Math.max(edge, Math.min(rect.bottom, view.innerHeight - edge) - height);
			const flyout = host.querySelector<HTMLElement>('[data-edytor-block-menu-flyout]');
			const frame = flyout?.parentElement;
			let side = '';
			let shift = '';
			if (flyout && frame) {
				const box = { width: flyout.offsetWidth, height: flyout.offsetHeight };
				// Left of the menu when its right has no room (the menu stays where it is).
				if (
					x + width + between + box.width > view.innerWidth - edge &&
					x - between - box.width >= edge
				) {
					side = 'row-reverse';
					x -= between + box.width;
				}
				const top = Math.max(edge, Math.min(y, view.innerHeight - edge - box.height));
				shift = `${top - y}px`;
			}
			return () => {
				Object.assign(host.style, { left: `${x}px`, top: `${y}px` });
				if (frame) frame.style.flexDirection = side;
				if (flyout) flyout.style.marginTop = shift;
			};
		};

		return {
			// Colours by name in the slash menu (`/red`), as in Notion.
			commands: colorCommands(edytor),
			hotkeys: {
				'mod+d': ({ prevent }) => {
					if (edytor.readonly) return;
					const selected = getSelectedBlocksInDocumentOrder(edytor).filter((b) => b.movable);
					if (selected.length) return prevent(() => controller.duplicate(selected, true));
					const block = edytor.selection.textRange().startText?.parent;
					if (block?.movable) prevent(() => controller.duplicate([block], false));
				}
			},
			onEdytorAttached: ({ node }) => {
				const off = handleMenuEvents(
					edytor,
					node,
					(event) => {
						// The menu takes the keyboard (its search field).
						event.preventDefault();
						controller.open(event.detail.block, event.detail.anchor);
						edytor.overlay.invalidate();
					},
					// A `+` opens its own menu: this one closes.
					close,
					'[data-edytor-block-menu-host], [data-edytor-block-handle-host]',
					() => controller.isOpen && close()
				);
				const unmount = mountChrome(
					edytor,
					options.menu,
					controller,
					() => controller.isOpen,
					{ name: 'edytor-block-menu-host', zIndex: 70, measure: place },
					close
				);
				return () => {
					off();
					unmount();
				};
			}
		};
	};
