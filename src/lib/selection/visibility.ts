/**
 * What the view shows (a Surface fact), and the one rule every path reads
 * from it (Notion): a block hidden by view state — a closed toggle's body, a
 * `hidden` subtree — is never in a range, and a closed toggle is one unit.
 * Editor code imports the predicate and the walk (`hidden`, `shown`; the
 * selection re-exposes them to extensions); the document's range and flow
 * ops ask it through `viewOf`; copy, marks and the toolbar through
 * `rangeCovers`.
 */
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { RangeEndpoints } from '$lib/edytor.utils.js';
import type { Text } from '$lib/text/text.svelte.js';

/** Content hidden by view state: a collapsed toggle's body, a `hidden` subtree. */
export const HIDDEN = '[hidden], details:not([open]) > :not(summary)';

/**
 * Whether `block` sits in a collapsed toggle's body or a `hidden` subtree.
 * With `removed`, whether it stays hidden once those blocks are deleted: a
 * deleted closed toggle's children take its place, shown.
 */
export const hidden = (block: Block, removed?: ReadonlySet<Block>): boolean => {
	const hider = block.node?.closest(HIDDEN);
	if (!hider || !removed?.size) return !!hider;
	// What hides: a `hidden` element itself, else the closed `<details>` it sits in
	// (which a snippet may render children directly under, YW-12).
	const cause = hider.matches('[hidden]') ? hider : hider.parentElement!;
	let owner: Block | undefined = block;
	while (owner && !owner.node?.contains(cause)) owner = owner.parent;
	return !owner || !removed.has(owner) || hidden(owner, removed);
};

/**
 * The nearest block before or after `block` in document order that is not
 * hidden: before the block after a collapsed toggle comes its header; after
 * its header, the block after it. `removed` blocks are skipped, and read as
 * gone (see {@link hidden}).
 */
export const shown = (
	block: Block,
	step: 'blockBefore' | 'blockAfter',
	{ sealed, removed }: { sealed?: boolean; removed?: ReadonlySet<Block> } = {}
) => {
	const policy = sealed ? { sealed } : undefined;
	let next = block.edytor[step](block, policy);
	while (next && (removed?.has(next) || hidden(next, removed)))
		next = block.edytor[step](next, policy);
	return next;
};

/**
 * What the view knows that the document does not, for the document's range
 * and flow ops: what it hides (`del.range.hidden-body`: a closed toggle's
 * body is not in a range, and a split of its header leaves it there,
 * `flow.split`; with `removed`, whether a block stays hidden once those
 * blocks go), and a list's flat item kind (`itemKind`: a pasted numbered
 * item landing in an `ordered-list` is its item, AW-08).
 */
export const viewOf = (edytor: Edytor) => {
	const blocks = new WeakMap<ReadonlySet<string>, Set<Block>>();
	const blocksOf = (ids: ReadonlySet<string>) => {
		if (!blocks.has(ids))
			blocks.set(ids, new Set([...ids].flatMap((id) => edytor.idToBlock.get(id) ?? [])));
		return blocks.get(ids)!;
	};
	return {
		hidden: (id: string, removed?: ReadonlySet<string>) => {
			const block = edytor.idToBlock.get(id);
			return !!block && hidden(block, removed && blocksOf(removed));
		},
		itemKind: (parent: string) => edytor.idToBlock.get(parent)?.definition.itemKind
	};
};

/** A text range's endpoints and texts, as the selection (or an attempt's snapshot) holds them. */
type TextRange = RangeEndpoints & { texts: Text[] };

/**
 * Whether a text range covers `block` (`del.range.hidden-body`): a block the
 * view shows does; a hidden one exactly when deleting the range deletes it —
 * with the range member that hides it, any member but the head, and the head
 * too when the range starts at its start (it dies with the range). A
 * replacement (`replace`) keeps the head and its body. The live block
 * selection covers exactly its members (`sel.blocks.exact`, FX-07): its
 * delete keeps a closed toggle's body. Copy, cut, delete, marks and the
 * toolbar share this one answer.
 */
export const rangeCovers = (
	edytor: Edytor,
	range: TextRange = edytor.selection.state,
	{ replace = false } = {}
) => {
	const { selection } = edytor;
	if (range === selection.state && selection.value.kind === 'blocks')
		return (block: Block) => selection.selectedBlocks.has(block);
	const members = new Set(range.texts.map((text) => text.parent));
	const head = range.startText?.parent;
	const headDies = !replace && range.startText?.segStart === 0 && range.yStart === 0;
	return (block: Block) => {
		if (!hidden(block)) return true;
		let hider = block.parent;
		while (hider && hidden(hider)) hider = hider.parent;
		return !!hider && members.has(hider) && (hider !== head || headDies);
	};
};

/**
 * The selected span of each text a range covers ({@link rangeCovers}), in
 * document order, so marks, the toolbar's state and the marks typing over a
 * range inherits (`replace`) reach what the range's delete would.
 */
export const selectedTextSpans = (
	edytor: Edytor,
	range: TextRange = edytor.selection.state,
	options: { replace?: boolean } = {}
) => {
	const covers = rangeCovers(edytor, range, options);
	return range.texts.flatMap((text) =>
		covers(text.parent)
			? [
					{
						text,
						start: text === range.startText ? range.yStart : 0,
						end: text === range.endText ? range.yEnd : text.length
					}
				]
			: []
	);
};
