import type { Edytor } from '$lib/edytor.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import { dispatchPlan } from '$lib/block/block.utils.js';
import { prepareDeleteContent } from '$lib/edytor.utils.js';
import { deleteSelectedBlocks, deleteSelectedRange } from '$lib/selection/replaceSelection.js';
import { shown } from '$lib/selection/visibility.js';
import { caretAt, type Attempt } from '$lib/session/attempt.js';
import { getNextWordEndOffset, getPreviousWordStartOffset } from '$lib/text/wordBoundary.js';

/** A forward delete at a live composition's region keeps the preview (the IME owns it). */
const isForwardDeleteInsideActiveComposition = (edytor: Edytor, snapshot: Attempt) =>
	snapshot.inputType === 'deleteContentForward' &&
	snapshot.isCollapsed &&
	Boolean(snapshot.startText && edytor.composition.covers(snapshot.startText, snapshot.yStart));

/**
 * Merge `from` into a collapsed toggle's header `into`, as the key's merge:
 * one plan that deletes the seam from the header's end to `from`'s start,
 * the hidden body outside it (`del.range.hidden-body`). `from`'s children
 * take its slot, still displayed, and its content joins the header; a veto
 * refuses all of it. Nothing when the document refuses the merge (an island).
 */
const mergeIntoHeader = (edytor: Edytor, from: Block, into: Block, backward: boolean) => {
	const [end, start] = [into.lastText, from.firstText];
	if (!end || !start || !('writes' in edytor.facade.prepare.mergeBlocks(from.id, into.id))) return;
	const seam = { startText: end, yStart: end.length, endText: start, yEnd: 0 };
	const plan = () => prepareDeleteContent.call(edytor, { replace: true, selection: seam });
	if (backward) dispatchPlan(from, 'mergeBlockBackward', {}, plan, [from.parent]);
	else dispatchPlan(into, 'mergeBlockForward', {}, plan, [from.parent]);
};

/**
 * The line a forward merge into a collapsed toggle's header joins: `block`,
 * or for a container (a list) its first item's, descending as the
 * document's `mergeForward` does; the seam range then removes a container
 * left with no item.
 */
const firstLine = (block: Block): Block => {
	while (block.isContainer && block.children[0]) block = block.children[0];
	return block;
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

		const nextBlock = shown(currentBlock, 'blockAfter');
		if (nextBlock?.definition.void) {
			edytor.selection.selectBlocks(nextBlock);
			return;
		}

		if (nextBlock === currentBlock.closestNextBlock) currentBlock.mergeBlockForward();
		else if (nextBlock) mergeIntoHeader(edytor, firstLine(nextBlock), currentBlock, false);
		caretAt(edytor, startText, yStart);
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

/**
 * Backspace at the start of a catalogue kind other than its parent's default
 * (a bullet, a to-do, a heading) turns it into that default first, keeping
 * its content and children (`del.start.kind`, Notion); the next Backspace
 * merges or unnests. Structural kinds outside the catalogue (a `list-item`,
 * a `codeLine`) keep the structural path.
 */
const resetKindAtStart = (edytor: Edytor, snapshot: Attempt) => {
	const block = snapshot.startText?.parent;
	if (!snapshot.isAtStartOfBlock || !block?.convertible || !block.parent) return false;
	const type = edytor.defaultChild(block.parent);
	if (block.type === type || !edytor.kinds.some((row) => row.value.type === block.type)) {
		return false;
	}
	block.setBlock({ value: { type, data: {} } });
	caretAt(edytor, block.firstText, 0);
	return true;
};

const deleteContentBackward = (edytor: Edytor, snapshot: Attempt) => {
	const { startText, yStart } = snapshot;

	if (resetKindAtStart(edytor, snapshot)) return;

	// A table's cell keeps its caret at its start: nothing merges into or out of
	// a cell, and it never outdents (`table.merge`).
	const cell = startText?.parent;
	if (snapshot.isAtStartOfBlock && cell && edytor.facade.isTableCell(cell.id)) {
		edytor.selection.setAtTextOffset(startText!, 0);
		return;
	}

	if (snapshot.isAtStartOfBlock && snapshot.isFirstChildOfDocument && startText?.parent.isEmpty) {
		edytor.selection.setAtTextOffset(startText, 0);
		return;
	}

	if (!startText) {
		return;
	}

	if (snapshot.isAtStartOfBlock) {
		const { facade } = edytor;
		const column = startText.parent.parent;
		// A column's block never outdents (nothing but a column sits in a layout):
		// it merges, across columns in reading order (`layout.merge`).
		const inColumn = !!column && !column.isRoot && facade.isLayoutItem(column.id);
		if (snapshot.isNested && snapshot.isLastChild && !snapshot.islandRoot && !inColumn) {
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

		const block = startText.parent;
		// A column's first block joins the line before its column (and, in the first,
		// before its layout), as the document's merge does (`layout.merge`).
		const structure = (at: Block | null) =>
			inColumn &&
			block.index === 0 &&
			!!at &&
			(facade.isLayout(at.id) || facade.isLayoutItem(at.id));
		let previousBlock = shown(block, 'blockBefore');
		let closest = block.closestPreviousBlock;
		while (structure(previousBlock)) previousBlock = shown(previousBlock!, 'blockBefore');
		while (structure(closest)) closest = closest!.closestPreviousBlock;
		if (previousBlock?.definition.void) {
			edytor.selection.selectBlocks(previousBlock);
			return;
		}

		const previousText = previousBlock?.lastText;
		const offset = previousText?.length;
		if (previousBlock === closest) block.mergeBlockBackward();
		else if (previousBlock) mergeIntoHeader(edytor, block, previousBlock, true);
		if (typeof offset === 'number') caretAt(edytor, previousText, offset);
		// A list's first item lifts out of it: the caret stays at its start.
		else if (previousBlock === block.parent) caretAt(edytor, block.firstText, 0);
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
	// A block selection: every delete key (a word or line chord too) deletes
	// the blocks as Backspace does — `onDeleteSelectedBlocks` first, children
	// promoted (a drag or composition fragment is not a key).
	if (edytor.selection.selectedBlocks.size && !/^delete(ByDrag|ByComposition)$/.test(inputType)) {
		deleteSelectedBlocks(edytor);
		return;
	}
	// A selection: the document's range deletion (a forward one needs its text).
	if (!snapshot.isCollapsed) {
		if (!forward || snapshot.startText) deleteSelectedRange(edytor, { selection: snapshot });
		return;
	}
	if (inputType === 'deleteContentBackward') return deleteContentBackward(edytor, snapshot);
	if (inputType === 'deleteContentForward' || inputType === 'deleteContent')
		return deleteContentForward(edytor, snapshot);
	// A collapsed cut, drag or composition fragment deletes nothing.
	if (!/^delete(ByCut|ByDrag|ByComposition)$/.test(inputType))
		return deleteCollapsedUnit(edytor, snapshot);
};
