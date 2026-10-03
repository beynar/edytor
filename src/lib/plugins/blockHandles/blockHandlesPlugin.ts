import type { Snippet } from 'svelte';
import { mount, unmount } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import type { Plugin } from '$lib/plugins.js';
import type { Block } from '$lib/block/block.svelte.js';
import BlockHandles from './BlockHandles.svelte';
import { BlockHandleController } from './BlockHandleController.svelte.js';

export type BlockHandleActivation = { block: Block; anchor: HTMLElement };

/** What a `handle` snippet receives. */
export type BlockHandleSnippetPayload = {
	block: Block;
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
};

const handlePlugins = new WeakSet<Plugin>();

/** Recognize both the default and configured handle plugins during component composition. */
export const isBlockHandlesPlugin = (plugin: Plugin) => handlePlugins.has(plugin);

/** A handle for a block within about one screen of the viewport. */
const NEAR_MARGIN = '100% 0px';

/**
 * Block handles in the overlay (R11, L50), created lazily: a handle mounts
 * for a block near the viewport (every block without IntersectionObserver),
 * under the pointer, selected, focused or dragged; drop targets exist only
 * during our own drag. Hover is one delegated listener on the editor.
 */
export const createBlockHandlesPlugin = (options: BlockHandlesOptions = {}): Plugin => {
	const plugin: Plugin = (edytor) => {
		const controller = new BlockHandleController(edytor, {
			draggable: options.draggable !== false,
			onActivate: options.onActivate
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
		 * its handled ancestors (a layout and its columns have none).
		 */
		const hover = (event: PointerEvent) => {
			const next = new Set<string>();
			for (
				let node = (event.target as Element | null)?.closest?.('[data-edytor-block="true"]');
				node;
				node = node.parentElement?.closest('[data-edytor-block="true"]')
			) {
				const id = ids.get(node);
				if (id) next.add(id);
			}
			for (const id of hovered) if (!next.has(id)) hovered.delete(id);
			for (const id of next) hovered.add(id);
		};
		const unhover = () => hovered.clear();

		return {
			onEdytorAttached: ({ node }) => {
				node.addEventListener('pointerover', hover);
				node.addEventListener('pointerleave', unhover);
				const component = mount(BlockHandles, {
					target: edytor.overlay.layer!,
					props: { edytor, controller, blocks, near, hovered, handle: options.handle }
				});
				return () => {
					node.removeEventListener('pointerover', hover);
					node.removeEventListener('pointerleave', unhover);
					observer?.disconnect();
					void unmount(component);
				};
			},
			onBlockAttached: ({ node, block }) => {
				if (!block.movable) return;
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
