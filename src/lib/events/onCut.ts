import {
	createEdytorClipboardFragment,
	writeEdytorClipboardData
} from '$lib/clipboard/clipboard.js';
import type { Edytor } from '../edytor.svelte.js';
import { prevent, PreventionError } from '$lib/utils.js';
import { observeInternalDragSources } from './onDrop.js';
import { observeShiftPasteModifier } from './onPaste.js';
import {
	removeSelectedBlocksForReplacement,
	replaceSelectionWithCollapsedTarget
} from '$lib/selection/replaceSelection.js';
import { isNestedForeignEditableTarget } from './nativeInteractiveControl.js';

const deleteSelectedContent = async (edytor: Edytor) => {
	edytor.selection.queueNextUndoSelectionSnapshot();
	await replaceSelectionWithCollapsedTarget(edytor);
};

const focusDeletedBlockFallback = async (edytor: Edytor) => {
	const removed = removeSelectedBlocksForReplacement(edytor, {
		queueUndoSelectionSnapshot: true
	});
	const text = removed?.blockToFocus?.firstEditableText;
	if (text) {
		await edytor.selection.setAtTextOffset(text, text.length);
	}
};

export async function onCut(this: Edytor, e: ClipboardEvent) {
	if (this.readonly || this.selection.state.isVoidEditableElement) {
		return;
	}

	// A cut inside a nested `contenteditable` island belongs to the
	// island — the fragment/delete paths below operate on the model
	// selection, not the island's.
	if (isNestedForeignEditableTarget(this.node, e.target)) {
		return;
	}

	observeInternalDragSources(this.node?.getRootNode());
	observeShiftPasteModifier(this.node?.getRootNode());

	try {
		for (const plugin of this.plugins) {
			plugin.onCut?.({ prevent, e });
		}
	} catch (error) {
		if (error instanceof PreventionError) {
			e.preventDefault();
			return error.cb?.();
		}
		throw error;
	}

	const fragment = createEdytorClipboardFragment(this);
	if (!fragment) {
		return;
	}

	e.preventDefault();
	writeEdytorClipboardData(e.clipboardData, fragment);
	this.undoManager.stopCapturing();

	if (this.selection.selectedBlocks.size > 0) {
		await focusDeletedBlockFallback(this);
		return;
	}

	await deleteSelectedContent(this);
}
