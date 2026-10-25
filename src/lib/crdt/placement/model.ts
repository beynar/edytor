/**
 * Placement engine — the Edytor document model on vendored Yjs v14.
 *
 * Architecture: every block is a stable registry entry keyed by its logical
 * id; displayed structure is DERIVED from the order sequences (fork patch
 * YP22), never from physical nesting.
 *
 * ```
 * doc.get('blocks')                        registry — flat map, block-id → node
 *   │  [ {b: id}, {b: id}, R, … ]          its list part: the top-level blocks' home slots and move records
 *   └ <blockId>  node('block')             stable identity; survives every move
 *        ├ id / type / n                    payload attrs (n: incarnation nonce)
 *        ├ d/<pointer>                      data leaves (`crdt/data.ts`)
 *        ├ del.<writer>                     per-writer delete marks (any live mark = deleted)
 *        ├ content → node('content')       BACKING text of a block created fresh
 *        │                                  (its streams' boundaries `{s, n}`, claim items `{m}`)
 *        └ [ {b: child}, {p, i}, R, … ]    its list part: its children's home slots, its data
 *                                           arrays' item slots, and move records
 * ```
 *
 * Placement semantics (`placement/slots.ts`, `placement/resolve.ts`):
 *
 * - A block's home slot `{b: id}` is written once, at its creation, in its
 *   parent's sequence right after its left sibling's unit (YATA's origin
 *   rule). A move is one record in the destination's sequence naming the
 *   moved blocks' home slots in order; each slot shows at the record that
 *   wins its movers — the greatest `(priority, client, clock)` — and is
 *   hidden at home; deleting a record (an undo) hands the slot to the next
 *   record, else home. Replicas converge in any delivery order.
 * - Projection resolves the display edges greedily in that order: a block's
 *   candidates are its live records, strongest first, then its home slot,
 *   and it takes the first whose DISPLAY parent chain cannot reach back to
 *   the block through already accepted edges — the later move wins, and a
 *   block whose move a cycle drops is back where it stood (its previous
 *   record, else home); only a block every candidate of which closes a cycle
 *   shows at the root after the last top-level block (deterministic,
 *   acyclic, pure — no repair writes). The acyclic relation is the COMPOSED
 *   one — raw edges are acyclic but merge claims can redirect a display edge
 *   back into the block's own subtree.
 * - Delete marks `del.<writer>` are independent replicated attrs: a marked
 *   block is hidden regardless of where its slot shows — explicit deletion
 *   beats concurrent move. Deleting marks the block and every block it
 *   displays through merge claims, a whole-subtree delete every member; undo
 *   removes only the undoer's mark. An unmarked block under a marked one is
 *   promoted into its slot at read time (`displaySlotOf`), so a concurrent
 *   child is never hidden with it; a block under a void kind
 *   (`DisplayOwnership.childless`) likewise.
 *
 * Content ownership (`text/model.ts`): a block displays its stream —
 * delimited by boundary items in a backing text — then the displays of the
 * blocks it claims. A split inserts one boundary; a merge one claim item at
 * the end of the stream; no text is ever copied.
 *
 * The engine is the vendored one, read through `engine.js` (structural
 * types, `engine-api.ts`): this file never imports vendor `.js` (which
 * `pnpm check` must not traverse).
 *
 * The placement reads are `placement/resolve.ts` (the index decides), the sequences
 * `placement/slots.ts`, the order keys `placement/keys.ts`, where a block
 * displays `placement/display.ts` (re-exported here); this module declares
 * the model's types and its write and read primitives, each a function
 * edytor's modules import (the public binding's `model` lists them,
 * `bindModel`).
 */
import type { EngineApi, EngineDoc, EngineItemRef, EngineNode } from '../engine-api.js';
import {
	BLOCK_NODE,
	CONTENT,
	CONTENT_NODE,
	DEL_PREFIX,
	hasDeleteMark,
	ID,
	INLINE_NODE,
	isNodeLike,
	NONCE,
	REGISTRY_KEY,
	TYPE,
	WITHDRAW_PREFIX
} from '../schema.js';
import { nonceOf } from '../rand.js';
import { indexOf } from '../text/runs.js';
import { Y } from '../engine.js';
import { writeRunMarks } from '../text/marks.js';
import {
	blockTextOf,
	DEAD,
	deleteClaims,
	newNode,
	ownText as ownTextOf,
	splitAt,
	type Ownership,
	type TextBlockRec
} from '../text/model.js';
import { cloneJsonSafe } from '../../utils/json.js';
import { dataWrites, patchWrites, writeData } from '../data.js';
import { incarnationNode, isIncarnationId } from '../incarnations.js';
import { engineOps, firstItem, storeOf } from '../structs.js';
import {
	anchorOf,
	isBlockSlot,
	isRecord,
	nodeOf,
	placeAfter,
	sameUnit,
	shownBy,
	stampOf,
	triples,
	unitOf,
	unitsOf,
	type BlockSlot,
	type Entry,
	type Unit,
	type SeqItem,
	type Stamp
} from './slots.js';
import { ownerOfNode, slotOwner, type Edge, type SlotRef } from './resolve.js';

/** Logical block identifier — caller-assigned, immutable per block. */
export type BlockId = string;

/**
 * Where a block goes: `parent` = logical block id or `null` for root;
 * `index` among its children (for `moveBlocks`, counted without the moved
 * blocks: one place right of its own index `i` is `i + 1`).
 */
export type Destination = { parent: BlockId | null; index: number };

/** One inline content element in a block spec / projection. */
export type ContentItem =
	| { kind: 'text'; text: string; marks?: Record<string, unknown> }
	| { kind: 'inline'; id: string; type: string; data?: Record<string, unknown> };

/** Declarative block description used for inserts (and by seeders). */
export type BlockSpec = {
	id: BlockId;
	type: string;
	data?: Record<string, unknown>;
	content?: ContentItem[];
	children?: BlockSpec[];
};

export type InlineSpec = { id: string; type: string; data?: Record<string, unknown> };

/** The tail block's type/data, decided once by a split (default: copied from the source). */
export type SplitTail = { type: string; data?: Record<string, unknown> };

/** Canonical projected block — the comparison surface for convergence. */
export type ProjectedBlock = {
	id: BlockId;
	type: string;
	data?: Record<string, unknown>;
	content: ContentItem[];
	children: ProjectedBlock[];
	/** Set when the registry node could not be read completely. */
	malformed?: true;
};

export type ProjectedDoc = { children: ProjectedBlock[] };

export { REGISTRY_KEY };
export type { SlotRef, Edge } from './resolve.js';
export { promotedRank } from './keys.js';
export {
	bySlot,
	childrenIndex,
	displayParentOf,
	displaySlotOf,
	documentOrder,
	isLiveIn
} from './display.js';
import { bySlot, childrenIndex, displaySlotOf, displayParentOf, isLiveIn } from './display.js';

/**
 * Internal per-block record: the registry node, its home slot (`null`: none
 * found), plus the text-ownership facts (nonce, own text, merge claims).
 */
export type BlockRec = TextBlockRec & {
	type: string;
	data: unknown;
	home: SlotRef | null;
};

/**
 * Resolved placement after acyclic acceptance: the owner of the sequence
 * that shows the block (`null`: the root) and its order key there (an
 * in-memory key, `placement/keys.ts`: never stored).
 */
export type ResolvedPlacement = {
	parent: BlockId | null;
	rank: string;
};

/**
 * Ownership as the display reads it, with the role table's answer for each
 * block's stored kind (`text/runs.ts` `DisplayRoles`). Absent: no roles
 * (pure engine behavior).
 */
export type DisplayOwnership = Ownership & {
	/**
	 * The live block `b` displays no children (a void role): they
	 * take its slot like a deleted parent's ({@link displaySlotOf}).
	 */
	childless?: (b: BlockId) => boolean;
	/**
	 * `b` (live or deleted) is an island: a block promoted or merged out of
	 * it keeps no container-only kind (`reset`).
	 */
	island?: (b: BlockId) => boolean;
	/**
	 * `b` (live or deleted) is a container — it renders no content and is
	 * neither void nor an island (a list): a block promoted out of it keeps
	 * no container-only kind either (`reset`).
	 */
	container?: (b: BlockId) => boolean;
	/**
	 * The island `b` is declared `lines`: each direct child is a line, and a
	 * line holds no children ({@link displaySlotOf}).
	 */
	lined?: (b: BlockId) => boolean;
	/**
	 * The live block `b` does not display by the layout rules — an empty or
	 * bare item, a layout showing one item or none (`layout.empty-item`,
	 * `layout.bare-item`, `layout.single`): it is hidden, and its children
	 * take its slot like a deleted parent's ({@link displaySlotOf}).
	 */
	passes?: (b: BlockId) => boolean;
	/**
	 * The live layout `owner` does not display `child`, which is no item of
	 * it (`layout.only-items`): `child` takes the layout's slot, right after
	 * it ({@link displaySlotOf}).
	 */
	sheds?: (owner: BlockId, child: BlockId) => boolean;
	/**
	 * The rank `id` displays at directly under `owner`, its placement's own
	 * parent, when a rule other than its placement orders it there (a
	 * table's cell, at its column's position: `table.columns`); `undefined`:
	 * its placement decides.
	 */
	slotRank?: (owner: BlockId, id: BlockId, rank: string) => string | undefined;
};

/** One entry of a children list: `reset` — the island it displays out of ({@link displaySlotOf}). */
export type ChildSlot = { id: BlockId; rank: string; reset?: BlockId };

/**
 * The document index as one consistent replicated-state view — the shared
 * currency of commands, anchors, projection and the change report.
 * `blocks`/`own` are always current; `placements`, `kids` (the
 * `childrenIndex` buckets) and `order` are rebuilt lazily, so pure-content
 * ops never pay for them. Owned by the doc's index (`text/runs.ts`).
 */
export type ModelView = {
	blocks: Map<BlockId, BlockRec>;
	own: DisplayOwnership;
	placements: Map<BlockId, ResolvedPlacement>;
	kids: Map<BlockId | null, ChildSlot[]>;
	/** Document order over `kids` — lazy, like `kids`. */
	order: DocOrder;
	/**
	 * Canonicalize a JSON payload into its shared immutable instance —
	 * deep-frozen and interned by canonical key (so equal payloads are `===`
	 * across `project()`/`contentItems()`/`runs()`). The publication boundary for
	 * item `marks`/`data`: range-read items carry borrowed references
	 * into cursor/checkpoint/replicated state, and substituting the
	 * interned clone is what keeps a caller's mutation out of the engine.
	 */
	intern: <T>(value: T) => T;
	/**
	 * The blocks `owner` displays (itself included while it owns its own
	 * display) — the inverse of `own.ownerOf`, rebuilt with it (a delete
	 * marks what its target displays; a block set deletes many).
	 */
	displays: (owner: BlockId) => readonly BlockId[];
	/**
	 * The display edge block `id` shows at, as the index accepts it (its
	 * strongest move record, or — a cycle dropped a later move — an older one
	 * or its home slot); `null` at the root's tail (every edge closes a cycle)
	 * or without a slot. The writes anchor where it shows.
	 * @internal
	 */
	accepted: (id: BlockId) => Edge | null;
};

/**
 * Document order: ONE pre-order over the visible blocks of a children
 * index — `ids` in reading order, `at` the position of each id. Every
 * consumer (ops, view walkers, block selection, clipboard, drag groups)
 * reads this; island sealing is a policy the caller applies on top.
 */
export type DocOrder = { ids: readonly BlockId[]; at: ReadonlyMap<BlockId, number> };

const { isKeptReplaced } = engineOps(Y);

// ── registry / record access ────────────────────────────────────────

export const registryOf = (doc: EngineDoc): EngineNode => doc.get(REGISTRY_KEY);

export const blockNodeOf = (doc: EngineDoc, id: BlockId): EngineNode | null => {
	const registry = registryOf(doc);
	const v = registry.getAttr(id);
	if (isNodeLike(v)) return v;
	// A losing incarnation under its derived id.
	return isIncarnationId(id) ? incarnationNode(registry, id, isKeptReplaced) : null;
};

/**
 * The registry node when it carries no delete mark — the DELETED half of
 * deleted-vs-hidden (a block under a deleted parent is hidden, not
 * deleted). Not a targetability answer: ops ask {@link isLive}.
 */
export const liveNodeOf = (doc: EngineDoc, id: BlockId): EngineNode | null => {
	const n = blockNodeOf(doc, id);
	return n !== null && !hasDeleteMark(n) ? n : null;
};

/** {@link isLiveIn} over the doc's current view. */
export const isLive = (doc: EngineDoc, id: BlockId): boolean => isLiveIn(view(doc), id);

/**
 * The history's creation rule (`doc/history.ts`, `hist.undo.withdraw`): an
 * undo never deletes a block the undone step created. Its node and
 * structure (attrs, its home slot in its parent's sequence, the content
 * node) stay and the undoer's withdraw mark is written on it; what the step
 * wrote inside the content node (the undoer's own text, atoms, boundaries,
 * claims) is deleted as usual, and so are the move records and data slots
 * the step wrote in the created node's sequence. The index shows a withdrawn
 * block while it holds another writer's content.
 */
export const withdrawOnUndo =
	(doc: EngineDoc) =>
	(
		item: EngineItemRef,
		stackItem: { inserts: { has(client: number, clock: number): boolean } }
	): boolean => {
		const registry = registryOf(doc);
		const created = (id: BlockId): boolean => {
			const node = registry.getAttr(id);
			const entry = isNodeLike(node) ? node._item : null;
			return !!entry?.id && stackItem.inserts.has(entry.id.client, entry.id.clock);
		};
		// A home slot of a block the step created stays with the block (withdrawn, not gone).
		const seq = item as { parentSub?: string | null; content?: { arr?: unknown[] } } | null;
		if (seq?.parentSub === null && seq.content?.arr !== undefined)
			return seq.content.arr.every((v) => isBlockSlot(v) && created(v.b));
		let below: EngineItemRef = null;
		let cur = item;
		while (cur?.parent !== registry) {
			below = cur;
			cur = (cur?.parent as EngineNode | undefined)?._item ?? null;
			if (cur === null) return false;
		}
		if (!cur.id || cur.parentSub === null || !stackItem.inserts.has(cur.id.client, cur.id.clock))
			return false;
		if (below === null) {
			const node = (cur as { content: { type: EngineNode } }).content.type;
			node.setAttr(WITHDRAW_PREFIX + doc.clientID, true);
			return true;
		}
		// The created node's own attrs stay (its content node among them); the records and data
		// slots of its sequence go, and so does what the step wrote inside the content node.
		if (below === item) return below.parentSub !== null;
		return below.parentSub !== CONTENT;
	};

// ── derived state ───────────────────────────────────────────────────

/** The doc's index as a `ModelView` — folded up to the open transaction's last write. */
export const view = (doc: EngineDoc): ModelView => indexOf(doc).view();

// ── content (rich-text sequence) helpers ────────────────────────────

/** A detached inline-atom node (inputs arrive normalized by the facade's ingress). */
export const buildInline = (atom: InlineSpec): EngineNode => {
	const node = newNode(INLINE_NODE);
	node.setAttr(ID, atom.id);
	node.setAttr(TYPE, atom.type);
	writeData(node, dataWrites(atom.data));
	return node;
};

// ── structural predicates ───────────────────────────────────────────

/**
 * True iff `maybeAncestor` is `id` itself or lies on `id`'s
 * DISPLAY-ancestor chain — the composed relation `owner(parent)`
 * (`displayParentOf`), not the raw placement chain. A merge claim can
 * place a block inside another's display subtree without appearing in
 * its raw ancestry, so the merge refusal must see through the claim
 * redirect — this is exactly the relation the index's placements keep
 * acyclic: a merge that would close a cycle is refused without mutation.
 */
export const isSelfOrDescendant = (
	placements: Map<BlockId, ResolvedPlacement>,
	own: Ownership,
	id: BlockId,
	maybeAncestor: BlockId
): boolean => {
	let cur: BlockId | null = id;
	const seen = new Set<BlockId>();
	while (cur !== null && !seen.has(cur)) {
		if (cur === maybeAncestor) return true;
		seen.add(cur);
		const pl = placements.get(cur);
		if (pl === undefined) break;
		const dp = displayParentOf(own, pl, placements, cur);
		if (dp === DEAD) break; // unknown ancestor — hidden, not cyclic
		cur = dp;
	}
	return false;
};

// ── write primitives ────────────────────────────────────────────────
// The document's prepared plans decide every write; these only
// perform one planned step and never refuse. Must run inside a transaction.

/** The sequence node of `parent` (`null`: the root's). */
const sequenceOf = (doc: EngineDoc, parent: BlockId | null): EngineNode =>
	parent === null ? registryOf(doc) : blockNodeOf(doc, parent)!;

/**
 * The block slots item `it` shows as `v` reads it: a record's, the units
 * whose block's accepted edge is it, in the order it names them; a slot
 * item's, those shown at home (moved away or not: a cycle may send one back).
 */
const shownIn = (doc: EngineDoc, v: ModelView, it: SeqItem): Entry[] => {
	const registry = registryOf(doc);
	const via = isRecord(it) ? it : null;
	return unitsOf(doc, it, (_, value, unit) => {
		if (!isBlockSlot(value)) return false;
		const b = slotOwner(registry, isKeptReplaced, value.b, unit.c);
		const home = v.blocks.get(b)?.home;
		return !!home && sameUnit(home, unit) && v.accepted(b)?.via === via;
	});
};

/** The entry block `id` displays as in `v` (its home slot, or its unit at the record it shows at), or `null`. */
const anchorIn = (doc: EngineDoc, v: ModelView, id: BlockId): Entry | null => {
	const home = v.blocks.get(id)?.home;
	if (home === undefined || home === null) return null;
	const edge = v.accepted(id);
	// At the root's tail (a cycle): the engine's place, the nearest one there is.
	if (edge === null) return anchorOf(doc, home);
	if (edge.via === null) {
		const u = unitOf(doc, home);
		return u === null ? null : { value: u.value, unit: home, via: null, at: 0 };
	}
	return shownIn(doc, v, edge.via).find((e) => sameUnit(e.unit, home)) ?? null;
};

/** The entry right before `e` in its sequence as `v` reads it (`e`'s record's previous unit, else the nearest shown to the left). */
const beforeIn = (doc: EngineDoc, v: ModelView, e: Entry): Entry | null => {
	const start = e.via ?? unitOf(doc, e.unit)!.item;
	const own = shownIn(doc, v, start);
	// A record's unit before `e`'s place; a slot item's last unit before `e`.
	const before =
		e.via === null
			? own.findLast((x) => x.unit.k < e.unit.k)
			: e.at > 0
				? (own[e.at - 1] ?? null)
				: undefined;
	if (before !== undefined) return before;
	for (let p = start.left; p !== null; p = p.left) {
		const list = shownIn(doc, v, p);
		if (list.length > 0) return list[list.length - 1]!;
	}
	return null;
};

/**
 * Write `slots` (new blocks' home slots) and/or a move of `moved` (their
 * home units, as `client, clock, len` triples) under `parent`, right after
 * the displayed child `left` (`null`: first) and before `right`: into the
 * sequence that holds `left`'s displaying unit (a promoted or claimed
 * neighbour's own parent), after it — or before `right`'s — else into
 * `parent`'s own sequence. `side` is the record's class among the items of
 * its origin (`placement/slots.ts`: `0` after, `1` before).
 */
export const placeBlocks = (
	doc: EngineDoc,
	v: ModelView,
	parent: BlockId | null,
	left: BlockId | null,
	right: BlockId | null,
	slots: readonly BlockSlot[] | null,
	moved: readonly number[] | null = null,
	side = 0,
	part = 0,
	at: Unit | null = null
): void => {
	// Where `v` shows its blocks: a unit a cycle sent back elsewhere is neither an anchor nor carried.
	const shown = (r: SeqItem) => shownIn(doc, v, r);
	// The record stands at `at` (else its first unit), named with the home slots above it.
	const chain = (first: Unit) => unitChain(doc, v, at ?? first);
	const l = left === null ? null : anchorIn(doc, v, left);
	if (l !== null)
		return void placeAfter(doc, nodeOf(doc, l), l, null, slots, moved, side, part, chain, shown);
	const r = right === null ? null : anchorIn(doc, v, right);
	if (r !== null)
		return void placeAfter(
			doc,
			nodeOf(doc, r),
			beforeIn(doc, v, r),
			r,
			slots,
			moved,
			side,
			part,
			chain,
			shown
		);
	placeAfter(doc, sequenceOf(doc, parent), null, null, slots, moved, side, part, chain, shown);
};

/**
 * The chain a move record names for the engine's sort (fork patch YP22):
 * the home slots from the root sequence down to unit `u`, outermost first —
 * the slot of the block owning `u`'s sequence, that block's parent's, …
 * Home slots never move, so every writer names one chain for one unit.
 */
const unitChain = (doc: EngineDoc, v: ModelView, u: Unit): Unit[] => {
	const out: Unit[] = [u];
	const item = unitOf(doc, u)?.item;
	let owner =
		item === undefined
			? null
			: ownerOfNode(registryOf(doc), isKeptReplaced, item.parent as EngineNode);
	for (let n = 0; owner != null && n < 4096; n++) {
		const home = v.blocks.get(owner)?.home;
		if (!home) break;
		out.unshift({ c: home.c, k: home.k });
		owner = home.parent;
	}
	return out;
};

/**
 * The displayed children of `parent` in `v` around display index `index`
 * (the `exclude`d left out): the one before it and the one at it, the
 * neighbours {@link placeBlocks} writes between.
 */
const around = (
	v: ModelView,
	parent: BlockId | null,
	index: number,
	exclude: readonly BlockId[] = []
): [BlockId | null, BlockId | null] => {
	const all = v.kids.get(parent) ?? [];
	const list = exclude.length === 0 ? all : all.filter((k) => !exclude.includes(k.id));
	const i = Math.max(0, Math.min(index, list.length));
	return [list[i - 1]?.id ?? null, list[i]?.id ?? null];
};

/**
 * Move `ids` (in order) to display index `index` among `parent`'s children
 * (themselves left out): one record naming their home slots, after the
 * child before that index. `at` is the block the record stands at for the
 * engine's sort of two records at one origin (its home slot; `null`: the
 * first moved) and `part` its order among the records standing there.
 */
export const moveBlocksTo = (
	doc: EngineDoc,
	v: ModelView,
	ids: readonly BlockId[],
	parent: BlockId | null,
	index: number,
	side = 0,
	part = 0,
	at: BlockId | null = null
): void => {
	const units = ids.flatMap((id) => {
		const home = v.blocks.get(id)?.home;
		return home ? [home] : [];
	});
	if (units.length === 0) return;
	const anchor = at === null ? null : (v.blocks.get(at)?.home ?? null);
	placeBlocks(
		doc,
		v,
		parent,
		...around(v, parent, index, ids),
		null,
		triples(units),
		side,
		part,
		anchor
	);
};

/**
 * One registry entry: the block node with its own backing text holding
 * `items` (none for a split-born block: its stream lives in the text it was
 * split from) and, in its sequence, its children's home slots in order (each
 * child's node created the same way). Pre-integration writes materialize
 * when the node integrates (the registry write comes last). The block's own
 * home slot is the caller's ({@link placeBlocks}).
 */
const createBlock = (
	doc: EngineDoc,
	sp: BlockSpec,
	items: readonly ContentItem[] | null,
	n: number = nonceOf(doc)
): void => {
	// The block's id is its registry key: the node writes none of its own.
	const node = newNode(BLOCK_NODE);
	node.setAttr(NONCE, n);
	node.setAttr(TYPE, sp.type);
	writeData(node, dataWrites(sp.data));
	const content = items === null ? null : textOf(items);
	if (content !== null) node.setAttr(CONTENT, content);
	const children = sp.children ?? [];
	if (children.length > 0)
		node.insert(
			node.length,
			children.map((c): BlockSlot => ({ b: c.id }))
		);
	for (const child of children) createBlock(doc, child, child.content ?? []);
	registryOf(doc).setAttr(sp.id, node);
	if (content !== null) markText(doc, content, items!);
};

/** A detached backing text holding `items`, unmarked ({@link markText} marks it once integrated). */
const textOf = (items: readonly ContentItem[]): EngineNode => {
	const content = newNode(CONTENT_NODE);
	let clen = 0;
	for (const item of items) {
		if (item.kind === 'text') {
			content.insert(clen, item.text);
			clen += item.text.length;
		} else {
			content.insert(clen++, [buildInline(item)]);
		}
	}
	return content;
};

/** The marks of `items`, written as paired operations on their integrated text. */
const markText = (doc: EngineDoc, content: EngineNode, items: readonly ContentItem[]): void =>
	writeRunMarks(
		doc,
		content,
		0,
		items.map((item) =>
			item.kind === 'text'
				? { length: item.text.length, marks: item.marks as Record<string, unknown> | undefined }
				: { length: 1 }
		)
	);

/**
 * Materialize `specs` (whole subtrees, in order) under `parent` at display
 * index `index`: each spec's node with its children, then their home slots
 * in one run after the child before that index. `split`: the boundary of
 * the split these blocks come with (a paste's lines at a split point), their
 * slots' sort key among the slots of one origin ({@link BlockSlot}).
 */
export const insertSpecsAt = (
	doc: EngineDoc,
	v: ModelView,
	parent: BlockId | null,
	index: number,
	specs: readonly BlockSpec[],
	split: Unit | null = null
): void => {
	if (specs.length === 0) return;
	const [left, right] = around(v, parent, index);
	for (const sp of specs) createBlock(doc, sp, sp.content ?? []);
	placeBlocks(
		doc,
		v,
		parent,
		left,
		right,
		specs.map(
			(sp): BlockSlot => (split === null ? { b: sp.id } : { b: sp.id, s: [split.c, split.k] })
		)
	);
};

/**
 * Restore definition (migration only; a first import
 * restores into an empty doc): make `specs` the whole visible document
 * under their own ids, in ONE transaction. An existing id keeps its
 * registry entry: every delete mark is cleared and its type, data,
 * place and content are rewritten in place — its claims deleted, a
 * fresh own text holding the spec's content; a block whose stream still
 * starts at a live boundary gets a new nonce, so that boundary goes inert
 * and the own text is its stream. An absent id is created. Every other
 * block gets this writer's delete mark. The places are written in the
 * tree's order and the rewrites are last-writer-wins attrs, so two replicas
 * restoring the same specs converge on one copy.
 */
export const restoreBlocks = (doc: EngineDoc, specs: BlockSpec[]): void =>
	doc.transact(() => {
		const { blocks, own } = view(doc);
		const keep = new Set<BlockId>();
		const restore = (list: BlockSpec[], parent: BlockId | null): void => {
			let left: BlockId | null = null;
			for (const sp of list) {
				keep.add(sp.id);
				let node = blockNodeOf(doc, sp.id);
				const v = view(doc);
				if (node === null) {
					createBlock(doc, { ...sp, children: [] }, []);
					placeBlocks(doc, v, parent, left, null, [{ b: sp.id }]);
					node = blockNodeOf(doc, sp.id)!;
				} else {
					deleteClaims(doc, blocks.get(sp.id)?.claims ?? []);
					if (own.streamOf(sp.id)?.home !== sp.id && own.streamOf(sp.id) !== undefined)
						node.setAttr(NONCE, nonceOf(doc));
					const home = v.blocks.get(sp.id)?.home;
					if (home) placeBlocks(doc, v, parent, left, null, null, triples([home]));
				}
				for (const key of [...node.attrKeys()]) {
					if (key.startsWith(DEL_PREFIX) || key.startsWith(WITHDRAW_PREFIX)) node.deleteAttr(key);
				}
				if (node.getAttr(TYPE) !== sp.type) node.setAttr(TYPE, sp.type);
				writeData(node, patchWrites(node, [{ path: [], value: sp.data ?? {} }]) ?? []);
				const text = textOf(sp.content ?? []);
				node.setAttr(CONTENT, text);
				markText(doc, text, sp.content ?? []);
				left = sp.id;
				restore(sp.children ?? [], sp.id);
			}
		};
		restore(specs, null);
		registryOf(doc).forEachAttr((node: unknown, id: string) => {
			if (!keep.has(id) && isNodeLike(node) && !hasDeleteMark(node)) {
				node.setAttr(DEL_PREFIX + doc.clientID, true);
			}
		});
	});

/**
 * Does any id of `specs` (whole subtrees) collide — with another spec id,
 * or with any registry entry, live or deleted? The registry is keyed by
 * id, so writing a taken id would replace that block in place.
 */
export const collides = (doc: EngineDoc, specs: readonly BlockSpec[]): boolean => {
	const seen = new Set<BlockId>();
	const stack = [...specs];
	while (stack.length > 0) {
		const sp = stack.pop()!;
		// A derived incarnation id (U+0000) is never a caller's.
		if (seen.has(sp.id) || isIncarnationId(sp.id) || blockNodeOf(doc, sp.id) !== null) return true;
		seen.add(sp.id);
		stack.push(...(sp.children ?? []));
	}
	return false;
};

/**
 * The seed writer's bulk insert (the document is written by document
 * operations and, once, by the seed writer — `init`, the local
 * materializer): `specs` (whole subtrees, in list order) at `dest` in one
 * transaction, all-or-nothing — `false` without writing when the parent
 * is not live or any id collides. Document operations never call it:
 * they prepare their inserts (`insertBlocks` in the facade).
 */
export const insertBlocks = (doc: EngineDoc, dest: Destination, specs: BlockSpec[]): boolean => {
	if (specs.length === 0) return true;
	if (dest.parent !== null && !isLive(doc, dest.parent)) return false;
	if (collides(doc, specs)) return false;
	return doc.transact(() => {
		insertSpecsAt(doc, view(doc), dest.parent, dest.index, specs);
		return true;
	});
};

/** {@link insertBlocks} of one spec. */
export const insertBlock = (doc: EngineDoc, dest: Destination, spec: BlockSpec): boolean =>
	insertBlocks(doc, dest, [spec]);

/**
 * Split `id` at content `offset` into the new block `newId` placed under
 * `parent` at display `index`: one boundary item for `newId` at the end of
 * the gap at `offset` (fork patch YP7) and the merge claims that follow it
 * written again in the new block's stream — no text is copied, so an
 * offline edit to the tail keeps landing on the same items and displays in
 * the new block after convergence. `tail` is the new block's type/data,
 * decided once by the plan. Children are a separate step. `id` must have a
 * stream or a claim ({@link ownText}).
 * Returns the split's boundary unit (the key of the slots a paste adds at it).
 */
export const writeSplit = (
	doc: EngineDoc,
	id: BlockId,
	offset: number,
	newId: BlockId,
	tail: SplitTail,
	parent: BlockId | null,
	index: number
): Unit => {
	const v = view(doc);
	const n = nonceOf(doc);
	// The boundary is the split's first write: its id is this writer's next.
	const bound: Unit = { c: doc.clientID, k: storeOf(doc).getClock(doc.clientID) };
	splitAt(doc, v.blocks, v.own, id, offset, newId, n);
	const data = tail.data === undefined ? undefined : cloneJsonSafe(tail.data);
	createBlock(doc, { id: newId, type: tail.type, data }, null, n);
	// The tail's slot carries its boundary (`BlockSlot.s`): two peers' splits of
	// one block sort by their boundaries' order in the text, in the gap after it.
	placeBlocks(doc, v, parent, ...around(v, parent, index), [{ b: newId, s: [bound.c, bound.k] }]);
	return bound;
};

/**
 * Give the streamless block `id` its own text (`T.ownText`: a derived
 * writer, a re-minted nonce) — before the first write that needs a stream.
 */
export const ownText = (doc: EngineDoc, id: BlockId) => ownTextOf(doc, view(doc).blocks.get(id)!);

// ── queries ─────────────────────────────────────────────────────────

/**
 * Canonical projection: pure derivation from replicated state — the
 * visible tree of live blocks in their sequences' order, children of a
 * merged-away parent under its owner, those of a deleted parent in its
 * slot ({@link displaySlotOf}). Content is each block's display.
 */
export const project = (doc: EngineDoc): ProjectedDoc => ({ children: indexOf(doc).project() });

/**
 * `positionOf` in a view: the display parent and the index among its
 * visible children — a binary search by the block's display rank (the
 * list's own order), not a scan of its siblings.
 */
export const positionInView = (v: ModelView, id: BlockId): Destination | null => {
	if (!isLiveIn(v, id)) return null;
	const slot = displaySlotOf(v.own, v.placements, v.placements.get(id)!, id);
	const dp = slot.parent as BlockId | null;
	const list = v.kids.get(dp) ?? [];
	let [lo, hi] = [0, list.length];
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (bySlot(list[mid], { id, rank: slot.rank }) < 0) lo = mid + 1;
		else hi = mid;
	}
	const index = list[lo]?.id === id ? lo : list.findIndex((s) => s.id === id);
	return index < 0 ? null : { parent: dp, index };
};

/**
 * `{parent, index}` of `id` in the visible tree, or null when hidden/absent.
 * `parent` is the DISPLAY parent (merged-away ancestors resolve to their
 * owner — see `displayParentOf`).
 */
export const positionOf = (doc: EngineDoc, id: BlockId): Destination | null =>
	positionInView(view(doc), id);

/** Pre-order ids of the visible tree — the document order. */
export const listBlockIds = (doc: EngineDoc): BlockId[] => [...view(doc).order.ids];

/** Flat text of a block's OWNED content (atoms render as ''). */
export const blockText = (doc: EngineDoc, id: BlockId): string | null => {
	const v = view(doc);
	return isLiveIn(v, id) ? blockTextOf(id, v.blocks, v.own) : null;
};

/**
 * Engine identity of the registry entry (`client:clock` of its item), or
 * null when the block is absent from the visible tree (deleted, or hidden
 * under a deleted/unreachable ancestor).
 */
export const crdtId = (doc: EngineDoc, id: BlockId): string | null => {
	if (!isLive(doc, id)) return null;
	const node = blockNodeOf(doc, id);
	const item = node?._item;
	if (!node || !item || item.deleted || !item.id) return null;
	return `${item.id.client}:${item.id.clock}`;
};

/** Engine handle for a logical id, or null when absent or delete-marked (debug surface). */
export const resolveBlock = (doc: EngineDoc, id: BlockId): EngineNode | null => liveNodeOf(doc, id);

/**
 * The live move records of `node`'s sequence (the room's purge, tests):
 * each with its stamp and whether some unit still shows at it — the
 * engine's mover of a unit, or (with `v`) the record a block shows at in
 * `v` (a cycle sent it back to an older one).
 */
export const recordsOf = (
	doc: EngineDoc,
	node: EngineNode,
	v?: ModelView
): { item: SeqItem; stamp: Stamp; wins: boolean }[] => {
	const out: { item: SeqItem; stamp: Stamp; wins: boolean }[] = [];
	for (let it = firstItem<SeqItem>(node); it !== null; it = it.right) {
		if (it.deleted || !isRecord(it)) continue;
		const wins = (v !== undefined && shownIn(doc, v, it).length > 0) || shownBy(doc, it).length > 0;
		out.push({ item: it, stamp: stampOf(it), wins });
	}
	return out;
};

/**
 * The placement model as one object (the public binding's `model`): the
 * primitives above. Edytor's own modules import them directly.
 */
export const bindModel = (_Y: EngineApi) => ({
	// constants
	REGISTRY_KEY,
	// records / projection internals (exported for tests + ADR probes)
	registryOf,
	blockNodeOf,
	liveNodeOf,
	isLive,
	/** The doc's index as a `ModelView`. */
	view,
	childrenIndex,
	positionInView,
	// write primitives (the document's prepared plans apply these)
	buildInline,
	isSelfOrDescendant,
	placeBlocks,
	moveBlocksTo,
	insertSpecsAt,
	withdrawOnUndo,
	collides,
	writeSplit,
	ownText,
	recordsOf,
	// the seed writer's bulk insert
	insertBlocks,
	insertBlock,
	restoreBlocks,
	// queries
	project,
	positionOf,
	listBlockIds,
	blockText,
	crdtId,
	resolveBlock
});

export type PlacementModel = ReturnType<typeof bindModel>;
