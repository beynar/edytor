import type { Plugin } from '$lib/plugins.js';
import {
	BLOCK_ACTIVATE_EVENT,
	type BlockActivation
} from '../blockHandles/BlockHandleController.svelte.js';
import BlockMenu from './BlockMenu.svelte';
import { BlockMenuController, type BlockMenuOptions } from './BlockMenuController.svelte.js';

/**
 * Notion's block menu: a handle click (without an `onActivate` of your own)
 * opens it beside the handle — search, Turn into, Duplicate, Move, Delete,
 * and Copy link when `linkTo` is given. Also binds Mod+D (duplicate the
 * caret's block).
 */
export const createBlockMenuPlugin =
	(options: BlockMenuOptions = {}): Plugin =>
	(edytor) => {
		const controller = new BlockMenuController(edytor, options);

		/**
		 * Beside the handle: 8px right of it, top-aligned; left of it when the
		 * right has no room; flipped up when the space below is short. It
		 * follows scrolls and resizes, and closes when the handle leaves the view.
		 */
		const place = (host: HTMLElement) => {
			const anchor = controller.anchor;
			if (!controller.isOpen) return;
			if (!anchor?.isConnected) return controller.close(false);
			const view = host.ownerDocument.defaultView;
			const menu =
				host.querySelector<HTMLElement>('[data-edytor-block-menu]') ??
				(host.firstElementChild as HTMLElement | null);
			if (!view || !menu) return;
			const [gap, edge] = [8, 8];
			const rect = anchor.getBoundingClientRect();
			if (rect.bottom < 0 || rect.top > view.innerHeight) return controller.close(false);
			const { width, height } = menu.getBoundingClientRect();
			const right = rect.right + gap;
			const left = rect.left - gap - width;
			const x =
				right + width <= view.innerWidth - edge
					? right
					: left >= edge
						? left
						: Math.max(edge, Math.min(right, view.innerWidth - edge - width));
			const y =
				rect.top + height <= view.innerHeight - edge
					? rect.top
					: Math.max(edge, Math.min(rect.bottom, view.innerHeight - edge) - height);
			host.style.left = `${x}px`;
			host.style.top = `${y}px`;
		};

		return {
			hotkeys: {
				'mod+d': ({ prevent }) => {
					const block =
						edytor.selection.selectedBlocks.values().next().value ??
						edytor.selection.state.startBlock;
					if (block?.movable && !edytor.readonly) prevent(() => controller.duplicate(block));
				}
			},
			onEdytorAttached: ({ node }) => {
				const activate = (event: Event) => {
					const { block, anchor } = (event as CustomEvent<BlockActivation>).detail;
					controller.open(block, anchor);
					edytor.overlay.invalidate();
				};
				const outside = (event: PointerEvent) => {
					const target = event.target as Element | null;
					if (
						controller.isOpen &&
						!target?.closest?.('[data-edytor-block-menu-host], [data-edytor-block-handle-host]')
					)
						controller.close(false);
				};
				node.addEventListener(BLOCK_ACTIVATE_EVENT, activate);
				node.ownerDocument.addEventListener('pointerdown', outside, true);
				const unmount = edytor.overlay.mount(
					BlockMenu,
					{ controller, menu: options.menu },
					'edytor-block-menu-host',
					70,
					place
				);
				return () => {
					node.removeEventListener(BLOCK_ACTIVATE_EVENT, activate);
					node.ownerDocument.removeEventListener('pointerdown', outside, true);
					unmount();
				};
			}
		};
	};

/** The block menu without a block link. */
export const blockMenuPlugin = createBlockMenuPlugin();
