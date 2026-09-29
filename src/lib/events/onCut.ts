import type { Edytor } from '../edytor.svelte.js';
import { deleteSelectedBlocks, deleteSelectedRange } from '$lib/selection/replaceSelection.js';
import { copySelection } from './onCopy.js';

/**
 * Cut = copy, then the delete as one user command (the clipboard is written
 * first). A range is deleted as Backspace deletes it (`del.range.*`,
 * `deleteByCut`): the clipboard holds what the range covers, so the cut
 * removes exactly that.
 */
export async function onCut(this: Edytor, e: ClipboardEvent) {
	if (this.readonly || !copySelection(this, e, 'onCut')) return;
	await this.dispatcher.run('deleteByCut', () =>
		this.selection.selectedBlocks.size > 0 ? deleteSelectedBlocks(this) : deleteSelectedRange(this)
	);
}
