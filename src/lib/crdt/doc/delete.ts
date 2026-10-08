/**
 * Block deletion (`del.blocks.promote`): only the members leave, the
 * unselected children of a deleted block take its slot.
 */
import { promotedRank, type BlockId } from '../placement/model.js';
import { ref } from './plan.js';
import type { Prepared } from './types.js';
import type { OpsContext } from './steps.js';

/** The delete ops of one facade, prepared. */
export const deleteOps = (c: OpsContext) => {
	const {
		view,
		blockTypeOf,
		childrenIds,
		positionOf,
		ancestorsOf,
		itemKindOf,
		isLayout,
		isLayoutItem,
		isTable,
		isTableRow,
		live,
		REFUSED,
		plan,
		moveTo,
		settle,
		emptyingAll,
		emptied,
		deleting,
		remove
	} = c;

	/**
	 * Delete a set of blocks (R3, `del.blocks.promote`): this writer's mark on
	 * every member and on what it displays through merge claims (wins over
	 * concurrent moves). Only the members leave: the unselected children of a
	 * deleted block take its slot, in order, with their subtrees, as the
	 * kind they show there (`settledKind`: a deleted island's children take
	 * the slot parent's default child, a deleted list's items leave its
	 * kind, a block promoted into a list is its item). A container the delete leaves with no child goes too
	 * (`del.range.empty-container`). `subtree` is the explicit whole-subtree
	 * delete. `filled`: a parent the same plan fills again (a flow placed in
	 * the deleted blocks' slot, `flow.slot`), which is never emptied, so its
	 * layout never dissolves (`layout.flow-slot`).
	 */
	const deleteBlocks = (
		ids: readonly BlockId[],
		subtree = false,
		filled?: BlockId | null
	): Prepared => {
		const set = new Set(ids.map(ref));
		if ([...set].some((id) => !live(id))) return REFUSED;
		// A layout goes with its items: their blocks take its slot (`layout.dissolving`).
		for (const id of [...set])
			if (isLayout(id)) for (const kid of childrenIds(id)) if (isLayoutItem(kid)) set.add(kid);
		// A table goes with its rows and cells, a row with its cells: none shows outside them (`table.delete-row`).
		const whole = (id: BlockId): void => {
			for (const kid of childrenIds(id)) {
				set.add(kid);
				whole(kid);
			}
		};
		for (const id of [...set]) if (isTable(id) || isTableRow(id)) whole(id);
		if (subtree) {
			const roots = [...set].filter((id) => !ancestorsOf(id).some((a) => set.has(a)));
			return plan(
				roots,
				emptied(
					roots,
					roots.map((id) => remove(id))
				)
			);
		}
		const roots = [...set].filter((id) => !set.has(positionOf(id)!.parent!));
		const { kids } = view();
		const promoting = new Set<BlockId>();
		const members: BlockId[] = [];
		const writes = roots.flatMap((root) => {
			const pos = positionOf(root)!;
			const chunk: BlockId[] = [];
			const kept: { id: BlockId; from: BlockId; rank: string }[] = [];
			// Each kept child moves to the rank read-time promotion gives it
			// (`promotedRank`), so a block a peer puts under a member meanwhile
			// takes the slot in the member's order among them. Right after the
			// root: a flow placed in the root's slot precedes them.
			const walk = (b: BlockId, slotRank: string): void => {
				chunk.push(b);
				for (const kid of kids.get(b) ?? []) {
					const rank = promotedRank(slotRank, kid.rank);
					if (set.has(kid.id)) walk(kid.id, rank);
					else kept.push({ id: kid.id, from: b, rank });
				}
			};
			walk(root, kids.get(pos.parent)![pos.index]!.rank);
			members.push(...chunk);
			if (kept.length > 0) promoting.add(root);
			// A layout shows only its items: a deleted item's blocks land right
			// after it, where read-time promotion shows them (`layout.only-items`).
			const item = pos.parent === null ? undefined : itemKindOf(pos.parent);
			const at = (k: { id: BlockId }) => item !== undefined && blockTypeOf(k.id) !== item;
			const out = kept.filter(at);
			const inside = kept.filter((k) => !at(k));
			const lpos = out.length > 0 ? positionOf(pos.parent!)! : null;
			const lrank = lpos && kids.get(lpos.parent)![lpos.index]!.rank;
			return [
				...moveTo(
					inside.map((k) => k.id),
					pos.parent,
					pos.index + 1,
					inside.map((k) => k.rank)
				),
				...inside.flatMap((k) => settle(k.from, [k.id], pos.parent)),
				...(lpos === null
					? []
					: [
							...moveTo(
								out.map((k) => k.id),
								lpos.parent,
								lpos.index + 1,
								out.map((k) => promotedRank(lrank!, k.rank))
							),
							...out.flatMap((k) => settle(k.from, [k.id], lpos.parent))
						]),
				deleting(root, chunk)
			];
		});
		return plan(
			roots,
			emptyingAll(
				roots.filter((r) => !promoting.has(r)).map((id) => positionOf(id)!.parent),
				roots.filter((r) => !promoting.has(r)),
				writes,
				filled === undefined ? undefined : new Set([filled]),
				members
			)
		);
	};

	/** Delete `id` — its children take its slot (`keepChildren: false`: the whole subtree). */
	const deleteBlock = (id: BlockId, opts: { keepChildren?: boolean } = {}): Prepared =>
		deleteBlocks([id], opts.keepChildren === false);

	return {
		deleteBlocks,
		deleteBlock
	};
};
