/**
 * The facade's reads over the document's index, folded up to the last
 * write (read-your-writes, so they hold mid-transaction): the one
 * serializer, data, placement and display ancestry, the role table's answer
 * for a block's shown kind, and the document order.
 */
import { DEV } from 'esm-env';
import type { EngineApi, EngineDoc, EngineNode } from '../engine-api.js';
import { DOC_DATA_ROOT, TYPE } from '../schema.js';
import {
	displayParentOf,
	displaySlotOf,
	isLiveIn,
	type BlockId,
	type ContentItem,
	type Destination,
	type ModelView,
	type PlacementModel
} from '../placement/model.js';
import { DEAD, ownedLength, type TextEngine } from '../text/model.js';
import type { DisplayRoles, RunView } from '../text/runs.js';
import { holdsPending } from '../structs.js';
import { itemIds, readData } from '../data.js';
import { cloneJsonSafe, type JSONBlock } from '../../utils/json.js';
import { ref } from './plan.js';
import type { BlockRole, DataTarget, JsonObj, OrderPolicy } from './types.js';

type View = ModelView;

/** What every part of a document facade is built over: one doc, its engine layers, its index and its roles. */
export type DocBase = {
	Y: EngineApi;
	doc: EngineDoc;
	M: PlacementModel;
	T: TextEngine;
	/** The doc's index (`text/runs.ts`): the one owner of derived state. */
	runsView: RunView;
	/** The role table the display and every guard ask of a block's shown kind. */
	roles: DisplayRoles;
	/** A kind's structural role, as configured. */
	roleOf: (type: string) => BlockRole | undefined;
	/** The adopted `rendersContent` per kind. */
	rendersContentOf: (type: string) => boolean;
};

/** The reads of the facade over `c.doc`. */
export const docReads = (c: DocBase) => {
	const { doc, M, T, runsView, roles } = c;

	/** The node a data patch writes: block `id`, its atom `inlineId`, or the document's data root. */
	const dataNode = (id?: BlockId, inlineId?: string): EngineNode | undefined =>
		id === undefined
			? doc.get(DOC_DATA_ROOT)
			: inlineId === undefined
				? (M.blockNodeOf(doc, id) ?? undefined)
				: (T.findAtom(view().own, id, inlineId)?.node as EngineNode | undefined);

	/** The one serializer (L14): `id`'s subtree in the public `JSONBlock` shape. */
	const blockJSON = (id: BlockId): JSONBlock => {
		const type = blockTypeOf(id);
		// A registered block always has a type once its updates are all in (UW-01):
		// `''` is the absent-id shape, or an out-of-order delivery's transient.
		if (DEV && type === undefined && M.blockNodeOf(doc, id) !== null && !holdsPending(doc))
			throw new Error(`[edytor-doc] block ${id} has no type`);
		const block: JSONBlock = {
			type: type ?? '',
			id,
			data: (blockDataOf(id) ?? {}) as JSONBlock['data']
		};
		const content = runsView.contentJSON(id) as JSONBlock['content'] & unknown[];
		if (content.length > 0) block.content = content;
		const children = childrenIds(id);
		if (children.length > 0) block.children = children.map(blockJSON);
		return block;
	};

	/** The doc's index, folded up to the last write (read-your-writes). */
	const view = (): ModelView => runsView.view();
	type View = ModelView;

	// ── reads ────────────────────────────────────────────────────────

	const blockTypeOf = (id: BlockId): string | undefined => {
		const t = runsView.displayType(id) ?? M.blockNodeOf(doc, id)?.getAttr(TYPE);
		return typeof t === 'string' ? t : undefined;
	};

	const blockDataOf = (id: BlockId): Record<string, unknown> | undefined => {
		const node = M.blockNodeOf(doc, id);
		const d = node && readData(node);
		// `cloneJsonSafe`: the read path stays total even when the stored
		// attr holds a non-JSON value that bypassed boundary validation
		// (raw write / remote payload) — never crash a read (R4).
		return d !== undefined && d !== null ? (cloneJsonSafe(d) as JsonObj) : undefined;
	};
	/** The document's own data (`{}` when it has none). */
	const docData = (): JsonObj => cloneJsonSafe(readData(doc.get(DOC_DATA_ROOT)) ?? {});
	/**
	 * The ids of the items of the array at `path` in a block's, an atom's
	 * or the document's data (`[]` where none is): what a path names an
	 * item by (`~…`), so it reaches that item wherever peers move it.
	 */
	const dataItemIds = (target: DataTarget, path: readonly string[]): string[] => {
		const [id, atom] =
			typeof target === 'object' && target ? [target.block, target.atom] : [target ?? undefined];
		const node = dataNode(id && ref(id), atom && ref(atom));
		return node && Array.isArray(path) ? itemIds(node, path) : [];
	};

	/** Ordered visible children of `parent` (`null` = root) — canonical read. */
	const childrenIds = (parent: BlockId | null): BlockId[] =>
		(view().kids.get(parent) ?? []).map((k) => k.id);

	const positionOf = (id: BlockId): Destination | null => M.positionOf(doc, id);

	/** Index path from the root (`[i, j, …]`), or null when hidden/absent. */
	const pathOf = (id: BlockId): number[] | null => {
		const v = view();
		const path: number[] = [];
		let cur: BlockId | null = id;
		while (cur !== null) {
			const pos = M.positionInView(v, cur);
			if (!pos) return null;
			path.unshift(pos.index);
			cur = pos.parent;
		}
		return path;
	};

	/** Display ancestors of `id`, nearest first (`null` parent = root → stop). */
	const ancestorsOf = (id: BlockId, v: View = view()): BlockId[] => {
		const out: BlockId[] = [];
		if (!isLiveIn(v, id)) return out;
		for (let p = displayParentOf(v.own, v.placements.get(id)!, v.placements, id); p !== null; ) {
			out.push(p as BlockId);
			p = displayParentOf(v.own, v.placements.get(p as BlockId)!, v.placements, p as BlockId);
		}
		return out;
	};

	/**
	 * The replicated slot of any registered block, dead or live (the seam
	 * of a vanished endpoint, `anchors.seam`): where it displays, or would
	 * ({@link displaySlotOf}) — the raw placement when no live parent is
	 * reachable.
	 */
	const slotOf = (id: BlockId): { parent: BlockId | null; rank: string } | null => {
		const v = view();
		const pl = v.placements.get(id);
		if (!pl) return null;
		const slot = displaySlotOf(v.own, v.placements, pl, id);
		return slot.parent === DEAD ? pl : (slot as { parent: BlockId | null; rank: string });
	};

	// ── roles (island/void) ───────────────────────────────────────────

	/** The role table's answer for `id`'s shown kind (`false` without one). */
	const is = (id: BlockId, role: (type: string) => boolean): boolean => {
		const t = blockTypeOf(id);
		return t !== undefined && role(t);
	};
	const isVoid = (id: BlockId): boolean => is(id, roles.childless);
	const isIsland = (id: BlockId): boolean => is(id, roles.island);
	/** An island that holds only lines (a code block: its role says `lines`). */
	const isLines = (id: BlockId): boolean => is(id, (type) => roles.line(type) !== undefined);
	/** Nearest island-typed display ancestor of `id`, or null. */
	const islandOf = (id: BlockId, v: View = view()): BlockId | null =>
		ancestorsOf(id, v).find((a) => isIsland(a)) ?? null;
	/** True iff `id` sits strictly inside an island subtree. */
	const insideIsland = (id: BlockId, v?: View): boolean => islandOf(id, v) !== null;
	/** `id` is a line — directly in an island declared `lines` — and holds no children (FW-01). */
	const isLine = (id: BlockId): boolean => {
		const parent = positionOf(id)?.parent;
		return parent != null && isLines(parent);
	};
	/** The item kind of `id` when it is a layout (its role says `layout`): its default child. */
	const itemKindOf = (id: BlockId): string | undefined => {
		const type = blockTypeOf(id);
		return type === undefined ? undefined : roles.layout(type);
	};
	/** `id` is a layout (`layout.*`). */
	const isLayout = (id: BlockId): boolean => itemKindOf(id) !== undefined;
	/** `id` is a layout item: of its layout's item kind, directly in it (a column). */
	const isLayoutItem = (id: BlockId): boolean => {
		const parent = positionOf(id)?.parent;
		return parent != null && blockTypeOf(id) === itemKindOf(parent);
	};
	/** `id` is a layout or holds one in its shown subtree (D2, `layout.nest`). */
	const holdsLayout = (id: BlockId): boolean => isLayout(id) || childrenIds(id).some(holdsLayout);
	/** `id` is a layout item or sits inside one. */
	const insideItem = (id: BlockId, v?: View): boolean =>
		[id, ...ancestorsOf(id, v)].some(isLayoutItem);

	// ── document order (O7): one pre-order over visible blocks ────────

	/** The document order — `view().order`, shared by every consumer. */
	const order = (): readonly BlockId[] => view().order.ids;

	/**
	 * Compare two blocks in document order (negative: `a` first). A block
	 * that is not visible sorts after every visible one.
	 */
	const compare = (a: BlockId, b: BlockId): number => {
		const { at } = view().order;
		return (at.get(a) ?? Infinity) - (at.get(b) ?? Infinity) || 0;
	};

	/**
	 * The neighbour of `id` in document order (`dir` 1: next, -1: previous).
	 * `sealed` is the island-sealing policy (R5): the walk never enters an
	 * island it did not start in — from outside, an island is one unit
	 * (its root is visited, its interior skipped); from inside, the walk
	 * may leave. Operations that need the seal pass it; the order itself
	 * is never re-derived.
	 */
	const step = (id: BlockId, dir: 1 | -1, policy?: OrderPolicy): BlockId | null => {
		const v = view();
		const { ids, at } = v.order;
		const i = at.get(id);
		if (i === undefined) return null;
		const open = policy?.sealed ? new Set(ancestorsOf(id, v)) : null;
		for (let j = i + dir; j >= 0 && j < ids.length; j += dir) {
			const island = open && islandOf(ids[j], v);
			if (!island || open!.has(island)) return ids[j];
		}
		return null;
	};
	const next = (id: BlockId, policy?: OrderPolicy) => step(id, 1, policy);
	const previous = (id: BlockId, policy?: OrderPolicy) => step(id, -1, policy);

	/** Display length (UTF-16 units + inline atoms) of `id`'s content, read-your-writes. */
	const displayLength = (id: BlockId): number => ownedLength(view().own.display(id) ?? []);

	/**
	 * Resolved display content of `id` — the canonical `ContentItem[]`
	 * (text runs + inline atoms in display order) from the live view, so
	 * it reflects writes made earlier in the same transaction. `[]` for
	 * absent/deleted blocks. This is the transaction-aware counterpart
	 * of the commit-synced {@link runsView} read surface.
	 *
	 * R4: the range reader emits BORROWED `marks`/`data` (cursor format
	 * state / the replicated inline attr) — every item's payload is
	 * swapped for the view's canonical frozen instance before it crosses
	 * the public boundary, so callers can't mutate engine state through
	 * the snapshot. Item wrappers and the array stay fresh and mutable.
	 */
	const contentItems = (id: BlockId): ContentItem[] => runsView.contentItems(id);

	/** Registry membership — the block exists (may be delete-marked or merged away). */
	const hasBlock = (id: BlockId): boolean => M.blockNodeOf(doc, id) !== null;

	/** The one liveness answer (`M.isLive`): `id` renders in `project()`. O(depth). */
	const live = (id: BlockId): boolean => M.isLive(doc, id);
	/** A live block that can hold content: it has a claims list (a streamless block gets its own text on first write). */
	const contentTarget = (id: BlockId): boolean =>
		live(id) && view().blocks.get(id)?.claimsNode !== undefined;

	return {
		dataNode,
		blockJSON,
		view,
		blockTypeOf,
		blockDataOf,
		docData,
		dataItemIds,
		childrenIds,
		positionOf,
		pathOf,
		ancestorsOf,
		slotOf,
		is,
		isVoid,
		isIsland,
		isLines,
		islandOf,
		insideIsland,
		isLine,
		itemKindOf,
		isLayout,
		isLayoutItem,
		holdsLayout,
		insideItem,
		order,
		compare,
		next,
		previous,
		displayLength,
		contentItems,
		hasBlock,
		live,
		contentTarget
	};
};

export type DocReads = ReturnType<typeof docReads>;
