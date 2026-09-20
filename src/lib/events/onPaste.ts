import type { Edytor } from '../edytor.svelte.js';
import { prevent, PreventionError } from '$lib/utils.js';
import {
	insertEdytorClipboardFragment,
	readEdytorClipboardFragment
} from '$lib/clipboard/clipboard.js';
import { Block } from '$lib/block/block.svelte.js';
import { getDomSelectionSnapshot } from '$lib/selection/domSelection.js';
import { getYIndex } from '$lib/selection/selection.utils.js';

const createSyntheticPasteInput = (e: ClipboardEvent): InputEvent => {
	const text = e.clipboardData?.getData('text/plain') ?? '';
	const html = e.clipboardData?.getData('text/html') ?? '';
	const event = new Event('beforeinput', {
		bubbles: true,
		cancelable: true
	}) as InputEvent;

	Object.defineProperties(event, {
		inputType: {
			value: 'insertFromPaste',
			configurable: true
		},
		data: {
			value: text,
			configurable: true
		},
		dataTransfer: {
			value: {
				getData: (type: string) => {
					if (type === 'text/html') {
						return html;
					}
					if (type === 'text/plain') {
						return text;
					}
					return '';
				}
			} satisfies Pick<DataTransfer, 'getData'>,
			configurable: true
		}
	});

	return event;
};

const isInsideSelectedBlock = (block: Block, selectedBlocks: Set<Block>) => {
	let current: Block | undefined = block;
	while (current) {
		if (selectedBlocks.has(current)) {
			return true;
		}
		current = current.parent instanceof Block ? current.parent : undefined;
	}
	return false;
};

const syncCollapsedDomCaretForPaste = (edytor: Edytor) => {
	if (edytor.selection.selectedBlocks.size === 0) {
		return;
	}

	const selection = getDomSelectionSnapshot(edytor.node);
	const container = edytor.container;
	if (
		!selection?.isCollapsed ||
		!selection.anchorNode ||
		!selection.focusNode ||
		!container?.contains(selection.anchorNode) ||
		!container.contains(selection.focusNode)
	) {
		return;
	}

	const targetText = edytor.selection.getTextOfNode(selection.anchorNode, selection.anchorOffset);
	if (!targetText) {
		return;
	}

	const selectedBlocks = new Set(edytor.selection.selectedBlocks);
	if (isInsideSelectedBlock(targetText.parent, selectedBlocks)) {
		return;
	}

	edytor.selection.setCollapsedStateAtTextOffset(
		targetText,
		getYIndex(targetText, selection.anchorNode, selection.anchorOffset)
	);
};

export async function onPaste(this: Edytor, e: ClipboardEvent) {
	if (this.readonly || this.selection.state.isVoidEditableElement) {
		return;
	}

	syncCollapsedDomCaretForPaste(this);

	const fragment = readEdytorClipboardFragment(e.clipboardData);
	if (fragment) {
		e.preventDefault();
		this.undoManager.stopCapturing();
		return insertEdytorClipboardFragment(this, fragment);
	}

	try {
		for (const plugin of this.plugins) {
			plugin.onPaste?.({ prevent, e });
		}
	} catch (error) {
		if (error instanceof PreventionError) {
			e.preventDefault();
			return error.cb?.();
		}
		throw error;
	}

	if (!e.clipboardData?.getData('text/plain')) {
		return;
	}

	e.preventDefault();
	this.undoManager.stopCapturing();
	return this.onBeforeInput(createSyntheticPasteInput(e));
}
