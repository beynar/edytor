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
		 * The menu places itself by `controller.anchor` (the handle), its
		 * flyout by the menu; measured in the overlay's frame, the menu closes
		 * when the handle leaves the page or the view.
		 */
		const close = () => controller.close(false);
		const place = (host: HTMLElement) => {
			const anchor = controller.anchor;
			if (!controller.isOpen) return;
			if (!anchor?.isConnected) return close;
			const rect = anchor.getBoundingClientRect();
			const height = host.ownerDocument.defaultView?.innerHeight ?? Infinity;
			if (rect.bottom < 0 || rect.top > height) return close;
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
