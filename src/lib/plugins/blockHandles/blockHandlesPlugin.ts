import type { Snippet } from 'svelte';
import { mount, unmount } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { Plugin } from '$lib/plugins.js';
import type { Block } from '$lib/block/block.svelte.js';
import BlockHandles from './BlockHandles.svelte';
import { BlockHandleController } from './BlockHandleController.svelte.js';
import { hidden } from '$lib/selection/visibility.js';
import { isDropTarget } from '$lib/dnd/placement.js';
import type { Attachment } from 'svelte/attachments';
import { all, listen } from '$lib/utils/listen.js';

/** What a `handle` snippet receives. */
export type BlockHandleSnippetPayload = {
	block: Block;
	/** The block's kind as people read it ("Heading 1", its preset's label): name your controls with it. */
	label: string;
	/**
	 * The grip's attachment (`{@attach handle.grip}`): the drag source, a
	 * click that opens the block's menu, the Alt+arrow moves
	 * (`aria-keyshortcuts`), and the ARIA of the menu it opened
	 * (`aria-expanded`, `aria-controls`, `aria-haspopup`).
	 */
	grip: Attachment<HTMLElement>;
	/**
	 * The `+`'s attachment (`{@attach handle.plus}`): a click calls `add`
	 * (Alt+click with `true`) with the `+` as the anchor, a press keeps the
	 * editor's focus, and the ARIA of the menu it opened.
	 */
	plus: Attachment<HTMLElement>;
	/**
	 * The `+`: the slash menu offers what to add below; with `true` (Alt+click)
	 * above, or, for a block directly in a layout's column, in a new column
	 * right of its column. Nothing is added until a row is picked. The menu
	 * opens under `anchor` (your `+`: `event.currentTarget`), else under the
	 * block.
	 */
	add: (alt?: boolean, anchor?: HTMLElement | null) => void;
	/**
	 * Alt+click on the `+` adds a column right of the block's (a block
	 * directly in a layout's column): name your `+` with it.
	 */
	beside: boolean;
	readonly: boolean;
	draggable: boolean;
};

export type BlockHandlesOptions = {
	/** Keep the handle and its keyboard actions, but omit pointer dragging and drop targets. */
	draggable?: boolean;
	/**
	 * The `+` and ⋮⋮ beside each block, and their words (without it, no
	 * handle shows and no block drags); placement and hover are the plugin's.
	 */
	handle?: Snippet<[BlockHandleSnippetPayload]>;
};

/**
 * Block handles in the overlay, created lazily: a handle mounts
 * for a block near the viewport (the overlay's `near` top-level blocks and
 * the blocks inside them, not hidden; every block without layout),
 * under the pointer, selected, focused or dragged; drop targets exist only
 * during our own drag. Hover is one delegated listener on the editor and
 * one on the overlay (a block's handle keeps it hovered).
 */
export const createBlockHandlesPlugin =
	(options: BlockHandlesOptions = {}): Plugin =>
	(edytor) => {
		const controller = new BlockHandleController(edytor, {
			draggable: options.draggable !== false
		});
		const blocks = new SvelteMap<string, Block>();
		const near = new SvelteSet<string>();
		const hovered = new SvelteSet<string>();
		/** Layout is computed (a browser): the near band is measured, else every block is near. */
		const measured = typeof IntersectionObserver !== 'undefined';
		/** The blocks the band gained, mounted after the frame's paint (`afterPaint`). */
		let gained: Set<string> | null = null;
		let afterPaint: ReturnType<typeof setTimeout> | undefined;
		/**
		 * Browser rule `handles.after-paint` (one named timer): a handle the band
		 * gains mounts in a task queued from the overlay's frame, so after that
		 * frame's paint: a key that adds a block (Enter, a paste) paints its text
		 * first, the new blocks' handles a frame later. A handle the band loses
		 * goes at once; hovered, selected and focused handles do not wait.
		 */
		const mountGained = () => {
			afterPaint = undefined;
			const ids = gained;
			gained = null;
			if (ids) for (const id of ids) if (blocks.has(id) && !near.has(id)) near.add(id);
		};
		/** The near band, measured on the overlay's frames (a scroll, a resize, a commit). */
		const measureNear = () => {
			const next = new Set<string>();
			const visit = (block: Block) => {
				if (blocks.has(block.id) && !hidden(block)) next.add(block.id);
				for (const child of block.children) visit(child);
			};
			for (const node of edytor.overlay.near) {
				const block = edytor.idToBlock.get((node as HTMLElement).dataset.edytorId ?? '');
				if (block?.node === node) visit(block);
			}
			return () => {
				for (const id of near) if (!next.has(id)) near.delete(id);
				const add = [...next].filter((id) => !near.has(id));
				gained = add.length ? new Set(add) : null;
				if (gained) afterPaint ??= setTimeout(mountGained);
			};
		};
		/**
		 * The blocks under the pointer that have a handle: the hovered block and
		 * its handled ancestors (a layout and its columns have none). Over a
		 * block's handle (in the overlay), that block: a block stays hovered
		 * while the pointer goes from its text to its handle and stays there.
		 */
		const hover = (event: PointerEvent) => {
			const target = event.target as Element | null;
			const handle = target?.closest?.<HTMLElement>('[data-edytor-block-handle-host]');
			const start = handle
				? blocks.get(handle.dataset.blockId ?? '')?.node
				: target?.closest?.('[data-edytor-block="true"]');
			const next = new Set<string>();
			for (
				let node = start;
				node;
				node = node.parentElement?.closest('[data-edytor-block="true"]')
			) {
				const id = (node as HTMLElement).dataset.edytorId ?? '';
				if (blocks.get(id)?.node === node) next.add(id);
			}
			for (const id of hovered) if (!next.has(id)) hovered.delete(id);
			for (const id of next) hovered.add(id);
		};
		/** In the overlay, only a handle names a block; other chrome (a resize strip, a menu) keeps the hover. */
		const hoverOverlay = (event: PointerEvent) => {
			if ((event.target as Element | null)?.closest?.('[data-edytor-block-handle-host]'))
				hover(event);
		};
		/** The pointer left the editor and its overlay (not one for the other): nothing is hovered. */
		const unhover = (event: PointerEvent) => {
			const to = event.relatedTarget as Node | null;
			if (to && (edytor.node?.contains(to) || edytor.overlay.layer?.contains(to))) return;
			hovered.clear();
		};

		return {
			onEdytorAttached: ({ node }) => {
				const layer = edytor.overlay.layer!;
				const offPointer = all(
					listen(node, 'pointerover', hover),
					listen(node, 'pointerleave', unhover),
					listen(layer, 'pointerover', hoverOverlay),
					listen(layer, 'pointerleave', unhover)
				);
				const offNear = measured ? edytor.overlay.add(measureNear) : undefined;
				const { handle } = options;
				const component =
					handle &&
					mount(BlockHandles, {
						target: layer,
						props: { edytor, controller, blocks, near, hovered, handle }
					});
				return () => {
					offPointer();
					offNear?.();
					clearTimeout(afterPaint);
					afterPaint = undefined;
					gained = null;
					if (component) void unmount(component);
				};
			},
			onBlockAttached: ({ node, block }) => {
				// A table's rows move by its own row menus, its cells never (`table.fits`).
				if (!isDropTarget(edytor, block)) return;
				const offDropTarget = controller.addDropTarget(node, block);
				// A layout and its columns are drop targets but have no handle (as
				// Notion): a block selection covering a layout stands for it.
				const { facade } = edytor;
				if (facade.isLayout(block.id) || facade.isLayoutItem(block.id)) return offDropTarget;
				blocks.set(block.id, block);
				if (measured) edytor.overlay.invalidate();
				else near.add(block.id);
				return () => {
					offDropTarget();
					if (block.node === node || block.node === undefined) {
						blocks.delete(block.id);
						near.delete(block.id);
						hovered.delete(block.id);
					}
				};
			}
		};
	};
