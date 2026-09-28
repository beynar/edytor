import type { Edytor } from '../edytor.svelte.js';
import {
	deleteSelectedBlocks,
	replaceSelectionWithCollapsedTarget
} from '$lib/selection/replaceSelection.js';
import { copySelection } from './onCopy.js';

const deleteSelectedContent = (edytor: Edytor) => {
	const target = replaceSelectionWithCollapsedTarget(edytor);
	if (target) edytor.selection.setAtTextOffset(target.text, target.offset);
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
