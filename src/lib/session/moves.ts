import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { OpResult } from '$lib/crdt/edytor-doc.js';

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
 * One relative step: `up`/`down` pass the previous/next sibling, never
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
 * The view's nesting rule (`allowNesting`, off by default): whether a user
 * gesture may place `blocks` under `parent`. With nesting off, blocks land
 * only at the root or in a block made to hold children — a container (a
 * list, a column, a toggle's or a callout's body: `isContainer`, the kind's
 * `container`), an island (a code block's lines) — or stay under the parent
 * they already have (a document holding nested blocks still edits them).
 * Every move (`destination`: keys, drops, menus, `edytor.move`) and every
 * new block a drop places (`canPlaceNew`) reads it.
 */
export const nestsInto = (edytor: Edytor, parent: Block, blocks: readonly Block[] = []) =>
	edytor.allowNesting ||
	parent.isRoot ||
	parent.isContainer ||
	!!parent.definition.container ||
	edytor.facade.isIsland(parent.id) ||
	(blocks.length > 0 && blocks.every((block) => block.parent === parent));

/**
 * The document write a move request is, or `null` when refused: a
 * well-formed request, then the document's one structural answer
 * (`canPlace` — the predicate the move applies at execution; an `out` step
 * asks the outdent plan, which places the blocks as the kind they take
 * there: a paragraph outdented into a list is its item; `left`/`right` ask
 * the beside plan, `placeBeside`). Extensions may still veto it.
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
	// root or a column) and owns every refusal (fits, its own subtree).
	if (isBeside(position)) {
		return 'writes' in edytor.facade.prepare.placeBeside(ids, target.id, position)
			? { blocks, write: () => edytor.placeBeside(ids, target.id, position) }
			: null;
	}
	// Inside a container they are no items of: under its last item (Tab after a list).
	const nest = () => edytor.idToBlock.get(edytor.facade.nestParent(ids, target.id));
	const parent = position === 'inside' ? (nest() ?? target) : target.parent;
	// The outdent plan: the siblings after the last block follow it.
	if ('direction' in request && request.direction === 'out')
		return 'writes' in edytor.facade.prepare.unNestBlocks(ids)
			? { blocks, write: () => edytor.unNestBlocks(ids) }
			: null;
	const to = parent?.isRoot ? null : parent?.id;
	if (!parent || !nestsInto(edytor, parent, blocks) || !edytor.facade.canPlace(ids, to))
		return null;
	const at =
		position === 'inside' ? parent.children.length : target.index + (position === 'after' ? 1 : 0);
	// The document counts the destination's children without the moved blocks.
	const index = at - blocks.filter((block) => block.parent === parent && block.index < at).length;
	return { blocks, write: () => edytor.moveBlocks(ids, { parent: to!, index }) };
};

/**
 * An `in` or `out` step over siblings as its runs of adjacent ones:
 * siblings with another block between them move apart, as Tab and
 * Shift+Tab do, so the step never reorders the text. Any
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
export const canMove = (edytor: Edytor, request: BlockMoveRequest): boolean =>
	parts(edytor, request).some((part) => destination(edytor, part) !== null);

/**
 * One move: the document's `moveBlocks`, an `out` step's outdent
 * (`unNestBlocks`) or a beside placement (`placeBeside`), dispatched as the
 * view's write — identity kept, one undo step, a closed toggle the blocks
 * land in or that adopts blocks opening (every caller — keys, drops, menus,
 * the public command — shows the moved blocks); `[]` when refused or
 * vetoed. Runs (`parts`) move one by one, a run that cannot move staying, as
 * Tab does (`dispatcher.each`). The view announces what moved
 * (`announcer.moved`).
 */
export const move = (edytor: Edytor, request: BlockMoveRequest): Block[] => {
	const runs = parts(edytor, request);
	const moved =
		runs.length > 1
			? edytor.dispatcher
					.each('moveBlocks', runs, (run) => place(edytor, run))
					.flatMap((moved) => moved ?? [])
			: place(edytor, runs[0] ?? request);
	// Said to assistive technology: what moved, and where (`session/announcer`).
	edytor.announcer.moved(request, moved);
	return moved;
};

const place = (edytor: Edytor, request: BlockMoveRequest): Block[] => {
	const move = destination(edytor, request);
	if (!move) {
		// Refused before any command ran: `last` still reports it (commands#results).
		const status = request.blocks.length ? 'refused' : 'noop';
		edytor.dispatcher.record({ operation: 'moveBlocks', status });
		return [];
	}
	const result: OpResult = move.write();
	return result.status === 'applied' ? move.blocks : [];
};

/** A new block a drop places (`placeNew`): its kind, and its id when the caller names it. */
export type NewBlock = { type: string; id?: string };

/**
 * Whether new blocks of `kinds` may land at `target`'s `position` (a file
 * dropped there, `placeNew`): the move's places (`destination`) asked of
 * blocks not yet in the document — the container rule (`fits`) of the
 * parent they land in, never inside a void or an island; beside, a layout
 * kind and a target outside any island (`placeBeside` takes any block a
 * column holds).
 */
export const canPlaceNew = (
	edytor: Edytor,
	kinds: readonly string[],
	target: Block,
	position: BlockMovePosition
): boolean => {
	const { facade } = edytor;
	if (edytor.readonly || !kinds.length || !target.isInTree || target.isRoot) return false;
	if (!POSITIONS.includes(position) || facade.insideIsland(target.id)) return false;
	if (isBeside(position))
		return (
			[...edytor.blocks.values()].some((definition) => definition.layout) &&
			!facade.isIsland(target.id)
		);
	const parent = position === 'inside' ? target : target.parent;
	if (!parent || !nestsInto(edytor, parent)) return false;
	const to = parent.isRoot ? null : parent.id;
	if (to !== null && (facade.isVoid(to) || facade.isIsland(to))) return false;
	return kinds.every((kind) => facade.fits(to, kind));
};

/**
 * Insert new blocks at `target`'s `position` (a file drop's placement):
 * before or after it, inside it (its last children), or beside it — inserted
 * after the block it stands beside (`besideAt`) and moved there by the one
 * move path (`layout.place-beside`) — in one transaction. The caller's
 * command makes it one undo step. Answers the ids placed (none: refused).
 */
export const placeNew = (
	edytor: Edytor,
	blocks: readonly NewBlock[],
	target: Block,
	position: BlockMovePosition
): string[] => {
	const kinds = blocks.map((block) => block.type);
	if (!canPlaceNew(edytor, kinds, target, position)) return [];
	const beside = isBeside(position);
	const at = beside ? (edytor.idToBlock.get(edytor.facade.besideAt(target.id)) ?? target) : target;
	const parent = position === 'inside' ? target : at.parent;
	const destination =
		position === 'inside'
			? { parent: target.id, index: target.children.length }
			: {
					parent: !parent || parent.isRoot ? null : parent.id,
					index: at.index + (position === 'before' ? 0 : 1)
				};
	return edytor.transact((): string[] => {
		const { ids } = edytor.insertBlocks(
			destination,
			blocks.map((block) => ({ ...block }))
		);
		if (!beside || !ids.length) return [...ids];
		const placed = ids.flatMap((id) => edytor.idToBlock.get(id) ?? []);
		move(edytor, { blocks: placed, target, position });
		return [...ids];
	});
};
