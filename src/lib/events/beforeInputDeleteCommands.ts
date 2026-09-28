import type { Edytor } from '$lib/edytor.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { Attempt } from '$lib/session/attempt.js';
import { getNextWordEndOffset, getPreviousWordStartOffset } from './wordBoundary.js';

/** A forward delete at a live composition's region keeps the preview (the IME owns it). */
const isForwardDeleteInsideActiveComposition = (edytor: Edytor, snapshot: Attempt) =>
	snapshot.inputType === 'deleteContentForward' &&
	snapshot.isCollapsed &&
	Boolean(snapshot.startText && edytor.composition.covers(snapshot.startText, snapshot.yStart));

/** A non-collapsed selection: the document's range deletion, then its caret (`del.range.*`). */
const deleteSelectedRange = (edytor: Edytor, snapshot: Attempt) => {
	const [text, offset] = edytor.deleteContentWithinSelection({ selection: snapshot }) ?? [];
	if (text) edytor.selection.setAtTextOffset(text, offset!);
};

const deleteContentForward = (edytor: Edytor, snapshot: Attempt) => {
	const { startText, yStart } = snapshot;
	if (!startText) {
		return;
	}

	if (isForwardDeleteInsideActiveComposition(edytor, snapshot)) {
		edytor.selection.setAtTextOffset(startText, yStart);
		return;
	}

	if (snapshot.isAtEndOfBlock) {
		const currentBlock = startText.parent;
		if (currentBlock.definition.void) {
			edytor.selection.setAtTextOffset(startText, yStart);
			return;
		}

		const nextBlock = currentBlock.closestNextBlock;
		if (nextBlock?.definition.void) {
			edytor.selection.selectBlocks(nextBlock);
			return;
		}

		currentBlock.mergeBlockForward();
		edytor.attempts.caret(startText, yStart);
		edytor.selection.setAtTextOffset(startText, yStart);
		return;
	}

	if (snapshot.isAtEndOfText) {
		const index = startText.parent.content.indexOf(startText) + 1;
		startText.parent.removeInlineBlock({ index });
		edytor.selection.setAtTextOffset(startText, yStart);
		return;
	}

	startText.deleteText({ direction: 'FORWARD', length: 1 });
	edytor.selection.setAtTextOffset(startText, yStart);
};

const deleteContentBackward = (edytor: Edytor, snapshot: Attempt) => {
	const { startText, yStart } = snapshot;

	if (snapshot.isAtStartOfBlock && snapshot.isFirstChildOfDocument && startText?.parent.isEmpty) {
		edytor.selection.setAtTextOffset(startText, 0);
		return;
	}

	if (!startText) {
		return;
	}

	if (snapshot.isAtStartOfBlock) {
		if (snapshot.isNested && snapshot.isLastChild && !snapshot.islandRoot) {
			const newBlock = startText.parent.unNestBlock();
			if (newBlock) {
				edytor.selection.setAtTextOffset(newBlock.firstText, 0);
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
			edytor.attempts.caret(previousText, offset);
			edytor.selection.setAtTextOffset(previousText, offset);
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
			edytor.selection.setAtTextOffset(previousText, offset);
		}
		return;
	}

	const deletion = startText.deleteText({ direction: 'BACKWARD', length: 1 });
	edytor.selection.setAtTextOffset(startText, deletion?.start ?? yStart - 1);
};

/**
 * The caret's line edge in one direction (`del.unit.soft-line`): a soft line
 * ends at the nearest `\n` of the block's texts, a hard line at the block's
 * edge. Visual wraps stay browser-owned.
 */
const lineEdge = (text: Text, at: number, backward: boolean, soft: boolean): [Text, number] => {
	const texts = text.parent.content.filter((part): part is Text => part instanceof Text);
	const own = texts.findIndex((part) => part.id === text.id);
	for (let i = own; ; i += backward ? -1 : 1) {
		const value = texts[i].stringContent;
		const from = i === own ? at : backward ? value.length : 0;
		const k =
			!soft || (backward && from === 0)
				? -1
				: backward
					? value.lastIndexOf('\n', from - 1)
					: value.indexOf('\n', from);
		if (k >= 0) return [texts[i], backward ? k + 1 : k];
		if (backward ? i === 0 : i === texts.length - 1) return [texts[i], backward ? 0 : value.length];
	}
};

/**
 * A collapsed unit delete (`del.unit.*`): the model owns the extent — a word
 * run from the caret's own text, the caret's line to either side, or the
 * whole block — deleted as one range; the caret lands at its start.
 */
const deleteCollapsedUnit = (edytor: Edytor, snapshot: Attempt) => {
	const { startText: text, yStart, inputType } = snapshot;
	if (!text) return;
	const [first, last] = [text.parent.firstText!, text.parent.lastText!];
	const soft = inputType.startsWith('deleteSoftLine');
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
						? [lineEdge(text, yStart, true, soft), [text, yStart]]
						: [[text, yStart], lineEdge(text, yStart, false, soft)];
	// Nothing of the caret's own text lies in the delete direction (the caret
	// is at the text's edge: next to an inline atom, or at the block's edge):
	// the unit is the neighbour, deleted like a character (atom, merge, unnest).
	if (from[0] === to[0] && from[1] === to[1] && inputType !== 'deleteEntireSoftLine') {
		return inputType.endsWith('Backward')
			? deleteContentBackward(edytor, snapshot)
			: deleteContentForward(edytor, snapshot);
	}
	text.parent.deleteContentAtRange({ start: [from[0].index, from[1]], end: [to[0].index, to[1]] });
	edytor.selection.setAtTextOffset(...from);
};

export const runBeforeInputDeleteCommand = (edytor: Edytor, snapshot: Attempt) => {
	// The Android post-delete snap-back's evidence (a named projector rule):
	// only an actual delete arms it, never a navigational jump.
	edytor.projector.deleted(snapshot);
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
