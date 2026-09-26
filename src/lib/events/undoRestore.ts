import type { Edytor } from '$lib/edytor.svelte.js';
import { refreshDomAfterHistoryChange } from '$lib/history/refreshDomAfterHistoryChange.js';
import {
	beginHistoryCommandRestore,
	getHistorySelectionSnapshot,
	restoreCollapsedHistorySelection,
	restoreCollapsedHistorySelectionState
} from '$lib/history/historySelectionSnapshot.js';
import { getSelectedBlocksInDocumentOrder } from '$lib/selection/replaceSelection.js';

/**
 * One owner for the undo/redo + selection-restore sequence — the mod+z /
 * mod+shift+z hotkeys, native `historyUndo`/`historyRedo` beforeinput, and
 * the input-event fallback all run this so a block selection restores
 * identically on every channel.
 *
 * The redo fallback exists because redoing a block-range deletion has no
 * surviving snapshot text: the caret lands at the editable end of the
 * block adjacent to the deleted selection (resolved AFTER the command so
 * it reflects the post-redo document).
 */
export const runHistoryCommand = async (
	edytor: Edytor,
	command: 'undo' | 'redo',
	options: { queueSelectionSnapshot?: boolean } = {}
) => {
	const stack = command === 'undo' ? edytor.undoManager.undoStack : edytor.undoManager.redoStack;
	const stackItem = stack.at(-1);
	const selectionSnapshot = getHistorySelectionSnapshot(edytor, stackItem, {
		preferRestore: command === 'redo'
	});
	const shouldRestoreSelection = beginHistoryCommandRestore(edytor);
	const selectedBlocks = command === 'redo' ? getSelectedBlocksInDocumentOrder(edytor) : [];
	const redoFallbackBlock =
		selectedBlocks.at(0)?.closestPreviousBlock ?? selectedBlocks.at(-1)?.closestNextBlock;

	if (options.queueSelectionSnapshot) {
		edytor.selection.queueNextUndoSelectionSnapshot();
	}

	if (command === 'undo') {
		edytor.historyUndo();
	} else {
		edytor.historyRedo();
	}

	const fallbackText = redoFallbackBlock?.firstEditableText;
	if (fallbackText) {
		edytor.selection.setCollapsedStateAtTextOffset(fallbackText, fallbackText.length);
	} else {
		restoreCollapsedHistorySelectionState(edytor, selectionSnapshot, shouldRestoreSelection);
	}

	await refreshDomAfterHistoryChange(edytor, {
		restoreSelection: false,
		shouldRestoreSelection
	});
	if (!shouldRestoreSelection()) {
		return;
	}
	if (fallbackText) {
		await edytor.selection.setAtTextOffset(fallbackText, fallbackText.length);
		return;
	}
	await restoreCollapsedHistorySelection(edytor, selectionSnapshot, shouldRestoreSelection);
};
