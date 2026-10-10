import type { Snippet } from 'svelte';
import type { EditorCommand, InitializedPlugin, Plugin } from '$lib/plugins.js';
import SlashMenu from './SlashMenu.svelte';
import { caretRect } from '../triggers/place.js';
import { placeNear } from '$lib/surface/overlay.js';
import { SlashMenuController } from './SlashMenuController.svelte.js';
import { slashMenuEnglish, labelsWith, type PartialLabels } from '$lib/labels.js';
import { handleMenuEvents, type MenuItemPayload } from '../chrome.js';
import { withTriggerMenus } from '../triggers/triggers.js';

/**
 * One row, for an `item` snippet: the row shape every menu shares (`item`
 * is the command, `label` its label, `run` runs it, removing the `/query`
 * first; set `id`, or spread `option`, so the keyboard's owner names the
 * highlighted row), with the command again and its icon.
 */
export type SlashMenuItem = MenuItemPayload<EditorCommand> & {
	/** The command (the same as `item`). */
	command: EditorCommand;
	/** The built-in line icon as a CSS `mask-image` value, when the command has one. */
	icon: string | undefined;
};

export type SlashMenuOptions = {
	/**
	 * Replace the whole menu; it renders while `controller.isOpen`. Keys and
	 * placement stay the plugin's. Keep its ARIA with `{@attach
	 * controller.popup}` on the list and `{...controller.option(index)}` on
	 * each row; in a `+`'s menu, `{@attach controller.keys}` on your field.
	 */
	menu?: Snippet<[SlashMenuController]>;
	/** Replace each row of the default menu. */
	item?: Snippet<[SlashMenuItem]>;
	/** The words the menu shows (its field, headings, empty state), over the English ones. */
	labels?: PartialLabels<'slashMenu'>;
};

/** The slash menu, with your own markup through `menu` or `item` snippets. */
export const createSlashMenuPlugin =
	(options: SlashMenuOptions = {}): Plugin =>
	(edytor) => {
		const controller = new SlashMenuController(
			edytor,
			labelsWith(slashMenuEnglish, options.labels)
		);

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
				move: (step) => controller.moveSelection(step),
				pick: controller.commands.length ? () => void controller.runSelected() : undefined,
				close: () => controller.dismiss()
			}),
			() =>
				edytor.overlay.mount(
					SlashMenu,
					{ controller, menu: options.menu, item: options.item },
					'edytor-slash-menu-host',
					50,
					positionMenu
				)
		);
	};

/** The Notion-style slash menu. */
export const slashMenuPlugin = createSlashMenuPlugin();
