import type { Block } from '$lib/block/block.svelte.js';
import { dispatchPlan } from '$lib/block/block.utils.js';
import type { Edytor } from '$lib/edytor.svelte.js';

export type BlockMovePosition = 'before' | 'after' | 'inside';

/**
 * One relative step (D-5): `up`/`down` pass the previous/next sibling, never
 * entering its children, and past the first/last sibling leave the parent
 * (before/after it); `in` = last child of the previous sibling; `out` =
 * after the parent, the siblings after the last moved block becoming its
 * children (the document's outdent, `unNestBlocks`).
 */
export type BlockMoveDirection = 'up' | 'down' | 'in' | 'out';

export type BlockMoveRequest = {
	/** Blocks are placed in this order (a relative step keeps document order). */
	blocks: Block[];
} & ({ target: Block; position: BlockMovePosition } | { direction: BlockMoveDirection });

/** A relative step as its (target, position); a group must be siblings. */
const placement = (edytor: Edytor, request: BlockMoveRequest) => {
	if (!('direction' in request)) return request;
	const blocks = request.blocks.toSorted(edytor.compareBlocks);
	const [first, last] = [blocks[0], blocks.at(-1)!];
	const parent = first?.parent;
	if (!parent || blocks.some((block) => block.parent !== parent)) return null;
	const outer = parent.isRoot ? null : parent;
	const step = {
		up: [first.previousBlock ?? outer, 'before'],
		down: [last.nextBlock ?? outer, 'after'],
		in: [first.previousBlock, 'inside'],
		out: [outer, 'after']
	}[request.direction] as [Block | null | undefined, BlockMovePosition] | undefined;
	return step?.[0] ? { blocks, target: step[0], position: step[1] } : null;
};

/**
 * The move op's payload, or `null` when refused: a well-formed request, then
 * the document's one structural answer (`canPlace`, R5 — the predicate the
 * move op applies at execution). Extensions may still veto the command.
 */
const destination = (edytor: Edytor, request: BlockMoveRequest) => {
	const move = placement(edytor, request);
	if (!move || edytor.readonly || !['before', 'after', 'inside'].includes(move.position))
		return null;
	const { blocks, target, position } = move;
	const parent = position === 'inside' ? target : target.parent;
	if (
		!parent ||
		target.edytor !== edytor ||
		!target.isInTree ||
		target.isRoot ||
		blocks.some((block) => block.edytor !== edytor || block === target) ||
		!edytor.facade.canPlace(
			blocks.map((block) => block.id),
			parent.isRoot ? null : parent.id
		)
	)
		return null;
	const at =
		position === 'inside' ? parent.children.length : target.index + (position === 'after' ? 1 : 0);
	// The document counts the destination's children without the moved blocks.
	const index = at - blocks.filter((block) => block.parent === parent && block.index < at).length;
	return { blocks, path: [...(parent.isRoot ? [] : parent.path), index] };
};

export const canMoveBlocks = (edytor: Edytor, request: BlockMoveRequest): boolean =>
	destination(edytor, request) !== null;

/**
 * One move command (`moveBlock` for one block, `moveBlocks` for a group; an
 * `out` step plans the outdent, `unNestBlocks`): identity kept, one undo
 * step (the dispatcher cuts before it, R7); `[]` when refused or vetoed.
 */
export const moveBlocks = (edytor: Edytor, request: BlockMoveRequest): Block[] => {
	const move = destination(edytor, request);
	if (!move) return [];
	const [first, ...rest] = move.blocks;
	if ('direction' in request && request.direction === 'out') {
		// The outdent plan: the siblings after the last block follow it.
		const ids = move.blocks.map((block) => block.id);
		const outdent = () => edytor.facade.prepare.unNestBlocks(ids);
		const touched = [first!.parent, first!.parent?.parent, move.blocks.at(-1)];
		const applied = rest.length
			? dispatchPlan(first!, 'moveBlocks', move, outdent, touched)
			: dispatchPlan(first!, 'moveBlock', { path: move.path }, outdent, touched);
		return applied ? move.blocks : [];
	}
	if (rest.length) return first!.moveBlocks(move) ?? [];
	const moved = first!.moveBlock(move);
	return moved ? [moved] : [];
};
