/**
 * Layout ops (`layout.*`): the layout kind a new layout takes, where a
 * beside placement lands (`besideAt`), and the two layout-making ops,
 * `placeBeside` and `wrapInLayout`.
 */
import { id as newId } from '../../utils.js';
import { sanitizeSpec } from '../../utils/json.js';
import type { BlockId, BlockSpec } from '../placement/model.js';
import { ref } from './plan.js';
import type { Prepared, PlanStep } from './types.js';
import type { OpsContext } from './steps.js';

/** The layout ops of one facade, prepared. */
export const layoutOps = (c: OpsContext) => {
	const {
		roles,
		view,
		blockTypeOf,
		childrenIds,
		positionOf,
		ancestorsOf,
		isIsland,
		isLines,
		insideIsland,
		isLayout,
		isLayoutItem,
		holdsLayout,
		insideItem,
		live,
		canPlace,
		isContainer,
		fits,
		fitsIn,
		REFUSED,
		plan,
		ranksFor,
		moveTo,
		landing,
		emptied
	} = c;

	/** The layout kind a new layout takes: `kind` when it is one, else the only one the roles declare. */
	const layoutKind = (kind?: string): string | undefined => {
		if (kind !== undefined) return roles.layout(kind) === undefined ? undefined : kind;
		const kinds = [...roles.layoutKinds()];
		return kinds.length === 1 ? kinds[0] : undefined;
	};
	/**
	 * The block a beside placement at `target` stands beside
	 * (`layout.place-beside`): a layout or an item for itself; a block whose
	 * parent shows only its children (a list item → its list, at any depth)
	 * or is an island of lines (a code line → its code block) for that
	 * parent; then the block itself when it sits directly in an item or at
	 * the root, or where a new layout of `kind` (else the only layout kind)
	 * fits beside it (a toggle's, a callout's or a nested block's child,
	 * outside any item and island, D2); else its outermost block below the
	 * root or an item.
	 */
	const besideAt = (target: BlockId, kind?: string): BlockId => {
		let at = ref(target);
		if (isLayout(at) || isLayoutItem(at)) return at;
		for (
			let parent = positionOf(at)?.parent ?? null;
			parent !== null && !isLayoutItem(parent) && (isContainer(parent) || isLines(parent));
			parent = positionOf(parent)?.parent ?? null
		)
			at = parent;
		const parent = positionOf(at)?.parent ?? null;
		if (parent === null || isLayoutItem(parent)) return at;
		const wrap = layoutKind(kind);
		if (
			wrap !== undefined &&
			fits(parent, wrap) &&
			!insideItem(parent) &&
			!isIsland(parent) &&
			!insideIsland(parent)
		)
			return at;
		for (
			let up: BlockId | null = parent;
			up !== null && !isLayoutItem(up);
			up = positionOf(up)!.parent
		)
			at = up;
		return at;
	};
	/**
	 * Place `ids` beside `target`, to its `side` (`layout.place-beside`: a
	 * block dragged to another block's left or right edge). The target
	 * resolves to its outermost block below the root or below a layout
	 * item (a list item → its list, a code line → its code block); an item
	 * stands for itself, a layout for its first or last slot. Beside a
	 * block in an item, a new item holding `ids` goes beside that item;
	 * otherwise the block and a new item holding `ids` are wrapped in a new
	 * layout of the layout `kind` (else the only one the roles declare) at
	 * its place. Refused when `ids` holds the target or an ancestor of it,
	 * an item, a layout or a block holding one (D2), a block that does not
	 * fit an item, a block or a layout inside an island, and, wrapping,
	 * when there is no layout kind. The sources are cleaned in the same
	 * plan (`emptying`, `dissolving`); plain ranks (a move). `ids`: the
	 * moved blocks.
	 */
	const placeBeside = (
		ids: readonly BlockId[],
		target: BlockId,
		side: 'left' | 'right',
		kind?: string
	): Prepared => {
		const moved = ids.map(ref);
		target = ref(target);
		const v = view();
		if ((side !== 'left' && side !== 'right') || !canPlace(moved) || !live(target)) return REFUSED;
		if ([target, ...ancestorsOf(target, v)].some((a) => moved.includes(a))) return REFUSED;
		if (moved.some((id) => isLayoutItem(id) || holdsLayout(id))) return REFUSED;
		const right = side === 'right';
		// Where the new item goes: beside an item of a layout, or a new layout wrapping `at`.
		const at = besideAt(target, kind && ref(kind));
		let layout: BlockId | null = null;
		let index = 0;
		if (isLayout(at)) [layout, index] = [at, right ? childrenIds(at).length : 0];
		else {
			const item = isLayoutItem(at) ? at : positionOf(at)!.parent;
			if (item !== null) {
				const pos = positionOf(item)!;
				[layout, index] = [pos.parent!, pos.index + (right ? 1 : 0)];
			}
		}
		const wrap = layout === null ? layoutKind(kind && ref(kind)) : blockTypeOf(layout);
		const item = wrap === undefined ? undefined : roles.layout(wrap);
		if (wrap === undefined || item === undefined) return REFUSED;
		if (moved.some((id) => !fitsIn(item, blockTypeOf(id)))) return REFUSED;
		if (layout !== null && (isIsland(layout) || insideIsland(layout, v))) return REFUSED;
		const spec = (type: string): BlockSpec => sanitizeSpec({ id: newId('b'), type, data: {} });
		const fresh = spec(item);
		const into = (parent: BlockId) => moveTo(moved, parent, 0, ranksFor(parent, 0, moved.length));
		let writes: PlanStep[];
		let kept: Set<BlockId | null>;
		if (layout !== null) {
			const ranks = ranksFor(layout, index, 1);
			writes = [
				{ op: 'insertBlocks', parent: layout, index, specs: [fresh], ranks },
				...into(fresh.id)
			];
			kept = new Set([fresh.id, ...landing(layout)]);
		} else {
			const pos = positionOf(at)!;
			const host = spec(item);
			const wrapper = { ...spec(wrap), children: right ? [host, fresh] : [fresh, host] };
			const ranks = ranksFor(pos.parent, pos.index, 1);
			writes = [
				{ op: 'insertBlocks', parent: pos.parent, index: pos.index, specs: [wrapper], ranks },
				...moveTo([at], host.id, 0, ranksFor(host.id, 0, 1)),
				...into(fresh.id)
			];
			kept = new Set([wrapper.id, host.id, fresh.id, ...landing(pos.parent)]);
		}
		return plan(moved, emptied(moved, writes, kept));
	};

	/**
	 * Wrap sibling blocks in a new layout of `columns` items (default: one
	 * per block), at the first one's place (`layout.wrap`: Turn into N
	 * columns, as Notion): the blocks fill the first items, one each, in
	 * document order; each item after them holds one empty block of the
	 * item's default child (one block turned into 3 columns: it, then two
	 * empty columns). The layout is of the layout `kind` (else the only one
	 * the roles declare). Refused for no block, fewer than two items or
	 * fewer items than blocks, blocks of different parents, an item, a
	 * layout or a block holding one (D2), where the layout does not fit
	 * (`fits`: in a list, a code block) or lands inside an item (D2) or an
	 * island, and for a block that does not fit an item. Plain ranks (a
	 * move). `ids`: the new layout.
	 */
	const wrapInLayout = (
		ids: readonly BlockId[],
		kind?: string,
		columns: number = ids.length
	): Prepared => {
		const blocks = ids.map(ref);
		const v = view();
		if (!Number.isInteger(columns) || columns < 2 || blocks.length < 1) return REFUSED;
		if (columns < blocks.length || !canPlace(blocks)) return REFUSED;
		const parent = positionOf(blocks[0]!)!.parent;
		if (blocks.some((id) => positionOf(id)!.parent !== parent)) return REFUSED;
		if (blocks.some((id) => isLayoutItem(id) || holdsLayout(id))) return REFUSED;
		const wrap = layoutKind(kind && ref(kind));
		const item = wrap === undefined ? undefined : roles.layout(wrap);
		if (wrap === undefined || item === undefined || !fits(parent, wrap)) return REFUSED;
		if (parent !== null && (insideItem(parent, v) || isIsland(parent) || insideIsland(parent, v)))
			return REFUSED;
		if (blocks.some((id) => !fitsIn(item, blockTypeOf(id)))) return REFUSED;
		const fill = roles.defaultChild(item);
		if (columns > blocks.length && !fitsIn(item, fill)) return REFUSED;
		const ordered = blocks.toSorted((a, b) => positionOf(a)!.index - positionOf(b)!.index);
		const spec = (type: string): BlockSpec => sanitizeSpec({ id: newId('b'), type, data: {} });
		const items = Array.from({ length: columns }, (_, i) =>
			i < ordered.length ? spec(item) : { ...spec(item), children: [spec(fill)] }
		);
		const wrapper = { ...spec(wrap), children: items };
		const at = positionOf(ordered[0]!)!.index;
		const writes: PlanStep[] = [
			{
				op: 'insertBlocks',
				parent,
				index: at,
				specs: [wrapper],
				ranks: ranksFor(parent, at, 1)
			},
			...ordered.flatMap((id, i) => moveTo([id], items[i]!.id, 0, ranksFor(items[i]!.id, 0, 1)))
		];
		const kept = new Set<BlockId | null>([
			wrapper.id,
			...items.map((it) => it.id),
			...landing(parent)
		]);
		return plan([wrapper.id], emptied(ordered, writes, kept));
	};

	return {
		layoutKind,
		besideAt,
		placeBeside,
		wrapInLayout
	};
};
