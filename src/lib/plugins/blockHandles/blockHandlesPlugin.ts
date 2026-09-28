import { mount, unmount } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import type { Plugin } from '$lib/plugins.js';
import type { Block } from '$lib/block/block.svelte.js';
import BlockHandles from './BlockHandles.svelte';
import { BlockHandleController } from './BlockHandleController.svelte.js';

export type BlockHandleActivation = { block: Block; anchor: HTMLElement };

export type BlockHandlesOptions = {
	/** Keep the handle and its keyboard actions, but omit pointer dragging and drop targets. */
	draggable?: boolean;
	onActivate?: (activation: BlockHandleActivation) => void;
};

const handlePlugins = new WeakSet<Plugin>();

/** Recognize both the default and configured handle plugins during component composition. */
export const isBlockHandlesPlugin = (plugin: Plugin) => handlePlugins.has(plugin);

const registerBlockHandlesPlugin = (plugin: Plugin): Plugin => {
	handlePlugins.add(plugin);
	return plugin;
};

/** A handle for a block within about one screen of the viewport. */
const NEAR_MARGIN = '100% 0px';

/**
 * Block handles in the overlay (R11, L50), created lazily: a handle mounts
 * for a block near the viewport (every block without IntersectionObserver),
 * under the pointer, selected, focused or dragged; drop targets exist only
 * during our own drag. Hover is one delegated listener on the editor.
 */
export const createBlockHandlesPlugin = (options: BlockHandlesOptions = {}): Plugin =>
	registerBlockHandlesPlugin((edytor) => {
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
		/** The movable blocks under the pointer: the hovered block and its movable ancestors. */
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
					props: { edytor, controller, blocks, near, hovered }
				});
				return () => {
					node.removeEventListener('pointerover', hover);
					node.removeEventListener('pointerleave', unhover);
					observer?.disconnect();
					void unmount(component);
				};
			},
			onBlockAttached: ({ node, block }) => {
				if (!block.movable) return () => {};
				ids.set(node, block.id);
				blocks.set(block.id, block);
				if (!observer) near.add(block.id);
				else {
					observer.observe(node);
				}
				const offDropTarget = controller.addDropTarget(node, block);
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
	});

/** Default handles for consumers that add the plugin directly. */
export const blockHandlesPlugin = createBlockHandlesPlugin();
