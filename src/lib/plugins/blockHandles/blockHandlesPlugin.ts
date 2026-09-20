import { mount, unmount } from 'svelte';

import type { Plugin } from '$lib/plugins.js';
import type { Block } from '$lib/block/block.svelte.js';
import BlockHandle from './BlockHandle.svelte';
import { BlockHandleController } from './BlockHandleController.svelte.js';

type BlockHandleEditor = Parameters<Plugin>[0];

const collectLiveBlockIds = (block: Block | undefined, ids = new Set<string>()) => {
	if (!block) {
		return ids;
	}

	for (const child of block.children) {
		ids.add(child.id);
		collectLiveBlockIds(child, ids);
	}

	return ids;
};

const removeStaleHandleHosts = (edytor: BlockHandleEditor, replacingBlockId?: string) => {
	if (!edytor.node) {
		return;
	}

	const liveBlockIds = collectLiveBlockIds(edytor.root);
	const retainedBlockIds = new Set<string>();
	const hosts = edytor.node.querySelectorAll<HTMLElement>('[data-edytor-block-handle-host]');

	for (const host of hosts) {
		const blockId = host.dataset.blockId;
		if (
			!blockId ||
			blockId === replacingBlockId ||
			!liveBlockIds.has(blockId) ||
			retainedBlockIds.has(blockId)
		) {
			host.remove();
			continue;
		}

		blockId && retainedBlockIds.add(blockId);
	}
};

const createHandleHost = (node: HTMLElement, block: Block) => {
	const host = node.ownerDocument.createElement('span');
	host.contentEditable = 'false';
	host.dataset.edytorPluginChrome = 'true';
	host.dataset.edytorBlockHandleHost = 'true';
	host.dataset.blockId = block.id;
	node.before(host);
	return host;
};

export const blockHandlesPlugin: Plugin = (edytor) => {
	const controller = new BlockHandleController(edytor);

	return {
		onBlockAttached: ({ node, block }) => {
			if (edytor.readonly || block.isRoot || block.insideIsland) {
				return () => {};
			}

			removeStaleHandleHosts(edytor, block.id);
			const host = createHandleHost(node, block);
			const component = mount(BlockHandle, {
				target: host,
				props: { block, controller }
			});

			const onDragOver = (event: DragEvent) => controller.handleDragOver(event, block, node);
			const onDragLeave = () => controller.handleDragLeave(node);
			const onDrop = (event: DragEvent) => controller.handleDrop(event, block, node);
			node.addEventListener('dragover', onDragOver);
			node.addEventListener('dragleave', onDragLeave);
			node.addEventListener('drop', onDrop);

			return () => {
				node.removeEventListener('dragover', onDragOver);
				node.removeEventListener('dragleave', onDragLeave);
				node.removeEventListener('drop', onDrop);
				unmount(component);
				host.remove();
			};
		}
	};
};
