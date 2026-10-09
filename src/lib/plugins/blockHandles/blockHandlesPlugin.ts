import type { Snippet } from 'svelte';
import { mount, unmount } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import type { Plugin } from '$lib/plugins.js';
import type { Block } from '$lib/block/block.svelte.js';
import BlockHandles from './BlockHandles.svelte';
import { BlockHandleController } from './BlockHandleController.svelte.js';
import { labelsWith, type BlockHandlesLabels, type PartialLabels } from '$lib/labels.js';
import { hidden } from '$lib/selection/visibility.js';

export type BlockHandleActivation = { block: Block; anchor: HTMLElement };

/** What a `handle` snippet receives. */
export type BlockHandleSnippetPayload = {
	block: Block;
	/** The block's kind as people read it ("Heading 1", its preset's label): name your controls with it. */
	label: string;
	/** An action: `use:grip` makes an element the drag grip, menu button and Alt+arrow target. */
	grip: (node: HTMLElement) => { destroy(): void };
	/**
	 * The `+`: the slash menu offers what to add below; with `true` (Alt+click)
	 * above, or, for a block directly in a layout's column, in a new column
	 * right of its column. Nothing is added until a row is picked. The menu
	 * opens under `anchor` (your `+`: `event.currentTarget`), else under the
	 * block.
	 */
	add: (alt?: boolean, anchor?: HTMLElement | null) => void;
	/** Whether the block takes a `+`: always `true` (a block in a column too, as Notion). */
	addable: boolean;
	readonly: boolean;
	draggable: boolean;
	/**
	 * Whether the menu the `+` (`add`) or the grip (`grip`) opened is open
	 * (reactive): their `aria-expanded`.
	 */
	expanded: { add: boolean; grip: boolean };
	/**
	 * The id of the menu the `+` or the grip opened, while it is open: their
	 * `aria-controls`.
	 */
	controls: { add: string | undefined; grip: string | undefined };
	/** The handles' words (`add(label)`, `grip(label)`, their hints). */
	labels: BlockHandlesLabels;
};

export type BlockHandlesOptions = {
	/** Keep the handle and its keyboard actions, but omit pointer dragging and drop targets. */
	draggable?: boolean;
	onActivate?: (activation: BlockHandleActivation) => void;
	/** Replace the `+` and ⋮⋮ beside each block; placement and hover stay the plugin's. */
	handle?: Snippet<[BlockHandleSnippetPayload]>;
	/** The handles' accessible names and tooltips, over the English ones. */
	labels?: PartialLabels<'blockHandles'>;
};

const handlePlugins = new WeakSet<Plugin>();

/** Recognize both the default and configured handle plugins during component composition. */
export const isBlockHandlesPlugin = (plugin: Plugin) => handlePlugins.has(plugin);

/**
 * Where a handle mounts: a block within one screen of the viewport, above or
 * below. Without layout (no `IntersectionObserver`: a DOM without a
 * renderer), every block is near.
 */
const NEAR_SCREENS = 1;

/**
 * The top-level blocks near the viewport, by a binary search over their
 * boxes (document order is vertical order at the top level): reads
 * O(log n) boxes a frame, where an observer of every block computed them all
 * after each layout change.
 */
const nearTop = (
	blocks: readonly string[],
	handle: (id: string) => Block,
	screen: number
): readonly Block[] => {
	const top = -NEAR_SCREENS * screen;
	const bottom = (1 + NEAR_SCREENS) * screen;
	// Ids, a handle only for each box read: no handle for every top-level block.
	const box = (id: string) => handle(id).node?.getBoundingClientRect();
	let lo = 0;
	let hi = blocks.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const at = box(blocks[mid]!);
		if (!at || at.bottom < top) lo = mid + 1;
		else hi = mid;
	}
	const first = lo;
	hi = blocks.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const at = box(blocks[mid]!);
		if (!at || at.top <= bottom) lo = mid + 1;
		else hi = mid;
	}
	return blocks.slice(first, lo).map(handle);
};

/**
 * Block handles in the overlay, created lazily: a handle mounts
 * for a block near the viewport (`nearTop` and the blocks inside them, not
 * hidden; every block without layout),
 * under the pointer, selected, focused or dragged; drop targets exist only
 * during our own drag. Hover is one delegated listener on the editor and
 * one on the overlay (a block's handle keeps it hovered).
 */
export const createBlockHandlesPlugin = (options: BlockHandlesOptions = {}): Plugin => {
	const plugin: Plugin = (edytor) => {
		const controller = new BlockHandleController(edytor, {
			draggable: options.draggable !== false,
			onActivate: options.onActivate,
			labels: labelsWith('blockHandles', options.labels)
		});
		const blocks = new SvelteMap<string, Block>();
		const near = new SvelteSet<string>();
		const hovered = new SvelteSet<string>();
		const ids = new WeakMap<Element, string>();
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
			const view = edytor.node?.ownerDocument.defaultView;
			if (!view || !edytor.root) return;
			const tops = edytor.facade.childrenIds(null);
			const next = new Set<string>();
			const visit = (block: Block) => {
				if (blocks.has(block.id) && !hidden(block)) next.add(block.id);
				for (const child of block.children) visit(child);
			};
			for (const block of nearTop(tops, edytor.idToBlock.block, view.innerHeight)) visit(block);
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
				const id = ids.get(node);
				if (id) next.add(id);
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
				node.addEventListener('pointerover', hover);
				node.addEventListener('pointerleave', unhover);
				layer.addEventListener('pointerover', hoverOverlay);
				layer.addEventListener('pointerleave', unhover);
				const offNear = measured ? edytor.overlay.add(measureNear) : undefined;
				const component = mount(BlockHandles, {
					target: layer,
					props: { edytor, controller, blocks, near, hovered, handle: options.handle }
				});
				return () => {
					node.removeEventListener('pointerover', hover);
					node.removeEventListener('pointerleave', unhover);
					layer.removeEventListener('pointerover', hoverOverlay);
					layer.removeEventListener('pointerleave', unhover);
					offNear?.();
					clearTimeout(afterPaint);
					afterPaint = undefined;
					gained = null;
					void unmount(component);
				};
			},
			onBlockAttached: ({ node, block }) => {
				// A table's rows move by its own row menus, its cells never (`table.fits`).
				if (!block.movable || edytor.facade.isTableRow(block.id)) return;
				const offDropTarget = controller.addDropTarget(node, block);
				// A layout and its columns are drop targets but have no handle (as
				// Notion): a block selection covering a layout stands for it.
				const { facade } = edytor;
				if (facade.isLayout(block.id) || facade.isLayoutItem(block.id)) return offDropTarget;
				ids.set(node, block.id);
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
	handlePlugins.add(plugin);
	return plugin;
};

/** Default handles for consumers that add the plugin directly. */
export const blockHandlesPlugin = createBlockHandlesPlugin();
