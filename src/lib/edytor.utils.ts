import { Text } from './text/text.svelte.js';
import type { Block } from './block/block.svelte.js';
import type { Edytor } from './edytor.svelte.js';
import { id } from './utils.js';

/** The two endpoints of a range, as the selection holds them. */
export type RangeEndpoints = {
	startText: Text | null;
	endText: Text | null;
	yStart: number;
	yEnd: number;
};

/** The text part and offset showing display offset `offset` of `block`. */
const textAt = (block: Block, offset: number): readonly [Text | null, number] => {
	let at = 0;
	for (const part of block.content) {
		if (!(part instanceof Text)) at += 1;
		else if (offset <= at + part.length) return [part, offset - at];
		else at += part.length;
	}
	return [block.lastText ?? null, block.lastText?.length ?? 0];
};

/**
 * Delete the selected range (or `selection`) through the document's prepared
 * range deletion (`del.range.*`; `replace`: the deletion half of a
 * replacement, `del.range.replace`) and answer the caret the op decided.
 */
export function deleteContentWithinSelection(
	this: Edytor,
	{
		replace = false,
		selection = this.selection.state
	}: { replace?: boolean; selection?: RangeEndpoints }
): readonly [Text | null, number] {
	const { startText, endText, yStart, yEnd } = selection;
	if (!startText || !endText) return [startText, yStart];
	const at = (text: Text, offset: number) => ({
		block: text.parent.id,
		offset: text.parent.partOffsetOf(text) + offset
	});
	const prepare = replace ? this.facade.prepare.replaceRange : this.facade.prepare.deleteRange;
	const plan = prepare(at(startText, yStart), at(endText, yEnd), id('b'));
	if (!('writes' in plan) || !plan.at) return [startText, yStart];
	// Undo restores the selection current before the delete: snapshot it before
	// the write (unless the command queued one) by text ids, paths and offsets —
	// undo restores exactly this structure. No anchors: they would bind atoms the
	// delete removes (undo re-creates them) or, minted after it, merged atoms.
	if (!this.selection.nextUndoSelectionSnapshot)
		this.selection.queueNextUndoSelectionSnapshot({ startAnchor: null, endAnchor: null });
	this.facade.apply(plan);
	this.flushMirror();
	const block = this.idToBlock.get(plan.at.block);
	if (!block) return [null, 0];
	block.normalizeContent();
	block.parent?.normalizeChildren();
	return textAt(block, plan.at.offset);
}
