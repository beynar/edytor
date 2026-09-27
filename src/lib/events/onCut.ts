import {
	createEdytorClipboardFragment,
	writeEdytorClipboardData
} from '$lib/clipboard/clipboard.js';
import type { Edytor } from '../edytor.svelte.js';
import { prevent } from '$lib/utils.js';
import { observeInternalDragSources } from './onDrop.js';
import { observeShiftPasteModifier } from './onPaste.js';
import {
	deleteSelectedBlocks,
	replaceSelectionWithCollapsedTarget
} from '$lib/selection/replaceSelection.js';
import { isNestedForeignEditableTarget } from './nativeInteractiveControl.js';

const deleteSelectedContent = async (edytor: Edytor) => {
	edytor.selection.queueNextUndoSelectionSnapshot();
	await replaceSelectionWithCollapsedTarget(edytor);
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

	if (
		this.dispatcher.intercept(
			(plugin) => plugin.onCut?.({ prevent, e }),
			() => e.preventDefault()
		)
	)
		return;

	const fragment = createEdytorClipboardFragment(this);
	if (!fragment) {
		return;
	}

	e.preventDefault();
	writeEdytorClipboardData(e.clipboardData, fragment, this);
	// The clipboard is written before the delete, which is one user command.
	await this.dispatcher.run('deleteByCut', () =>
		this.selection.selectedBlocks.size > 0
			? deleteSelectedBlocks(this)
			: deleteSelectedContent(this)
	);
}
