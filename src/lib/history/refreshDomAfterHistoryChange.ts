import { tick } from 'svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import {
	removeStalePlaceholdersIn,
	scheduleRemoveStalePlaceholdersIn,
	scheduleRemoveStalePlaceholders
} from '$lib/text/removeStalePlaceholders.js';
import { captureHistoryCommandDocVersion } from '$lib/history/historySelectionSnapshot.js';

const getNearestBlockAncestor = (node: HTMLElement, root: HTMLElement) => {
	let parent = node.parentElement;
	while (parent && parent !== root) {
		if (parent.dataset.edytorBlock === 'true') {
			return parent;
		}
		parent = parent.parentElement;
	}
	return null;
};

const getRenderedChildBlockIds = (
	root: HTMLElement,
	parentBlockNode: HTMLElement | null
): string[] =>
	Array.from(root.querySelectorAll<HTMLElement>('[data-edytor-block="true"]'))
		.filter((node) => getNearestBlockAncestor(node, root) === parentBlockNode)
		.map((node) => node.dataset.edytorId)
		.filter((id): id is string => typeof id === 'string');

const hasRenderedChildOrderDrift = (root: HTMLElement, block: Block): boolean => {
	const parentNode = block.isRoot ? null : block.node;
	if (parentNode === undefined) {
		return false;
	}

	const modelChildIds = block.children.map((child) => child.id);
	const renderedChildIds = getRenderedChildBlockIds(root, parentNode);
	if (modelChildIds.join('\0') !== renderedChildIds.join('\0')) {
		return true;
	}

	return block.children.some((child) => hasRenderedChildOrderDrift(root, child));
};

export const refreshDomAfterHistoryChange = async (
	edytor: Edytor,
	options: { restoreSelection?: boolean; shouldRestoreSelection?: () => boolean } = {}
) => {
	// Runs synchronously after the undo/redo commit in every caller —
	// baseline the command's document version so a keystroke landing in
	// this refresh window invalidates the pending selection restore
	// instead of letting it regress the caret over newer input.
	captureHistoryCommandDocVersion(edytor);
	const { startText, endText, yStart, yEnd, isCollapsed } = edytor.selection.state;
	const selectedBlocks = new Set(edytor.selection.selectedBlocks);
	const shouldRefreshEditorDom =
		Boolean(startText && !startText.node?.isConnected) ||
		Boolean(!isCollapsed && endText && !endText.node?.isConnected) ||
		Array.from(selectedBlocks).some((block) => !block.node?.isConnected) ||
		Boolean(edytor.node && edytor.root && hasRenderedChildOrderDrift(edytor.node, edytor.root));
	if (shouldRefreshEditorDom) {
		edytor.refreshEditorDom();
	}

	await tick();
	await new Promise((resolve) => setTimeout(resolve));
	await tick();
	const connectedTexts = Array.from(edytor.idToText.values()).filter((text) =>
		Boolean(text.node?.isConnected)
	);

	connectedTexts.forEach((text) => {
		text.syncFromModel();
		scheduleRemoveStalePlaceholders(text);
	});
	removeStalePlaceholdersIn(edytor.node);
	scheduleRemoveStalePlaceholdersIn(edytor.node);
	await tick();
	connectedTexts.forEach((text) => scheduleRemoveStalePlaceholders(text));
	removeStalePlaceholdersIn(edytor.node);
	scheduleRemoveStalePlaceholdersIn(edytor.node);

	if (options.restoreSelection === false) {
		return;
	}

	if (options.shouldRestoreSelection?.() === false) {
		return;
	}

	if (edytor.selection.isRestoringHistorySelection) {
		return;
	}

	if (selectedBlocks.size > 0) {
		edytor.selection.selectBlocks(...selectedBlocks);
		return;
	}

	if (!startText?.node?.isConnected) {
		return;
	}

	if (!isCollapsed && endText?.node?.isConnected) {
		await edytor.selection.setAtRange(
			startText,
			Math.min(yStart, startText.length),
			endText,
			Math.min(yEnd, endText.length)
		);
		return;
	}

	await edytor.selection.setAtTextOffset(startText, Math.min(yEnd, startText.length));
};
