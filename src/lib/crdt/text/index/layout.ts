/**
 * The layout rules (`layout.*`) over a children index, and the role
 * table's answers for a block's stored kind they read.
 */
import type { BlockId, ChildSlot } from '../../placement/model.js';
import type { DisplayRoles } from '../runs.js';
import type { IndexState } from './state.js';

/** The layout rules of one doc's index, over its state. */
export const indexLayout = (ix: IndexState) => {
	const { blocks, kindsOf } = ix;

	/** `ask` of `b`'s stored kind; `undefined` without roles or a record. */
	const role = <T>(b: BlockId, ask: (r: DisplayRoles, type: string) => T): T | undefined => {
		const type = blocks.get(b)?.type;
		return ix.roles === null || type === undefined ? undefined : ask(ix.roles, type);
	};
	/** The line kind of `b` when it is an island declared `lines`. */
	const lineKind = (b: BlockId): string | undefined => role(b, (r, type) => r.line(type));
	/** The item kind of `b` when it is a layout. */
	const itemKind = (b: BlockId): string | undefined => role(b, (r, type) => r.layout(type));
	/** The item kinds the roles declare. */
	const declaredItems = (): Set<string> => {
		const items = new Set<string>();
		for (const type of ix.roles?.layoutKinds() ?? []) items.add(ix.roles!.layout(type)!);
		return items;
	};
	/**
	 * The layout rules over a children index (`layout.*`): the live blocks
	 * they do not display, found in one post-order pass. A layout shows
	 * only its items (`layout.only-items`, already in the index: the
	 * layout sheds the others, `own.sheds`); an item that shows no child,
	 * or shows outside a layout, does not display and hands its children
	 * its slot (`layout.empty-item`, `layout.bare-item`); a layout showing
	 * one item or none does not display, nor does that item
	 * (`layout.single`). Each decision reads the children a node shows
	 * once its own children's were made, so one pass is the fixpoint:
	 * what a dissolve hands up is never an item (an item shows only in a
	 * layout, and a dissolving layout hands up its item's children). The
	 * decisions under a node read only its subtree and whether its parent
	 * is a layout, so a pass can start at any node (`from`).
	 */
	type Shown = { id: BlockId; kids: BlockId[] };
	const dissolveVisit = (
		kids: Map<BlockId | null, ChildSlot[]>,
		out: Set<BlockId>,
		ids: readonly BlockId[],
		layout: boolean
	): Shown[] => {
		const isItem = (b: BlockId) => ix.itemKinds.has(blocks.get(b)?.type ?? '');
		const shown: Shown[] = [];
		for (const id of ids) {
			const own = itemKind(id) !== undefined;
			const sub = dissolveVisit(
				kids,
				out,
				(kids.get(id) ?? []).map((k) => k.id),
				own
			);
			if (own) {
				if (sub.length > 1) shown.push({ id, kids: [] });
				else {
					out.add(id);
					for (const k of sub) {
						out.add(k.id);
						shown.push(...k.kids.map((kid) => ({ id: kid, kids: [] })));
					}
				}
			} else if (isItem(id) && (!layout || sub.length === 0)) {
				out.add(id);
				shown.push(...sub);
			} else shown.push({ id, kids: sub.map((k) => k.id) });
		}
		return shown;
	};
	const dissolve = (kids: Map<BlockId | null, ChildSlot[]>): Set<BlockId> => {
		const out = new Set<BlockId>();
		dissolveVisit(
			kids,
			out,
			(kids.get(null) ?? []).map((k) => k.id),
			false
		);
		return out;
	};
	/**
	 * Re-run the layout rules on the layouts `changed` (blocks whose slot
	 * in `kids0` changed, with their parents) and `kinds` reach: from each
	 * one up through layouts and items, the topmost such ancestor's
	 * subtree. Returns the blocks whose dissolved state flipped.
	 */
	const redissolve = (
		changed: Map<BlockId, [BlockId | null | undefined, BlockId | null | undefined]>,
		kinds: Iterable<BlockId>
	): Set<BlockId> => {
		const flips = new Set<BlockId>();
		const isLayoutish = (b: BlockId) => {
			const k = kindsOf.get(b);
			return k !== undefined && (k.layout || k.item);
		};
		const roots = new Set<BlockId>();
		const climb = (b: BlockId | null | undefined): void => {
			let top: BlockId | undefined;
			for (let x = b; typeof x === 'string' && isLayoutish(x); x = ix.slots0.get(x)?.parent)
				top = x;
			if (top !== undefined) roots.add(top);
		};
		for (const [id, [from, to]] of changed) {
			climb(id);
			climb(from);
			climb(to);
		}
		for (const id of kinds) {
			// Its kind decides its own rule, its parent's count and its children's (`layout`).
			climb(id);
			climb(ix.slots0.get(id)?.parent);
			for (const k of ix.kids0.get(id) ?? []) climb(k.id);
			// Only a layout or an item dissolves: a block that left those kinds shows again.
			if (!isLayoutish(id) && ix.dissolved.delete(id)) flips.add(id);
		}
		for (const root of roots) {
			if (!ix.slots0.has(root)) continue;
			const parent = ix.slots0.get(root)!.parent;
			const nodes: BlockId[] = [];
			const stack = [root];
			for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
				nodes.push(x);
				for (const k of ix.kids0.get(x) ?? []) stack.push(k.id);
			}
			const out = new Set<BlockId>();
			dissolveVisit(ix.kids0, out, [root], parent !== null && itemKind(parent) !== undefined);
			for (const x of nodes) {
				if (out.has(x) === ix.dissolved.has(x)) continue;
				if (out.has(x)) ix.dissolved.add(x);
				else ix.dissolved.delete(x);
				flips.add(x);
			}
		}
		// A block that left the index (hidden, removed) dissolves no more.
		for (const id of changed.keys())
			if (!ix.slots0.has(id) && ix.dissolved.delete(id)) flips.add(id);
		return flips;
	};

	return {
		role,
		lineKind,
		itemKind,
		declaredItems,
		dissolveVisit,
		dissolve,
		redissolve
	};
};

export type IndexLayout = ReturnType<typeof indexLayout>;
