import { Text } from './text/text.svelte.js';
import type { Block } from './block/block.svelte.js';
import type { Edytor } from './edytor.svelte.js';
import { id } from './utils.js';
import type { Flow, FlowTarget } from './crdt/flow.js';
import type { Prepared } from './crdt/edytor-doc.js';

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

const REFUSED: Prepared = { status: 'refused', ids: [] };

/** Apply a prepared op and answer the caret it reports; `null` when it planned none. */
const applyAt = (edytor: Edytor, plan: Prepared): readonly [Text | null, number] | null => {
	if (!('writes' in plan) || !plan.at) return null;
	edytor.facade.apply(plan);
	edytor.flushMirror();
	const block = edytor.idToBlock.get(plan.at.block);
	if (!block) return [null, 0];
	block.normalizeContent();
	block.parent?.normalizeChildren();
	return textAt(block, plan.at.offset);
};

type RangeDelete = { replace?: boolean; selection?: RangeEndpoints };

/** The document's range deletion (`del.range.*`; `replace`: the deletion half of a replacement). */
export function prepareDeleteContent(this: Edytor, { replace = false, selection }: RangeDelete) {
	const { startText, endText, yStart, yEnd } = selection ?? this.selection.state;
	if (!startText || !endText) return REFUSED;
	const at = (text: Text, offset: number) => ({
		block: text.parent.id,
		offset: text.parent.partOffsetOf(text) + offset
	});
	const prepare = replace ? this.facade.prepare.replaceRange : this.facade.prepare.deleteRange;
	return prepare(at(startText, yStart), at(endText, yEnd), id('b'));
}

/**
 * Delete the selected range (or `selection`) through the document's prepared
 * range deletion and answer the caret the op decided.
 */
export function deleteContentWithinSelection(
	this: Edytor,
	payload: RangeDelete,
	plan = prepareDeleteContent.call(this, payload)
): readonly [Text | null, number] {
	const { startText, yStart } = payload.selection ?? this.selection.state;
	// Undo restores the selection current before the delete: snapshot it before
	// the write (unless the command queued one) by text ids, paths and offsets —
	// undo restores exactly this structure. No anchors: they would bind atoms the
	// delete removes (undo re-creates them) or, minted after it, merged atoms.
	if ('writes' in plan && plan.at && !this.selection.nextUndoSelectionSnapshot)
		this.selection.queueNextUndoSelectionSnapshot({ startAnchor: null, endAnchor: null });
	return applyAt(this, plan) ?? [startText, yStart];
}

type FlowInsert = { flow: Flow; target: FlowTarget };

export function prepareFlow(this: Edytor, { flow, target }: FlowInsert) {
	return this.facade.prepare.insertFlow(target, flow);
}

/** Place an admitted flow at `target` (`flow.*`) and answer the caret the op decided. */
export function insertFlow(
	this: Edytor,
	payload: FlowInsert,
	plan = prepareFlow.call(this, payload)
): readonly [Text | null, number] {
	return applyAt(this, plan) ?? [null, 0];
}

type BlocksDelete = { blocks: Block[]; snapshot?: boolean };

export function prepareDeleteBlocks(this: Edytor, { blocks }: BlocksDelete) {
	return this.facade.prepare.deleteBlocks(blocks.map((block) => block.id));
}

/**
 * Delete a block selection (one document plan; nested members ride their
 * ancestor). `snapshot`: queue the undo selection snapshot of the selected
 * blocks before the write.
 */
export function deleteBlocks(
	this: Edytor,
	{ blocks, snapshot = false }: BlocksDelete,
	plan = prepareDeleteBlocks.call(this, { blocks })
): boolean {
	if (!('writes' in plan)) return false;
	if (snapshot)
		this.selection.queueNextUndoSelectionSnapshot({
			selectedBlockIds: blocks.map((block) => block.id),
			selectedBlockPaths: blocks.map((block) => [...block.path])
		});
	const parents = new Set(blocks.map((block) => block.parent));
	this.facade.apply(plan);
	this.flushMirror();
	for (const parent of parents) parent?.normalizeChildren();
	return true;
}
