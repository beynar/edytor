import type { Text } from './text/text.svelte.js';
import type { Block } from './block/block.svelte.js';
import type { Edytor } from './edytor.svelte.js';
import type { Flow, FlowTarget } from './crdt/flow.js';
import type { Prepared } from './crdt/edytor-doc.js';
import { normalizeChildren, normalizeContent } from './block/block.utils.js';

/** The two endpoints of a range, as the selection holds them. */
export type RangeEndpoints = {
	startText: Text | null;
	endText: Text | null;
	yStart: number;
	yEnd: number;
};

const REFUSED: Prepared = { status: 'refused', ids: [] };

type At = { block: string; offset: number };

/**
 * Apply a prepared op and answer the caret it reports (`null` when it planned
 * none); the caret's block and its parent are normalized in its transaction.
 */
const applyAt = (edytor: Edytor, plan: Prepared): At | null => {
	if (!('writes' in plan) || !plan.at) return null;
	const { facade, dispatcher } = edytor;
	facade.apply(plan);
	dispatcher.request(plan.at.block, normalizeContent);
	dispatcher.request(facade.parentOf(plan.at.block) ?? 'root', normalizeChildren);
	return plan.at;
};

/** The caret an op answered, as a text handle and offset. */
export function caretOf(this: Edytor, at: At | null | undefined): readonly [Text | null, number] {
	const hit = at && this.idToBlock.get(at.block)?.textAtOffset(at.offset);
	return hit ? [hit.text, hit.offset] : [null, 0];
}

type RangeDelete = { replace?: boolean; selection?: RangeEndpoints };

/** The document's range deletion (`del.range.*`; `replace`: the deletion half of a replacement). */
export function prepareDeleteContent(this: Edytor, { replace = false, selection }: RangeDelete) {
	const { startText, endText, yStart, yEnd } = selection ?? this.selection.state;
	if (!startText || !endText) return REFUSED;
	const at = (text: Text, offset: number) => ({
		block: text.parent.id,
		offset: text.segStart + offset
	});
	const prepare = replace ? this.facade.prepare.replaceRange : this.facade.prepare.deleteRange;
	return prepare(at(startText, yStart), at(endText, yEnd), viewOf(this));
}

/**
 * What the view hides, for the document's range and flow ops
 * (`del.range.hidden-body`): a closed toggle's body is not in a range, and a
 * split of its header leaves it there (`flow.split`). With `removed`,
 * whether a block stays hidden once those blocks go.
 */
export function viewOf(edytor: Edytor) {
	const blocks = new WeakMap<ReadonlySet<string>, Set<Block>>();
	const blocksOf = (ids: ReadonlySet<string>) => {
		if (!blocks.has(ids))
			blocks.set(ids, new Set([...ids].flatMap((id) => edytor.idToBlock.get(id) ?? [])));
		return blocks.get(ids)!;
	};
	const hidden = (id: string, removed?: ReadonlySet<string>) => {
		const block = edytor.idToBlock.get(id);
		return !!block && edytor.selection.hidden(block, removed && blocksOf(removed));
	};
	return { hidden };
}

/**
 * Delete the selected range (or `selection`) through the document's prepared
 * range deletion and answer the caret the op decided.
 */
export function deleteContentWithinSelection(
	this: Edytor,
	payload: RangeDelete,
	plan = prepareDeleteContent.call(this, payload)
): At | null {
	return applyAt(this, plan);
}

/** The range deletion's caret; refused at preparation: the range's start; vetoed: none. */
export function rangeCaret(this: Edytor, at: At | null | undefined, payload: RangeDelete) {
	if (at === undefined) return undefined;
	const { startText, yStart } = payload.selection ?? this.selection.state;
	return at ? caretOf.call(this, at) : ([startText, yStart] as const);
}

type FlowInsert = { flow: Flow; target: FlowTarget };

export function prepareFlow(this: Edytor, { flow, target }: FlowInsert) {
	return this.facade.prepare.insertFlow(target, flow, viewOf(this));
}

/** Place an admitted flow at `target` (`flow.*`) and answer the caret the op decided. */
export function insertFlow(
	this: Edytor,
	payload: FlowInsert,
	plan = prepareFlow.call(this, payload)
): At | null {
	return applyAt(this, plan);
}

type BlocksDelete = { blocks: Block[] };

export function prepareDeleteBlocks(this: Edytor, { blocks }: BlocksDelete) {
	return this.facade.prepare.deleteBlocks(blocks.map((block) => block.id));
}

/** Delete a block selection (one document plan; nested members ride their ancestor). */
export function deleteBlocks(
	this: Edytor,
	{ blocks }: BlocksDelete,
	plan = prepareDeleteBlocks.call(this, { blocks })
): boolean {
	if (!('writes' in plan)) return false;
	const parents = new Set(blocks.map((block) => block.parent));
	this.facade.apply(plan);
	for (const parent of parents) parent?.normalizeChildren();
	return true;
}
