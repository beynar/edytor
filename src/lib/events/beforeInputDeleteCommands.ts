import type { Edytor } from '$lib/edytor.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import { deleteSelectedBlocks, deleteSelectedRange } from '$lib/selection/replaceSelection.js';
import { shown, viewOf } from '$lib/selection/visibility.js';
import { blockSelection } from '$lib/session/selection.js';
import { INTENTS, caretAt, type Attempt } from '$lib/session/attempt.js';
import {
	getNextGraphemeEnd,
	getNextWordEndOffset,
	getPreviousGraphemeStart,
	getPreviousWordStartOffset
} from '$lib/text/wordBoundary.js';

/**
 * Merge `from` into a collapsed toggle's header `into`, as the key's merge:
 * one plan that deletes the seam from the header's end to `from`'s start,
 * the hidden body outside it (`del.range.hidden-body`). `from`'s children
 * take its slot, still displayed, and its content joins the header; a veto
 * refuses all of it. Nothing when the document refuses the merge (an island).
 */
const mergeIntoHeader = (edytor: Edytor, from: Block, into: Block, backward: boolean) => {
	const { facade, dispatcher } = edytor;
	const [end, start] = [into.lastText, from.firstText];
	if (!end || !start || !('writes' in facade.prepare.mergeBlocks(from.id, into.id))) return;
	const seam = () =>
		facade.prepare.replaceRange(
			{ block: into.id, offset: end.segStart + end.length },
			{ block: from.id, offset: start.segStart },
			viewOf(edytor)
		);
	if (backward) dispatcher.plan('mergeBackward', [from.id], seam, from);
	else dispatcher.plan('mergeForward', [into.id], seam, into);
};

/**
 * Delete at the caret's text edge, one character inside it: the inline
 * atom beside the edge, else the character, the caret staying at its side.
 */
export const deleteInText = (
	edytor: Edytor,
	text: Text,
	yStart: number,
	back: boolean,
	atEdge: boolean
) => {
	const { content } = text.parent;
	if (!atEdge) {
		// One character is one grapheme, at the caret as it is now (anchored: a
		// peer's edit since the occurrence moved it).
		const value = text.stringContent;
		const at = edytor.selection.textRange().yStart;
		const [start, end] = back
			? [getPreviousGraphemeStart(value, at), at]
			: [at, getNextGraphemeEnd(value, at)];
		if (end > start) edytor.deleteText(text.parent.id, text.segStart + start, end - start);
		return edytor.selection.selectText(text, back ? start : yStart);
	}
	const index = content.indexOf(text) + (back ? -1 : 1);
	const before = back ? content.at(index - 1) : text;
	// Read before the removal joins the texts beside the atom.
	const offset = back && before instanceof Text ? before.length : yStart;
	const atom = content.at(index);
	if (atom instanceof InlineBlock) edytor.removeInline(text.parent.id, atom.id);
	if (before instanceof Text) edytor.selection.selectText(before, offset);
};

const deleteContentForward = (edytor: Edytor, snapshot: Attempt) => {
	const { startText, yStart } = snapshot;
	if (!startText) return;
	const current = startText.parent;
	// At a live composition's region the preview stays (the IME owns it).
	const keep =
		edytor.composition.covers(startText, yStart) ||
		(snapshot.projection.isAtEndOfBlock && current.definition.void);
	if (keep || !snapshot.projection.isAtEndOfBlock)
		return keep
			? edytor.selection.selectText(startText, yStart)
			: deleteInText(edytor, startText, yStart, false, snapshot.projection.isAtEndOfText);
	const next = shown(current, 'blockAfter');
	if (next?.definition.void) return edytor.selection.select(blockSelection([next.id]));
	if (next === current.closestNextBlock) edytor.mergeForward(current.id);
	else if (next) {
		// A forward merge into a collapsed toggle's header joins its first line:
		// a container's (a list's) first item, as the document's `mergeForward`.
		let line = next;
		while (line.isContainer && line.children[0]) line = line.children[0];
		mergeIntoHeader(edytor, line, current, false);
	}
	caretAt(edytor, startText, yStart);
};

const deleteContentBackward = (edytor: Edytor, snapshot: Attempt) => {
	const { startText, yStart } = snapshot;
	const block = startText?.parent;
	if (!block) return;
	if (!snapshot.projection.isAtStartOfBlock)
		return deleteInText(edytor, startText, yStart, true, snapshot.projection.isAtStartOfText);
	const { facade, root } = edytor;
	const parent = block.parent;
	// At the start of a catalogue kind other than its parent's default (a
	// bullet, a to-do, a heading), it turns into that default first, keeping
	// its content and children (`del.start.kind`, Notion); structural kinds
	// outside the catalogue (a `list-item`, a `codeLine`) keep the structural path.
	const type = parent && edytor.defaultChild(parent);
	if (
		block.convertible &&
		type &&
		block.type !== type &&
		edytor.kinds.some((row) => row.value.type === block.type)
	) {
		edytor.setBlock(block.id, { type, data: {} });
		return caretAt(edytor, block.firstText, 0);
	}
	const at = facade.positionOf(block.id);
	// A table's cell keeps its caret at its start: nothing merges into or out
	// of a cell, and it never outdents (`table.merge`); nor does the
	// document's first block, empty.
	if (facade.isTableCell(block.id) || (block.isEmpty && at?.parent === null && at.index === 0))
		return edytor.selection.selectText(startText, 0);
	const island = edytor.idToBlock.get(edytor.selection.projection.islandRoot ?? '');
	// A column's block never outdents (nothing but a column sits in a layout):
	// it merges, across columns in reading order (`layout.merge`).
	const inColumn = !!parent && !parent.isRoot && facade.isLayoutItem(parent.id);
	const last = !!at && at.index === facade.childrenIds(at.parent).length - 1;
	if (parent !== root && last && !island && !inColumn) {
		if (edytor.unNestBlock(block.id).status === 'applied')
			edytor.selection.selectText(block.firstText, 0);
		return;
	}
	if (island && island.children.length === 1)
		return edytor.selection.select(blockSelection([island.id]));
	if (island && block.index === 0) return;
	// A column's first block joins the line before its column (and, in the first,
	// before its layout), as the document's merge does (`layout.merge`).
	const structure = (b: Block | null) =>
		inColumn && block.index === 0 && !!b && (facade.isLayout(b.id) || facade.isLayoutItem(b.id));
	let previous = shown(block, 'blockBefore');
	let closest = block.closestPreviousBlock;
	while (structure(previous)) previous = shown(previous!, 'blockBefore');
	while (structure(closest)) closest = closest!.closestPreviousBlock;
	if (previous?.definition.void) return edytor.selection.select(blockSelection([previous.id]));
	const previousText = previous?.lastText;
	const offset = previousText?.length;
	if (previous === closest) edytor.mergeBackward(block.id);
	else if (previous) mergeIntoHeader(edytor, block, previous, true);
	if (offset !== undefined) caretAt(edytor, previousText, offset);
	// A list's first item lifts out of it: the caret stays at its start.
	else if (previous === parent) caretAt(edytor, block.firstText, 0);
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
 * The model command of a delete intent. A block selection: every delete key
 * (a word or line chord too) deletes the blocks as Backspace does —
 * `onDeleteSelectedBlocks` first, children promoted (a drag or composition
 * fragment is not a key). A range: the document's range deletion (a forward
 * one needs its text). A collapsed caret: the intent's unit (`del.unit.*`),
 * whose extent the model owns — a character; a word run from the caret's own
 * text, the caret's line to either side, or the whole block, deleted as one
 * range, the caret at its start; a cut, drag or composition fragment deletes
 * nothing. A unit with nothing of the caret's own text in its direction
 * (next to an inline atom, at the block's edge) is the neighbour, deleted
 * like a character (atom, merge, unnest).
 */
export const runBeforeInputDeleteCommand = (edytor: Edytor, snapshot: Attempt) => {
	// The Android post-delete snap-back's evidence (a named projector rule):
	// only an actual delete arms it, never a navigational jump.
	edytor.projector.deleted(snapshot);
	const { inputType, startText: text, yStart } = snapshot;
	const { dir, unit } = INTENTS[inputType] ?? {};
	const back = !unit || dir === 'back';
	if (edytor.selection.selectedBlocks.size && !/^delete(ByDrag|ByComposition)$/.test(inputType))
		return deleteSelectedBlocks(edytor);
	if (!snapshot.isCollapsed) {
		if (back || text) deleteSelectedRange(edytor, { selection: snapshot });
		return;
	}
	if (!unit || !text) return;
	const byChar = () =>
		back ? deleteContentBackward(edytor, snapshot) : deleteContentForward(edytor, snapshot);
	if (unit === 'char') return byChar();
	const [first, last] = [text.parent.firstText!, text.parent.lastText!];
	const word = back
		? getPreviousWordStartOffset(text.stringContent, yStart)
		: getNextWordEndOffset(text.stringContent, yStart);
	const edge: [Text, number] =
		unit === 'word' ? [text, word] : lineEdge(text, yStart, back, unit === 'soft');
	const [from, to]: [Text, number][] =
		unit === 'line'
			? [
					[first, 0],
					[last, last.length]
				]
			: back
				? [edge, [text, yStart]]
				: [[text, yStart], edge];
	if (unit !== 'line' && from[0] === to[0] && from[1] === to[1]) return byChar();
	const at = from[0].segStart + from[1];
	edytor.deleteText(text.parent.id, at, to[0].segStart + to[1] - at);
	edytor.selection.selectText(...from);
};
