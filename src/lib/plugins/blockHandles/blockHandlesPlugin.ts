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

/**
 * Block handles in the overlay (R11, L50): every registered movable block
 * gets one, shown while the pointer is over the block; the block element is
 * the drop target.
 */
export const createBlockHandlesPlugin = (options: BlockHandlesOptions = {}): Plugin =>
	registerBlockHandlesPlugin((edytor) => {
		const controller = new BlockHandleController(edytor, {
			draggable: options.draggable !== false,
			onActivate: options.onActivate
		});
		const blocks = new SvelteMap<string, Block>();
		const hovered = new SvelteSet<string>();

		return {
			onEdytorAttached: () => {
				const component = mount(BlockHandles, {
					target: edytor.overlay.layer!,
					props: { edytor, controller, blocks, hovered }
				});
				return () => void unmount(component);
			},
			onBlockAttached: ({ node, block }) => {
				if (!block.movable) return () => {};
				const show = () => hovered.add(block.id);
				const hide = () => hovered.delete(block.id);
				node.addEventListener('pointerenter', show);
				node.addEventListener('pointerleave', hide);
				blocks.set(block.id, block);
				const cleanupDropTarget = controller.registerDropTarget(node, block);
				return () => {
					node.removeEventListener('pointerenter', show);
					node.removeEventListener('pointerleave', hide);
					hide();
					if (block.node === node || block.node === undefined) blocks.delete(block.id);
					cleanupDropTarget();
				};
			}
		};
	});

/** Default handles for consumers that add the plugin directly. */
export const blockHandlesPlugin = createBlockHandlesPlugin();
