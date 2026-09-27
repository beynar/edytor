import type { Edytor } from '$lib/edytor.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import { tick } from 'svelte';
import type { BeforeInputSnapshot } from './beforeInputSnapshot.js';
import { setSuppressedInputRepairSelectionTarget } from './beforeInputRepairTarget.js';
import { getNextWordEndOffset, getPreviousWordStartOffset } from './wordBoundary.js';

const isForwardDeleteInsideActiveComposition = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const state = edytor.compositionState;
	if (
		!edytor.isComposing ||
		!state ||
		snapshot.inputType !== 'deleteContentForward' ||
		!snapshot.isCollapsed ||
		snapshot.startText?.id !== state.textId
	) {
		return false;
	}

	return (
		snapshot.yStart >= state.startOffset &&
		snapshot.yStart <= state.startOffset + state.value.length
	);
};

/** A non-collapsed selection: the document's range deletion, then its caret (`del.range.*`). */
const deleteSelectedRange = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const [text, offset] = edytor.deleteContentWithinSelection({ selection: snapshot }) ?? [];
	if (text) await edytor.selection.setAtTextOffset(text, offset!);
};

const deleteContentForward = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const { startText, yStart } = snapshot;
	if (!startText) {
		return;
	}

	if (isForwardDeleteInsideActiveComposition(edytor, snapshot)) {
		await edytor.selection.setAtTextOffset(startText, yStart);
		return;
	}

	if (snapshot.isAtEndOfBlock) {
		const currentBlock = startText.parent;
		if (currentBlock.definition.void) {
			await edytor.selection.setAtTextOffset(startText, yStart);
			return;
		}

		const nextBlock = currentBlock.closestNextBlock;
		if (nextBlock?.definition.void) {
			edytor.selection.selectBlocks(nextBlock);
			return;
		}

		currentBlock.mergeBlockForward();
		setSuppressedInputRepairSelectionTarget(edytor, startText, yStart);
		await edytor.selection.setAtTextOffset(startText, yStart);
		return;
	}

	if (snapshot.isAtEndOfText) {
		const index = startText.parent.content.indexOf(startText) + 1;
		startText.parent.removeInlineBlock({ index });
		await edytor.selection.setAtTextOffset(startText, yStart);
		return;
	}

	startText.deleteText({ direction: 'FORWARD', length: 1 });
	await tick();
	await edytor.selection.setAtTextOffset(startText, yStart);
};

const deleteContentBackward = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const { startText, yStart } = snapshot;

	if (snapshot.isAtStartOfBlock && snapshot.isFirstChildOfDocument && startText?.parent.isEmpty) {
		await edytor.selection.setAtTextOffset(startText, 0);
		return;
	}

	if (!startText) {
		return;
	}

	if (snapshot.isAtStartOfBlock) {
		if (snapshot.isNested && snapshot.isLastChild && !snapshot.islandRoot) {
			const newBlock = startText.parent.unNestBlock();
			if (newBlock) {
				await edytor.selection.setAtTextOffset(newBlock.firstText, 0);
			}
			return;
		}

		if (snapshot.islandRoot && snapshot.islandRoot.children.length === 1) {
			edytor.selection.selectBlocks(snapshot.islandRoot);
			return;
		}

		if (
			snapshot.islandRoot &&
			snapshot.islandRoot.children.length > 1 &&
			startText.parent.index === 0
		) {
			return;
		}

		const previousBlock = startText.parent.closestPreviousBlock;
		if (previousBlock?.definition.void) {
			edytor.selection.selectBlocks(previousBlock);
			return;
		}

		const previousText = previousBlock?.lastText;
		const offset = previousText?.length;
		startText.parent.mergeBlockBackward();
		if (previousText && typeof offset === 'number') {
			setSuppressedInputRepairSelectionTarget(edytor, previousText, offset);
			await edytor.selection.setAtTextOffset(previousText, offset);
		}
		return;
	}

	if (snapshot.isAtStartOfText) {
		const index = startText.parent.content.indexOf(startText) - 1;
		const previousText = startText.parent.content.at(index - 1);
		const hasPreviousText = previousText && previousText instanceof Text;
		const offset = hasPreviousText ? previousText.length : 0;
		startText.parent.removeInlineBlock({ index });
		if (hasPreviousText) {
			await edytor.selection.setAtTextOffset(previousText, offset);
		}
		return;
	}

	const deletion = startText.deleteText({ direction: 'BACKWARD', length: 1 });
	await tick();
	await edytor.selection.setAtTextOffset(startText, deletion?.start ?? yStart - 1);
};

/**
 * A collapsed unit delete (`del.unit.*`): the model owns the extent — a word
 * run from the caret's own text, or the block's line to either side, or all
 * of it — deleted as one range; the caret lands at its start.
 */
const deleteCollapsedUnit = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const { startText: text, yStart, inputType } = snapshot;
	if (!text) return;
	const [first, last] = [text.parent.firstText!, text.parent.lastText!];
	const [from, to]: [Text, number][] =
		inputType === 'deleteWordBackward'
			? [
					[text, getPreviousWordStartOffset(text.stringContent, yStart)],
					[text, yStart]
				]
			: inputType === 'deleteWordForward'
				? [
						[text, yStart],
						[text, getNextWordEndOffset(text.stringContent, yStart)]
					]
				: inputType === 'deleteEntireSoftLine'
					? [
							[first, 0],
							[last, last.length]
						]
					: inputType.endsWith('Backward')
						? [
								[first, 0],
								[text, yStart]
							]
						: [
								[text, yStart],
								[last, last.length]
							];
	text.parent.deleteContentAtRange({ start: [from[0].index, from[1]], end: [to[0].index, to[1]] });
	await edytor.selection.setAtTextOffset(...from);
};

export const runBeforeInputDeleteCommand = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	// Timestamp the delete so the Android post-delete caret snap-back can
	// arm only on caret writes caused by an actual delete — navigational
	// jumps with the same "offset-0 → different text" signature must not
	// qualify (selection.svelte.ts `recordPostDeleteCaretTarget`).
	edytor.selection.lastDeleteCommandAt = Date.now();
	const { inputType } = snapshot;
	const forward = /Forward$|^deleteContent$|^deleteEntireSoftLine$/.test(inputType);
	// A selection: the document's range deletion (a forward one needs its text).
	if (!snapshot.isCollapsed) {
		return forward && !snapshot.startText ? undefined : deleteSelectedRange(edytor, snapshot);
	}
	if (inputType === 'deleteContentBackward') return deleteContentBackward(edytor, snapshot);
	if (inputType === 'deleteContentForward' || inputType === 'deleteContent')
		return deleteContentForward(edytor, snapshot);
	// A collapsed cut, drag or composition fragment deletes nothing.
	if (!/^delete(ByCut|ByDrag|ByComposition)$/.test(inputType))
		return deleteCollapsedUnit(edytor, snapshot);
};
