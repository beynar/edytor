import type { Block } from '$lib/block/block.svelte.js';
import type { Snippet } from 'svelte';
import type { EditorCommand, Plugin } from '$lib/plugins.js';
import type { Text } from '$lib/text/text.svelte.js';
import {
	BLOCK_ACTIVATE_EVENT,
	BLOCK_ADD_EVENT,
	type BlockAddition
} from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import { onPress } from '$lib/events/onFocus.js';
import SlashMenu from './SlashMenu.svelte';
import { SlashMenuController, type TextInsertionPayload } from './SlashMenuController.svelte.js';

/** One row, for an `item` snippet. */
export type SlashMenuItem = {
	command: EditorCommand;
	/** The row's element id: set it (`id={item.id}`) so the keyboard's owner names the highlighted row. */
	id: string;
	/** The keyboard's row. */
	selected: boolean;
	/** The built-in line icon as a CSS `mask-image` value, when the command has one. */
	icon: string | undefined;
	/** Run the command (removes the `/query` first). */
	run: () => void;
	/** Make this the keyboard's row (hover). */
	select: () => void;
};

export type SlashMenuOptions = {
	/** Replace the whole menu; it renders while `controller.isOpen`. Keys and placement stay the plugin's. */
	menu?: Snippet<[SlashMenuController]>;
	/** Replace each row of the default menu. */
	item?: Snippet<[SlashMenuItem]>;
};

/** The slash menu, with your own markup through `menu` or `item` snippets. */
export const createSlashMenuPlugin =
	(options: SlashMenuOptions = {}): Plugin =>
	(edytor) => {
		const controller = new SlashMenuController(edytor);

		/**
		 * Beside the caret (below a `+` it was opened from), kept in the
		 * viewport; measured in the overlay's frame, written after (R11), as
		 * is the close of a `+` menu whose block is gone.
		 */
		const positionMenu = (host: HTMLElement) => {
			const editor = edytor.node;
			if (!editor || !controller.isOpen) return;
			const view = editor.ownerDocument.defaultView;
			if (!view) return;
			const selection = editor.ownerDocument.getSelection();
			const { addition } = controller;
			// Its block is gone (a peer's or a command's delete): the `+` menu closes, as the block menu does.
			if (addition && !addition.block.isInTree) return () => controller.dismiss();
			const anchor = addition?.anchor?.isConnected ? addition.anchor : addition?.block.node;
			let rect = anchor?.getBoundingClientRect();
			if (!rect && selection?.rangeCount && editor.contains(selection.anchorNode)) {
				const range = selection.getRangeAt(0).cloneRange();
				range.collapse(false);
				if (typeof range.getBoundingClientRect === 'function') {
					rect = range.getBoundingClientRect();
				}
			}
			if (!rect || (!rect.width && !rect.height)) {
				rect = edytor.selection.state.startText?.node?.getBoundingClientRect();
			}
			if (!rect) rect = editor.getBoundingClientRect();
			const width = host.firstElementChild?.getBoundingClientRect().width || 310;
			const height = host.firstElementChild?.getBoundingClientRect().height || 350;
			const left = `${Math.max(8, Math.min(rect.left, view.innerWidth - width - 8))}px`;
			const top = `${Math.max(8, rect.bottom + height + 8 < view.innerHeight ? rect.bottom + 8 : rect.top - height - 8)}px`;
			return () => Object.assign(host.style, { left, top });
		};

		return {
			hotkeys: {
				arrowdown: ({ prevent }) => {
					if (controller.moveSelection(1)) prevent();
				},
				arrowup: ({ prevent }) => {
					if (controller.moveSelection(-1)) prevent();
				},
				enter: ({ prevent }) => {
					if (controller.isOpen && controller.commands.length)
						prevent(() => void controller.runSelected());
				},
				escape: ({ prevent }) => {
					if (controller.isOpen) prevent(() => controller.dismiss());
				}
			},
			onAfterOperation: (change) => {
				if (change.operation !== 'insertText' || !('text' in change)) return;
				controller.handleTextInsertion(
					change.text as Text,
					change.block as Block,
					change.payload as TextInsertionPayload
				);
				edytor.overlay.invalidate();
			},
			onSelectionChange: () => {
				controller.reconcileSelection();
				edytor.overlay.invalidate();
			},
			onEdytorAttached: ({ node }) => {
				// A `+` offers its block: nothing is added until a row is picked.
				const offer = (event: Event) => {
					event.preventDefault();
					controller.offer((event as CustomEvent<BlockAddition>).detail);
					edytor.overlay.invalidate();
				};
				const outside = (event: MouseEvent) => {
					const target = event.target as Element | null;
					// The selection as it was; a press in the editor then places its caret.
					if (controller.addition && !target?.closest?.('[data-edytor-slash-menu-host]'))
						controller.dismiss(false);
				};
				// A grip's menu takes over (one menu at a time).
				const activate = () => {
					if (controller.addition) controller.close();
				};
				node.addEventListener(BLOCK_ADD_EVENT, offer);
				node.addEventListener(BLOCK_ACTIVATE_EVENT, activate);
				// Every press, WebKit's lone `mousedown` after a drag too (`onPress`).
				const offPress = onPress(edytor, node.ownerDocument, outside, true);
				const unmount = edytor.overlay.mount(
					SlashMenu,
					{ controller, menu: options.menu, item: options.item },
					'edytor-slash-menu-host',
					50,
					positionMenu
				);
				return () => {
					node.removeEventListener(BLOCK_ADD_EVENT, offer);
					node.removeEventListener(BLOCK_ACTIVATE_EVENT, activate);
					offPress();
					unmount();
				};
			}
		};
	};

/** The Notion-style slash menu. */
export const slashMenuPlugin = createSlashMenuPlugin();
