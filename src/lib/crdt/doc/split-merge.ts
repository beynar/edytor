/**
 * Split and merge ops: `splitBlock` (one boundary item, no text copied),
 * the engine merge primitive `mergeBlocks`, and the baseline-shaped
 * `mergeBackward`/`mergeForward` (a first item lifts out of its container,
 * a layout item's first block merges across items).
 */
import { isIncarnationId } from '../incarnations.js';
import { sanitizeWireJson } from '../../utils/json.js';
import { readData } from '../data.js';
import type { BlockId, SplitTail } from '../placement/model.js';
import { ref } from './plan.js';
import type { Prepared, PlanStep } from './types.js';
import type { OpsContext } from './steps.js';

/** The split-merge ops of one facade, prepared. */
export const splitMergeOps = (c: OpsContext) => {
	const {
		doc,
		M,
		view,
		childrenIds,
		positionOf,
		isVoid,
		isCellKind,
		blockTypeOf,
		insideIsland,
		isLayoutItem,
		next,
		previous,
		displayLength,
		contentTarget,
		isContainer,
		fits,
		canMerge,
		rendersContent,
		kindToCopy,
		REFUSED,
		plan,
		ranksFor,
		moveTo,
		move,
		pieceRanks,
		leaving,
		settledKind,
		settle,
		landing,
		emptying,
		emptied,
		merge,
		clamp
	} = c;

	/**
	 * Split `id` at content `offset` into a new sibling `newId` (one boundary
	 * item and the claims that follow it, no text copied; children follow).
	 * `tail` decides the sibling's type/data once (default: the source's —
	 * the kind it displays; an empty `tail.type` is the default too).
	 * Refused on `void` blocks and on blocks that render no content (a
	 * list, a code block: nothing to split). `ids`: the new
	 * block.
	 */
	const splitBlock = (id: BlockId, offset: number, newId: BlockId, tail?: SplitTail): Prepared => {
		id = ref(id);
		const born = ref(newId);
		const pos = positionOf(id);
		const rec = view().blocks.get(id);
		if (pos === null || isVoid(id) || !rendersContent(id) || !rec?.claimsNode) return REFUSED;
		// A table's cell holds its lines as line breaks: it never splits (`table.split`).
		if (isCellKind(blockTypeOf(id))) return REFUSED;
		if (isIncarnationId(born) || M.blockNodeOf(doc, born) !== null) return REFUSED;
		const [at] = clamp(id, offset, 0);
		// An empty tail type is the one a view reads mid-retype: copy the kind.
		const type = tail?.type ? ref(tail.type) : kindToCopy(id);
		const t = tail
			? { type, data: tail.data && sanitizeWireJson(tail.data) }
			: { type, data: readData(rec.node) };
		const [rank] = pieceRanks(id, at, 1);
		const length = displayLength(id) - at;
		const split: PlanStep = {
			op: 'splitBlock',
			id,
			offset: at,
			length,
			newId: born,
			tail: t,
			parent: pos.parent,
			rank: rank!
		};
		return plan([born], [split, ...move(childrenIds(id), born, 0)]);
	};

	/**
	 * Engine merge primitive: `from`'s content is claimed by `into`, its
	 * children ADOPTED as `into`'s last children — an island's take
	 * `into`'s default child, like a baseline merge's — and `from` is
	 * hidden via the claim (undo restores it). The children stay under
	 * `from`, ranked after `into`'s children, and display under `into`
	 * through the claim: a concurrent delete of `into` voids the
	 * claim and `from` comes back with its children, never below them.
	 * Role rules are `canMerge`'s; a merge that would close a display
	 * cycle is refused. `ids`: `into`.
	 */
	const mergeBlocks = (fromId: BlockId, intoId: BlockId): Prepared => {
		const from = ref(fromId);
		const into = ref(intoId);
		const v = view();
		if (!canMerge(from, into) || !contentTarget(into)) return REFUSED;
		if (M.isSelfOrDescendant(v.placements, v.own, into, from)) return REFUSED;
		const kids = childrenIds(from);
		const retype = settle(from, kids, into);
		const adopt = moveTo(kids, from, kids.length, ranksFor(into, Infinity, kids.length, kids));
		// A list its only item leaves goes, as with every sibling op.
		return plan([into], emptied([from], [merge(from, into), ...adopt, ...retype], landing(into)));
	};

	/**
	 * Baseline-shaped merge (both `mergeBackward` and `mergeForward`):
	 * `from`'s children unnest right after `from`'s vacated sibling slot —
	 * NOT adopted into `into` — and take the kind they show there
	 * (`settledKind`: an island's children its parent's default child, a
	 * paragraph in a list its item); then `from`'s content claims
	 * into `into`. Ranked after `from`, not at it: a concurrent delete of
	 * `into` revives `from` above its former children.
	 */
	const mergeUnnesting = (from: BlockId, into: BlockId): Prepared => {
		const pos = canMerge(from, into) ? positionOf(from) : null;
		if (pos === null || !contentTarget(into)) return REFUSED;
		const kids = childrenIds(from);
		const retype = settle(from, kids, pos.parent);
		const out = leaving(from, true, kids);
		return plan(
			[into],
			[...moveTo(kids, pos.parent, pos.index + 1, out), ...retype, merge(from, into)]
		);
	};

	/** Remove `container`, left empty, for the key at `id` (refused if it holds text). */
	const gone = (id: BlockId, container: BlockId): Prepared => {
		const writes = emptying(container, [], []);
		return writes.length > 0 ? plan([id], writes) : REFUSED;
	};

	/**
	 * Baseline `mergeBlockBackward`: merge `id` into the previous block in
	 * document order. No previous block → an empty block merges forward,
	 * else refused. The first item of a container (`isContainer`) outside
	 * any island lifts out of it instead (Notion): it takes the
	 * container's slot, as its new parent's default child, with its
	 * children (a first cell stays: nothing leaves an island; a block that
	 * would land directly in a container it is no item of stays too).
	 * The first block of a layout item merges across items
	 * instead, in reading order (`layout.merge`, Notion): into the
	 * previous item's last line, or, in the first item, the line before
	 * the layout; an item it empties goes and the layout dissolves.
	 * `ids`: the surviving block.
	 */
	const mergeBackward = (id: BlockId): Prepared => {
		id = ref(id);
		const prev = previous(id);
		if (prev === null && childrenIds(id).length === 0 && displayLength(id) === 0) {
			return mergeForward(id);
		}
		// A container a concurrent edit left empty shows nothing: the key removes it.
		if (prev !== null && isContainer(prev) && childrenIds(prev).length === 0) return gone(id, prev);
		if (prev !== null && prev === positionOf(id)?.parent && isLayoutItem(prev)) {
			const layout = positionOf(prev)!.parent!;
			let into = previous(prev);
			if (into === layout) into = previous(layout);
			const merged = into === null ? REFUSED : mergeUnnesting(id, into);
			if (!('writes' in merged) || childrenIds(id).length > 0) return merged;
			return plan(merged.ids, emptying(prev, [id], merged.writes));
		}
		if (
			prev !== null &&
			prev === positionOf(id)?.parent &&
			isContainer(prev) &&
			!insideIsland(prev)
		) {
			// It lands only where it fits: never directly in a container it is no item of.
			const slot = positionOf(prev)!;
			if (!fits(slot.parent, settledKind(prev, id, slot.parent))) return REFUSED;
			const lift = [
				...moveTo([id], slot.parent, slot.index, leaving(prev, false, [id])),
				...settle(prev, [id], slot.parent)
			];
			return plan([id], emptying(prev, [id], lift, landing(slot.parent)));
		}
		return prev ? mergeUnnesting(id, prev) : REFUSED;
	};

	/**
	 * Baseline `mergeBlockForward`: pull the next block in document order
	 * into `id`. A container passes the merge to its first item (`del.merge.container`:
	 * Delete above a list pulls the item's text up and the list keeps the
	 * rest, or goes when that was its only item). A container left
	 * empty (by concurrent edits) is removed instead, by either key.
	 */
	const mergeForward = (id: BlockId): Prepared => {
		id = ref(id);
		let after = next(id);
		while (after !== null && isContainer(after)) {
			const first = childrenIds(after)[0];
			// A container a concurrent edit left empty shows nothing: the key removes it.
			if (first === undefined) return gone(id, after);
			after = first;
		}
		const out = after ? mergeUnnesting(after, id) : REFUSED;
		const parent = after && positionOf(after)?.parent;
		if (!('writes' in out) || !parent || childrenIds(after!).length > 0) return out;
		return plan(out.ids, emptying(parent, [after!], out.writes));
	};

	return {
		splitBlock,
		mergeBlocks,
		mergeUnnesting,
		gone,
		mergeBackward,
		mergeForward
	};
};
