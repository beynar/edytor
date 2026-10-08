import type { Snippet } from 'svelte';
import { mount, unmount } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import type { Plugin } from '$lib/plugins.js';
import type { Block } from '$lib/block/block.svelte.js';
import BlockHandles from './BlockHandles.svelte';
import { BlockHandleController } from './BlockHandleController.svelte.js';
import { labelsWith, type PartialLabels } from '$lib/labels.js';

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
	 * right of its column. Nothing is added until a row is picked.
	 */
	add: (alt?: boolean) => void;
	/** Whether the block takes a `+`: always `true` (a block in a column too, as Notion). */
	addable: boolean;
	readonly: boolean;
	draggable: boolean;
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

/** A handle for a block within about one screen of the viewport. */
const NEAR_MARGIN = '100% 0px';

/**
 * Block handles in the overlay, created lazily: a handle mounts
 * for a block near the viewport (every block without IntersectionObserver),
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
		const observer =
			typeof IntersectionObserver === 'undefined'
				? null
				: new IntersectionObserver(
						(entries) => {
							for (const {
								target,
								isIntersecting,
								boundingClientRect: at,
								rootBounds
							} of entries) {
								const id = ids.get(target);
								if (!id) continue;
								// Near: intersecting, or its unclipped box in the band (an inner scroll
								// container may clip a near block). A hidden block (collapsed toggle
								// child) has an empty box and is not.
								const inBand =
									at.height > 0 &&
									(!rootBounds || (at.bottom >= rootBounds.top && at.top <= rootBounds.bottom));
								if (isIntersecting || inBand) near.add(id);
								else near.delete(id);
							}
						},
						{ rootMargin: NEAR_MARGIN }
					);
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
				const component = mount(BlockHandles, {
					target: layer,
					props: { edytor, controller, blocks, near, hovered, handle: options.handle }
				});
				return () => {
					node.removeEventListener('pointerover', hover);
					node.removeEventListener('pointerleave', unhover);
					layer.removeEventListener('pointerover', hoverOverlay);
					layer.removeEventListener('pointerleave', unhover);
					observer?.disconnect();
					void unmount(component);
				};
			},
			onBlockAttached: ({ node, block }) => {
				// A table's rows move by its own row menus, its cells never (`table.fits`).
				if (!block.movable || edytor.facade.isTableRow(block.id)) return;
				const offDropTarget = controller.addDropTarget(node, block);
				// A layout and its columns are drop targets but have no handle (D3, as
				// Notion): a block selection covering a layout stands for it.
				const { facade } = edytor;
				if (facade.isLayout(block.id) || facade.isLayoutItem(block.id)) return offDropTarget;
				ids.set(node, block.id);
				blocks.set(block.id, block);
				if (observer) observer.observe(node);
				else near.add(block.id);
				return () => {
					observer?.unobserve(node);
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
