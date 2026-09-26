import { mount, unmount } from 'svelte';

import type { Plugin } from '$lib/plugins.js';
import type { Block } from '$lib/block/block.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import BlockHandle from './BlockHandle.svelte';
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

const createHandleHost = (node: HTMLElement, block: Block) => {
	const host = node.ownerDocument.createElement('span');
	host.contentEditable = 'false';
	host.dataset.edytorPluginChrome = 'true';
	host.dataset.edytorBlockHandleHost = 'true';
	host.dataset.blockId = block.id;
	node.before(host);
	return host;
};

const firstRowCenter = (node: HTMLElement, block: Block): number => {
	if (block.definition.island) {
		const header = node.querySelector<HTMLElement>(':scope > [data-edytor-void="true"]');
		if (header) {
			const rect = header.getBoundingClientRect();
			return rect.top + rect.height / 2;
		}
	}
	if (!block.definition.void && !block.definition.island) {
		const text = block.content.find((part): part is Text => part instanceof Text);
		const line = text?.node?.getClientRects()[0];
		if (line && line.height > 0) {
			return line.top + line.height / 2;
		}
	}
	const rect = node.getBoundingClientRect();
	return rect.top + Math.min(rect.height, 24) / 2;
};

type HandleAlignment = { host: HTMLElement; block: Block; offsetY: number };

export const createBlockHandlesPlugin = (options: BlockHandlesOptions = {}): Plugin =>
	registerBlockHandlesPlugin((edytor) => {
		const controller = new BlockHandleController(edytor, {
			draggable: options.draggable !== false,
			onActivate: options.onActivate
		});
		const activeHandles = new Map<string, () => void>();
		const alignments = new Map<HTMLElement, HandleAlignment>();
		const pendingAlignments = new Set<HTMLElement>();
		let editorNode: HTMLElement | null = null;
		let editorWidth = 0;
		let resizeObserver: ResizeObserver | null = null;
		let structureObserver: MutationObserver | null = null;
		let alignmentFrame: number | null = null;

		const measureAlignment = (node: HTMLElement) => {
			const alignment = alignments.get(node);
			const handle = alignment?.host.querySelector<HTMLButtonElement>('button');
			if (!alignment || !handle) return null;
			const rect = handle.getBoundingClientRect();
			if (!rect.height) return null;
			const offsetY =
				alignment.offsetY + firstRowCenter(node, alignment.block) - (rect.top + rect.height / 2);
			return Math.abs(offsetY - alignment.offsetY) > 0.5 ? { alignment, offsetY } : null;
		};
		const applyAlignment = ({
			alignment,
			offsetY
		}: NonNullable<ReturnType<typeof measureAlignment>>) => {
			alignment.offsetY = offsetY;
			alignment.host.style.setProperty('--edytor-handle-offset-y', `${offsetY}px`);
		};
		const alignNow = (node: HTMLElement) => {
			const update = measureAlignment(node);
			if (update) applyAlignment(update);
		};
		const flushAlignments = () => {
			alignmentFrame = null;
			const updates = Array.from(pendingAlignments, measureAlignment).filter(
				(update): update is NonNullable<typeof update> => update !== null
			);
			pendingAlignments.clear();
			updates.forEach(applyAlignment);
		};
		const queueAlignment = (node: HTMLElement) => {
			pendingAlignments.add(node);
			if (alignmentFrame !== null) return;
			const view = node.ownerDocument.defaultView;
			if (view?.requestAnimationFrame) {
				alignmentFrame = view.requestAnimationFrame(flushAlignments);
			} else {
				alignmentFrame = 0;
				queueMicrotask(flushAlignments);
			}
		};
		const observerFor = () => {
			if (typeof ResizeObserver === 'undefined') return null;
			resizeObserver ??= new ResizeObserver((entries) => {
				for (const entry of entries) {
					if (entry.target === editorNode) {
						if (Math.abs(entry.contentRect.width - editorWidth) < 0.5) continue;
						editorWidth = entry.contentRect.width;
						for (const node of alignments.keys()) queueAlignment(node);
					} else if (entry.target instanceof HTMLElement) {
						queueAlignment(entry.target);
					}
				}
			});
			return resizeObserver;
		};
		const containsBlockStructure = (node: Node) =>
			node instanceof Element &&
			(node.matches('[data-edytor-block], [data-edytor-block-handle-host]') ||
				node.querySelector('[data-edytor-block], [data-edytor-block-handle-host]') !== null);
		const collectAlignedBlocks = (
			candidate: Node | null,
			affected: Set<HTMLElement>,
			includeDescendants = false
		) => {
			if (!(candidate instanceof Element)) return;
			if (candidate instanceof HTMLElement && alignments.has(candidate)) affected.add(candidate);
			if (candidate.matches('[data-edytor-block-handle-host]')) {
				const block = candidate.nextElementSibling;
				if (block instanceof HTMLElement && alignments.has(block)) affected.add(block);
			}
			if (includeDescendants) {
				for (const block of candidate.querySelectorAll<HTMLElement>('[data-edytor-block]')) {
					if (alignments.has(block)) affected.add(block);
				}
			}
		};
		const adjacentStructure = (node: Node | null, direction: 'next' | 'previous') => {
			while (node && !containsBlockStructure(node)) {
				node = direction === 'next' ? node.nextSibling : node.previousSibling;
			}
			return node;
		};
		const realignStructuralChanges = (records: MutationRecord[]) => {
			const affected = new Set<HTMLElement>();
			for (const record of records) {
				if (record.type === 'attributes') {
					const host =
						record.target instanceof Element
							? record.target.closest('[data-edytor-block-handle-host]')
							: null;
					collectAlignedBlocks(host, affected);
					continue;
				}
				const changedNodes = [...record.addedNodes, ...record.removedNodes];
				if (!changedNodes.some(containsBlockStructure)) continue;
				for (const changed of changedNodes) collectAlignedBlocks(changed, affected, true);
				collectAlignedBlocks(adjacentStructure(record.previousSibling, 'previous'), affected);
				collectAlignedBlocks(adjacentStructure(record.nextSibling, 'next'), affected);
				if (record.target instanceof HTMLElement && alignments.has(record.target)) {
					affected.add(record.target);
				}
			}
			for (const node of affected) queueAlignment(node);
		};

		return {
			onEdytorAttached: ({ node }) => {
				editorNode = node;
				observerFor()?.observe(node);
				if (typeof MutationObserver !== 'undefined') {
					structureObserver = new MutationObserver(realignStructuralChanges);
					structureObserver.observe(node, {
						childList: true,
						subtree: true,
						attributes: true,
						attributeFilter: ['hidden']
					});
				}
				return () => {
					resizeObserver?.disconnect();
					structureObserver?.disconnect();
					structureObserver = null;
					editorNode = null;
					editorWidth = 0;
				};
			},
			onBlockAttached: ({ node, block }) => {
				if (block.isRoot || block.insideIsland) {
					return () => {};
				}

				activeHandles.get(block.id)?.();
				const host = createHandleHost(node, block);
				const showHandle = () => {
					alignNow(node);
					host.dataset.visible = 'true';
				};
				const hideHandle = () => {
					delete host.dataset.visible;
				};
				node.addEventListener('pointerenter', showHandle);
				node.addEventListener('pointerleave', hideHandle);
				const component = mount(BlockHandle, {
					target: host,
					props: { block, controller }
				});
				alignments.set(node, { host, block, offsetY: 0 });
				observerFor()?.observe(node);
				queueAlignment(node);

				const cleanupDropTarget = controller.registerDropTarget(node, block);

				const cleanup = () => {
					if (activeHandles.get(block.id) !== cleanup) {
						return;
					}
					activeHandles.delete(block.id);
					alignments.delete(node);
					pendingAlignments.delete(node);
					resizeObserver?.unobserve(node);
					node.removeEventListener('pointerenter', showHandle);
					node.removeEventListener('pointerleave', hideHandle);
					cleanupDropTarget();
					unmount(component);
					host.remove();
				};
				activeHandles.set(block.id, cleanup);
				return cleanup;
			}
		};
	});

/** Default handles for consumers that add the plugin directly. */
export const blockHandlesPlugin = createBlockHandlesPlugin();
