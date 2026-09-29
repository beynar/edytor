import type { Edytor } from '../edytor.svelte.js';
import { deleteSelectedBlocks } from '$lib/selection/replaceSelection.js';
import { copySelection } from './onCopy.js';

/**
 * The range deleted as Backspace deletes it (`del.range.*`, `deleteByCut`):
 * the clipboard holds what the range covers, so the cut removes exactly that.
 */
const deleteSelectedContent = (edytor: Edytor) => {
	const [text, offset] = edytor.deleteContentWithinSelection({}) ?? [];
	if (text) edytor.selection.setAtTextOffset(text, offset!);
};

/** Cut = copy, then the delete as one user command (the clipboard is written first). */
export async function onCut(this: Edytor, e: ClipboardEvent) {
	if (this.readonly || !copySelection(this, e, 'onCut')) return;
	await this.dispatcher.run('deleteByCut', () =>
		this.selection.selectedBlocks.size > 0
			? deleteSelectedBlocks(this)
			: deleteSelectedContent(this)
	);
}
