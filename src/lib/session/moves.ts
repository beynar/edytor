import type { Block } from '$lib/block/block.svelte.js';
import { dispatchPlan, type BlockBeside } from '$lib/block/block.utils.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { revealing } from '$lib/selection/replaceSelection.js';
import type { Prepared } from '$lib/crdt/edytor-doc.js';

/**
 * Where a move places the blocks relative to its target: `before`, `after`,
 * `inside` (its last child), or `left`/`right` of it, side by side
 * (`prepare.placeBeside`, `layout.place-beside`: a new column of the layout
 * the target is in, else a new layout wrapping the target).
 */
export type BlockMovePosition = 'before' | 'after' | 'inside' | 'left' | 'right';

/** The positions that place the blocks beside the target, in a layout. */
const BESIDE: readonly BlockMovePosition[] = ['left', 'right'];
const isBeside = (position: BlockMovePosition): position is 'left' | 'right' =>
	BESIDE.includes(position);

/**
 * One relative step (D-5): `up`/`down` pass the previous/next sibling, never
 * entering its children, and past the first/last sibling leave the parent
 * (before/after it; a layout's column: the layout, `layout.fits`); `in` =
 * last child of the previous sibling; `out` =
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
	// Past a column's first or last block the step leaves its layout, the
	// keyboard's way out of a column (nothing but a column sits in a layout).
	const leaves = outer && edytor.facade.isLayoutItem(outer.id) ? outer.parent : outer;
	const beyond = leaves?.isRoot ? null : leaves;
	const step = {
		up: [first.previousBlock ?? beyond, 'before'],
		down: [last.nextBlock ?? beyond, 'after'],
		in: [first.previousBlock, 'inside'],
		out: [outer, 'after']
	}[request.direction] as [Block | null | undefined, BlockMovePosition] | undefined;
	return step?.[0] ? { blocks, target: step[0], position: step[1] } : null;
};

const POSITIONS: readonly BlockMovePosition[] = ['before', 'after', 'inside', ...BESIDE];

/**
 * The move op's payload, or `null` when refused: a well-formed request, then
 * the document's one structural answer (`canPlace`, R5 — the predicate the
 * move op applies at execution; an `out` step asks the outdent plan, which
 * places the blocks as the kind they take there: a paragraph outdented into
 * a list is its item, DR-crdt-2; `left`/`right` ask the beside plan,
 * `placeBeside`). Extensions may still veto the command.
 */
const destination = (edytor: Edytor, request: BlockMoveRequest) => {
	const move = placement(edytor, request);
	if (!move || edytor.readonly || !POSITIONS.includes(move.position)) return null;
	const { blocks, target, position } = move;
	const ids = blocks.map((block) => block.id);
	if (
		target.edytor !== edytor ||
		!target.isInTree ||
		target.isRoot ||
		blocks.some((block) => block.edytor !== edytor || block === target)
	)
		return null;
	// Beside: the document resolves the target (its outermost block below the
	// root or a column) and owns every refusal (D2, fits, its own subtree).
	if (isBeside(position)) {
		return 'writes' in edytor.facade.prepare.placeBeside(ids, target.id, position)
			? { blocks, path: target.path, beside: { target, side: position } }
			: null;
	}
	// Inside a container they are no items of: under its last item (Tab after a list, ZW-01).
	const nest = () => edytor.idToBlock.get(edytor.facade.nestParent(ids, target.id));
	const parent = position === 'inside' ? (nest() ?? target) : target.parent;
	const placeable = (to: Block) =>
		'direction' in request && request.direction === 'out'
			? 'writes' in edytor.facade.prepare.unNestBlocks(ids)
			: edytor.facade.canPlace(ids, to.isRoot ? null : to.id);
	if (!parent || !placeable(parent)) return null;
	const at =
		position === 'inside' ? parent.children.length : target.index + (position === 'after' ? 1 : 0);
	// The document counts the destination's children without the moved blocks.
	const index = at - blocks.filter((block) => block.parent === parent && block.index < at).length;
	return { blocks, path: [...(parent.isRoot ? [] : parent.path), index] };
};

/**
 * An `in` or `out` step over siblings as its runs of adjacent ones (GX-05):
 * siblings with another block between them move apart, as Tab and
 * Shift+Tab do (DR-behavior-1), so the step never reorders the text. Any
 * other request is one part.
 */
const parts = (edytor: Edytor, request: BlockMoveRequest): BlockMoveRequest[] => {
	if (!('direction' in request) || !['in', 'out'].includes(request.direction)) return [request];
	const { blocks, direction } = request;
	if (blocks.some((block) => block.parent !== blocks[0]!.parent)) return [request];
	const runs: Block[][] = [];
	for (const block of [...new Set(blocks)].toSorted(edytor.compareBlocks)) {
		const run = runs.at(-1);
		if (run?.at(-1)!.nextBlock === block) run.push(block);
		else runs.push([block]);
	}
	return runs.map((run) => ({ blocks: run, direction }));
};

/** Whether the move is allowed: for runs (`parts`), whether one of them may move. */
export const canMoveBlocks = (edytor: Edytor, request: BlockMoveRequest): boolean =>
	parts(edytor, request).some((part) => destination(edytor, part) !== null);

/**
 * One move command (`moveBlock` for one block, `moveBlocks` for a group; an
 * `out` step plans the outdent, `unNestBlocks`): identity kept, one undo
 * step (the dispatcher cuts before it, R7); `[]` when refused or vetoed.
 * Runs (`parts`) move one by one, a run that cannot move staying, as Tab
 * does (`dispatcher.each`). A closed toggle the blocks land in, or that
 * adopts blocks, opens (`revealing`): every caller — keys, drops, menus,
 * the public command — shows the moved blocks. The view announces what
 * moved (`announcer.moved`).
 */
export const moveBlocks = (edytor: Edytor, request: BlockMoveRequest): Block[] => {
	const runs = parts(edytor, request);
	const moved = revealing(request.blocks, () =>
		runs.length > 1
			? edytor.dispatcher
					.each('moveBlocks', runs, (run) => place(edytor, run))
					.flatMap((moved) => moved ?? [])
			: place(edytor, runs[0] ?? request)
	);
	// Said to assistive technology: what moved, and where (`session/announcer`).
	edytor.announcer.moved(request, moved);
	return moved;
};

const place = (edytor: Edytor, request: BlockMoveRequest): Block[] => {
	const move = destination(edytor, request);
	if (!move) {
		// Refused before any command ran: `last` still reports it (commands#results).
		const operation = request.blocks.length > 1 ? 'moveBlocks' : 'moveBlock';
		edytor.dispatcher.last = { operation, status: request.blocks.length ? 'refused' : 'noop' };
		return [];
	}
	const [first, ...rest] = move.blocks;
	if (move.beside) {
		const { beside } = move;
		// The beside plan, from the payload hooks leave: a new column, or a new
		// layout wrapping the target; the sources cleaned in the same plan.
		const ids = move.blocks.map((block) => block.id);
		const besides = (payload: { beside?: BlockBeside }): Prepared =>
			payload.beside
				? edytor.facade.prepare.placeBeside(ids, payload.beside.target.id, payload.beside.side)
				: { status: 'refused', ids: [] };
		const touched = [
			...new Set([...move.blocks.map((block) => block.parent), beside.target.parent])
		];
		const applied = rest.length
			? dispatchPlan(first!, 'moveBlocks', move, besides, touched)
			: dispatchPlan(first!, 'moveBlock', { path: move.path, beside }, besides, touched);
		return applied ? move.blocks : [];
	}
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
