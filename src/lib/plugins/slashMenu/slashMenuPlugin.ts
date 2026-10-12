import type { Snippet } from 'svelte';
import type { InitializedPlugin, Plugin } from '$lib/plugins.js';
import { caretRect } from '../triggers/place.js';
import { placeNear } from '$lib/surface/overlay.js';
import { SlashMenuController } from './SlashMenuController.svelte.js';
import { handleMenuEvents, mountChrome } from '../chrome.js';
import { withTriggerMenus } from '../triggers/triggers.js';

export type SlashMenuOptions = {
	/**
	 * The menu's markup and its words; it renders while `controller.isOpen`
	 * (without it, nothing shows). Keys and placement stay the plugin's. Keep
	 * its ARIA with `{@attach controller.popup}` on the list (name it) and
	 * `{...controller.option(index)}` on each row; in a `+`'s menu (while
	 * `controller.addition`), `{@attach controller.keys}` on the element that
	 * holds the keyboard (your field, or the menu itself: typing then edits
	 * the query).
	 */
	menu?: Snippet<[SlashMenuController]>;
};

/** The slash menu, drawn by your `menu` snippet. */
export const createSlashMenuPlugin =
	(options: SlashMenuOptions = {}): Plugin =>
	(edytor) => {
		const controller = new SlashMenuController(edytor);

		/**
		 * Beside the caret (below a `+` it was opened from), kept in the
		 * viewport; measured in the overlay's frame, written after, as
		 * is the close of a `+` menu whose block is gone.
		 */
		const positionMenu = (host: HTMLElement) => {
			if (!edytor.node || !controller.isOpen) return;
			const { addition } = controller;
			// Its block is gone (a peer's or a command's delete): the `+` menu closes, as the block menu does.
			if (addition && !addition.block.isInTree) return () => controller.dismiss();
			const anchor = addition?.anchor?.isConnected ? addition.anchor : addition?.block.node;
			const box = anchor?.getBoundingClientRect();
			const rect = box && (box.width || box.height) ? box : caretRect(edytor);
			return rect && placeNear(host, rect, [310, 350]);
		};

		const plugin: InitializedPlugin = {
			onEdytorAttached: ({ node }) =>
				handleMenuEvents(
					edytor,
					node,
					// A grip's menu takes over (one menu at a time).
					() => {
						if (controller.addition) controller.close();
					},
					// A `+` offers its block: nothing is added until a row is picked.
					(event) => {
						event.preventDefault();
						controller.offer(event.detail);
						edytor.overlay.invalidate();
					},
					'[data-edytor-slash-menu-host]',
					// The selection as it was; a press in the editor then places its caret.
					() => controller.addition && controller.dismiss(false)
				)
		};
		// The `/` trigger, wired as a plugin's triggers are.
		return withTriggerMenus(
			edytor,
			plugin,
			[controller],
			() => ({
				move: controller.move,
				pick: controller.commands.length ? () => void controller.runSelected() : undefined,
				close: () => controller.dismiss()
			}),
			() =>
				mountChrome(
					edytor,
					options.menu,
					controller,
					() => controller.isOpen,
					{ name: 'edytor-slash-menu-host', zIndex: 50, measure: positionMenu },
					() => controller.dismiss(false)
				)
		);
	};
