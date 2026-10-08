/**
 * Placement engine — the Edytor document model on vendored Yjs v14.
 *
 * Architecture: every block is a stable registry entry keyed by its logical
 * id; displayed structure is DERIVED from per-block placement candidate
 * records, never from physical nesting.
 *
 * ```
 * doc.get('blocks')                        registry — flat map, block-id → node
 *   └ <blockId>  node('block')             stable identity; survives every move
 *        ├ id / type / data / n            payload attrs (n: incarnation nonce)
 *        ├ del.<writer>                     per-writer delete marks (any live mark = deleted)
 *        ├ content → node('content')       BACKING text of a block created fresh
 *        ├ claims → node('claims')         ordered merge claims `{m}`
 *        └ at → node('at')                 placement candidate map
 *             └ "<seq>.<clientId>" → { p: parentId|null, r: rank }
 * ```
 *
 * Placement record semantics (see docs/crdt-v14-move-adr.md):
 *
 * - `{p, r}` is written atomically as ONE attr value under an ever-increasing
 *   per-writer key `seq.clientId`. Parent and rank can never merge across
 *   records — the atomicity requirement.
 * - Winner per block = the max candidate under total order
 *   `(seq, clientId, blockId)` — LWW over replicated, delivery-order-free
 *   metadata. Candidates beyond the top two are tombstoned on write
 *   (compaction); the runner-up is kept as the acyclic fallback.
 * - Projection resolves placements greedily in that order: accept a
 *   candidate's parent edge iff its DISPLAY edge `owner(p)` cannot close a
 *   cycle through already accepted display edges; otherwise try the next
 *   candidate; a block with no acceptable candidate is rehomed at the root
 *   (deterministic, acyclic, pure — no repair writes). The acyclic relation
 *   is the COMPOSED one — raw placements are acyclic but merge claims can
 *   redirect a display edge back into the block's own subtree.
 * - Delete marks `del.<writer>` are independent replicated attrs: a marked
 *   block is hidden regardless of which placement candidate wins — explicit
 *   deletion beats concurrent move. Deleting marks the block and every
 *   block it displays through merge claims, a whole-subtree delete
 *   every member; undo removes only the undoer's mark. An unmarked block
 *   under a marked one is promoted into its slot at read time
 *   (`displaySlotOf`), so a concurrent child is never hidden with it; a
 *   block under a void kind (`DisplayOwnership.childless`) likewise.
 *
 * Content ownership (`text/model.ts`): a block displays its stream —
 * delimited by boundary items in a backing text — then the displays of the
 * blocks it claims. A split inserts one boundary; a merge appends one claim;
 * no text is ever copied.
 *
 * The module is engine-agnostic: `bindModel(Y)` takes the vendored module
 * surface so this file type-checks against structural interfaces and never
 * imports vendor `.js` (which `pnpm check` must not traverse).
 *
 * Placement resolution is `placement/resolve.ts`, the source ranks
 * `placement/source.ts`, where a block displays `placement/display.ts`
 * (re-exported here); this module declares the model's types and binds the
 * write and read primitives to an engine.
 */
import type { EngineApi, EngineDoc, EngineItemRef, EngineNode } from '../engine-api.js';
import { rankAfter, rankBetween } from './rank.js';
import {
	AT,
	AT_NODE,
	BLOCK_NODE,
	CONTENT,
	CONTENT_NODE,
	DEL_PREFIX,
	hasDeleteMark,
	ID,
	CLAIMS,
	CLAIMS_NODE,
	INLINE_NODE,
	isNodeLike,
	NONCE,
	REGISTRY_KEY,
	TYPE,
	WITHDRAW_PREFIX
} from '../schema.js';
import { nonceOf, randOf } from '../rand.js';
import { bindRuns } from '../text/runs.js';
import { writeRunMarks } from '../text/marks.js';
import {
	bindText,
	DEAD,
	type MergeClaim,
	type Ownership,
	type TextBlockRec
} from '../text/model.js';
import { cloneJson } from '../../utils/json.js';
import { dataLeaves, patchWrites, writeLeaves } from '../data.js';
import { incarnationNode, isIncarnationId } from '../incarnations.js';
import { engineOps, newNode as makeNode } from '../structs.js';

/** Logical block identifier — caller-assigned, immutable per block. */
export type BlockId = string;

/** Where a block goes: `parent` = logical block id or `null` for root. */
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

export { candidatesOf, resolvePlacements } from './resolve.js';
export { promotedRank, sourceRank, SOURCE_SIDE } from './source.js';
export {
	bySlot,
	childrenIndex,
	displayIndex,
	displayParentOf,
	displaySlotOf,
	documentOrder,
	isLiveIn,
	textRanker
} from './display.js';
import { candidatesOf, resolvePlacements } from './resolve.js';
import { bySlot, childrenIndex, displayParentOf, displaySlotOf, isLiveIn } from './display.js';

/** Placement value written atomically as one attr: `{p, r}`. */
export type PlacementValue = { p: BlockId | null; r: string };

/** A parsed placement candidate (key + value). */
export type PlacementCand = {
	key: string;
	seq: number;
	client: number;
	p: BlockId | null;
	r: string;
};

/**
 * Internal per-block record: the registry node plus decoded placement
 * candidates sorted by `(seq, client)` descending (index 0 = argmax), plus
 * the text-ownership facts (nonce, own text, merge claims).
 */
export type BlockRec = TextBlockRec & {
	type: string;
	data: unknown;
	cands: PlacementCand[];
};

/** Resolved placement after acyclic acceptance. */
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
	 * The rank `id` displays at directly under `parent` (its placement's own
	 * parent) — `rank` unless it is a piece of a text (`order.split.text`,
	 * {@link textRanker}).
	 */
	textRank?: (id: BlockId, parent: BlockId | null, rank: string) => string;
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
};

/**
 * Document order: ONE pre-order over the visible blocks of a children
 * index — `ids` in reading order, `at` the position of each id. Every
 * consumer (ops, view walkers, block selection, clipboard, drag groups)
 * reads this; island sealing is a policy the caller applies on top.
 */
export type DocOrder = { ids: readonly BlockId[]; at: ReadonlyMap<BlockId, number> };

/**
 * Bind the placement model to a concrete engine surface.
 *
 * `Y` must be the vendored v14 module (`import * as Y from
 * 'lib/crdt/vendor/yjs'`). Consumers inject it so this file stays free of
 * runtime vendor imports (see `engine-api.ts`).
 */
export const bindModel = (Y: EngineApi) => {
	/** Construct a detached v14 node, viewed through the structural interface. */
	const newNode = (name: string): EngineNode => makeNode(Y, name);
	const { isKeptReplaced } = engineOps(Y);

	/** The text-ownership engine (streams, claims, anchors). */
	const T = bindText(Y);
	/** The doc's index — every read of derived state goes through it. */
	const R = bindRuns(Y);

	// ── registry / record access ────────────────────────────────────────

	const registryOf = (doc: EngineDoc): EngineNode => doc.get(REGISTRY_KEY);

	const blockNodeOf = (doc: EngineDoc, id: BlockId): EngineNode | null => {
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
	const liveNodeOf = (doc: EngineDoc, id: BlockId): EngineNode | null => {
		const n = blockNodeOf(doc, id);
		return n !== null && !hasDeleteMark(n) ? n : null;
	};

	/** {@link isLiveIn} over the doc's current view. */
	const isLive = (doc: EngineDoc, id: BlockId): boolean => isLiveIn(view(doc), id);

	/**
	 * The history's creation rule (fork patch YP12 `withdraw`, `hist.undo.withdraw`): an
	 * undo never deletes a block the undone step created. Its node and
	 * structure (attrs, placement candidates, the content and claims nodes)
	 * stay and the undoer's withdraw mark is written on it; what the step wrote
	 * inside the content and claims nodes (the undoer's own text, atoms,
	 * boundaries, claims) is deleted as usual. The index shows a withdrawn
	 * block while it holds another writer's content.
	 */
	const withdrawOnUndo =
		(doc: EngineDoc) =>
		(item: EngineItemRef, stackItem: { inserts: { hasId(id: unknown): boolean } }): boolean => {
			const registry = registryOf(doc);
			let below: EngineItemRef = null;
			let cur = item;
			while (cur?.parent !== registry) {
				below = cur;
				cur = (cur?.parent as EngineNode | undefined)?._item ?? null;
				if (cur === null) return false;
			}
			if (!stackItem.inserts.hasId(cur.id)) return false;
			if (below === null) {
				const node = (cur as { content: { type: EngineNode } }).content.type;
				node.setAttr(WITHDRAW_PREFIX + doc.clientID, true);
				return true;
			}
			return below === item || (below.parentSub !== CONTENT && below.parentSub !== CLAIMS);
		};

	// ── placement write ──────────────────────────────────────────────────

	/**
	 * Atomically append one placement candidate `{p, r}` to a block's `at`
	 * map, stamped `seq = localMax+1, client = doc.clientID`, then compact:
	 * candidates below the top-2 are tombstoned (the runner-up survives as
	 * the acyclic fallback; deeper history is re-created by undo anyway).
	 * Must run inside a transaction.
	 */
	const writePlacement = (doc: EngineDoc, node: EngineNode, p: BlockId | null, r: string): void => {
		const at = node.getAttr(AT);
		if (!isNodeLike(at)) throw new Error(`writePlacement: block missing at-map`);
		const cands = candidatesOf(node);
		const seq = (cands[0]?.seq ?? 0) + 1;
		// Tombstone everything below the runner-up (top-2 kept).
		for (const c of cands.slice(2)) at.deleteAttr(c.key);
		at.setAttr(`${seq}.${doc.clientID}`, { p, r });
	};

	// ── derived state ───────────────────────────────────────────────────

	/** The doc's index as a `ModelView` — folded up to the open transaction's last write. */
	const view = (doc: EngineDoc): ModelView => R.attach(doc).view();

	// ── content (rich-text sequence) helpers ────────────────────────────

	/** A detached inline-atom node (inputs arrive normalized by the facade's ingress). */
	const buildInline = (atom: InlineSpec): EngineNode => {
		const node = newNode(INLINE_NODE);
		node.setAttr(ID, atom.id);
		node.setAttr(TYPE, atom.type);
		writeLeaves(node, dataLeaves(atom.data));
		return node;
	};

	// ── structural predicates ───────────────────────────────────────────

	/**
	 * True iff `maybeAncestor` is `id` itself or lies on `id`'s
	 * DISPLAY-ancestor chain — the composed relation `owner(parent)`
	 * (`displayParentOf`), not the raw placement chain. A merge claim can
	 * place a block inside another's display subtree without appearing in
	 * its raw ancestry, so the merge refusal must see through the claim
	 * redirect — this is exactly the relation `resolvePlacements` keeps
	 * acyclic: a merge that would close a cycle is refused without mutation.
	 */
	const isSelfOrDescendant = (
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

	/**
	 * `count` consecutive insertion ranks at `index` into the sibling list
	 * `siblings`.
	 *
	 * Degenerate seams (`left >= right`) are legal replicated states, not
	 * caller errors: equal-rank neighbours occur after cycle-fallback
	 * rehoming (two blocks may carry the same rank string minted in
	 * different sibling lists), and `rankBetween` THROWS on them — so
	 * callers must guard. No string sorts strictly between equal strings,
	 * so each new member takes `left` verbatim: it JOINS the tie and the
	 * `(rank, id)` display sort orders the whole group deterministically.
	 * On a valid seam the emitted chain is `rankBetween(left, right)` then
	 * `rankBetween(prev, right)` — with `run`, `rankAfter` (an insert: after a
	 * block this client ranked, in its run there).
	 */
	const ranksAt = (
		siblings: readonly { rank: string }[],
		index: number,
		count: number,
		clientId: number,
		rand?: () => number,
		run = false
	): string[] => {
		let left = siblings[index - 1]?.rank;
		const right = siblings[index]?.rank;
		if (left !== undefined && right !== undefined && left >= right) {
			return new Array<string>(count).fill(left);
		}
		const out: string[] = [];
		for (let i = 0; i < count; i++) {
			// An insert extends this client's run after a block it ranked.
			const r = run
				? rankAfter(left, right, clientId, rand)
				: rankBetween(left, right, clientId, rand);
			out.push(r);
			left = r;
		}
		return out;
	};

	/**
	 * One registry entry: the block node with its `claims` list (holding
	 * `claims`), its own backing text holding `items` (none for a split-born
	 * block: its stream lives in the text it was split from), and the atomic
	 * first placement candidate `{p, r}` stamped `1.clientID`. Pre-integration
	 * writes materialize when the node integrates (the registry write comes last).
	 */
	const createBlock = (
		doc: EngineDoc,
		id: BlockId,
		type: unknown,
		data: unknown,
		place: PlacementValue,
		claims: MergeClaim[],
		items: readonly ContentItem[] | null,
		n: number = nonceOf(doc)
	): void => {
		const node = newNode(BLOCK_NODE);
		node.setAttr(ID, id);
		node.setAttr(NONCE, n);
		node.setAttr(TYPE, type);
		writeLeaves(node, dataLeaves(data));
		const content = items === null ? null : textOf(items);
		if (content !== null) node.setAttr(CONTENT, content);
		const list = newNode(CLAIMS_NODE);
		node.setAttr(CLAIMS, list);
		if (claims.length > 0) list.insert(0, claims);
		const at = newNode(AT_NODE);
		node.setAttr(AT, at);
		at.setAttr(`1.${doc.clientID}`, place);
		registryOf(doc).setAttr(id, node);
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
	 * Restore definition (migration only; a first import
	 * restores into an empty doc): make `specs` the whole visible document
	 * under their own ids, in ONE transaction. An existing id keeps its
	 * registry entry: every delete mark is cleared and its type, data,
	 * placement and content are rewritten in place — a fresh own text holding
	 * the spec's content and an empty claims list; a block whose stream still
	 * starts at a live boundary gets a new nonce, so that boundary goes inert
	 * and the own text is its stream. An absent id is created. Every other
	 * block gets this writer's delete mark. Ranks are derived from the tree
	 * alone and the rewrites are last-writer-wins attrs, so two replicas
	 * restoring the same specs converge on one copy.
	 */
	const restoreBlocks = (doc: EngineDoc, specs: BlockSpec[]): void =>
		doc.transact(() => {
			const { own } = view(doc);
			const keep = new Set<BlockId>();
			const restore = (list: BlockSpec[], parent: BlockId | null): void => {
				let rank: string | undefined;
				for (const sp of list) {
					keep.add(sp.id);
					let node = blockNodeOf(doc, sp.id);
					if (node === null) {
						node = newNode(BLOCK_NODE);
						node.setAttr(ID, sp.id);
						node.setAttr(NONCE, nonceOf(doc));
						node.setAttr(AT, newNode(AT_NODE));
						registryOf(doc).setAttr(sp.id, node);
					} else if (own.streamOf(sp.id)?.home !== sp.id && own.streamOf(sp.id) !== undefined) {
						node.setAttr(NONCE, nonceOf(doc));
					}
					for (const key of [...node.attrKeys()]) {
						if (key.startsWith(DEL_PREFIX) || key.startsWith(WITHDRAW_PREFIX)) node.deleteAttr(key);
					}
					if (node.getAttr(TYPE) !== sp.type) node.setAttr(TYPE, sp.type);
					writeLeaves(node, patchWrites(node, [{ path: [], value: sp.data ?? {} }]) ?? []);
					const text = textOf(sp.content ?? []);
					node.setAttr(CONTENT, text);
					markText(doc, text, sp.content ?? []);
					node.setAttr(CLAIMS, newNode(CLAIMS_NODE));
					rank = rankBetween(rank, undefined, 0, () => 0);
					writePlacement(doc, node, parent, rank);
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
	 * Materialize one spec subtree: the block owns its backing text (its
	 * stream from index 0); children recurse under a fresh sequential rank
	 * chain (a new block has no siblings to interleave with).
	 */
	const materializeSpec = (
		doc: EngineDoc,
		sp: BlockSpec,
		parent: BlockId | null,
		rank: string
	): void => {
		createBlock(doc, sp.id, sp.type, sp.data, { p: parent, r: rank }, [], sp.content ?? []);
		let left: string | undefined;
		for (const child of sp.children ?? []) {
			const r = rankBetween(left, undefined, doc.clientID, randOf(doc));
			materializeSpec(doc, child, sp.id, r);
			left = r;
		}
	};

	/**
	 * Does any id of `specs` (whole subtrees) collide — with another spec id,
	 * or with any registry entry, live or deleted? The registry is keyed by
	 * id, so writing a taken id would replace that block in place.
	 */
	const collides = (doc: EngineDoc, specs: readonly BlockSpec[]): boolean => {
		const seen = new Set<BlockId>();
		const stack = [...specs];
		while (stack.length > 0) {
			const sp = stack.pop()!;
			// A derived incarnation id (U+0000) is never a caller's.
			if (seen.has(sp.id) || isIncarnationId(sp.id) || blockNodeOf(doc, sp.id) !== null)
				return true;
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
	const insertBlocks = (doc: EngineDoc, dest: Destination, specs: BlockSpec[]): boolean => {
		if (specs.length === 0) return true;
		if (dest.parent !== null && !isLive(doc, dest.parent)) return false;
		if (collides(doc, specs)) return false;
		return doc.transact(() => {
			const sibs = view(doc).kids.get(dest.parent) ?? [];
			const at = Math.max(0, Math.min(dest.index, sibs.length));
			const ranks = ranksAt(sibs, at, specs.length, doc.clientID, randOf(doc));
			specs.forEach((sp, i) => materializeSpec(doc, sp, dest.parent, ranks[i]!));
			return true;
		});
	};

	/**
	 * Split `id` at content `offset` into the new block `newId` placed at
	 * `place`: one boundary item for `newId` at the end of the gap at `offset`
	 * (fork patch YP7) and the merge claims that follow it re-inserted on the new block —
	 * no text is copied, so an offline edit to the tail keeps landing on the
	 * same items and displays in the new block after convergence. `tail` is
	 * the new block's type/data, decided once by the plan. Children are a
	 * separate step. `id` must have a stream or a claim ({@link ownText}).
	 */
	const writeSplit = (
		doc: EngineDoc,
		id: BlockId,
		offset: number,
		newId: BlockId,
		tail: SplitTail,
		place: PlacementValue
	): void => {
		const { blocks, own } = view(doc);
		const n = nonceOf(doc);
		const claims = T.splitAt(blocks, own, id, offset, newId, n);
		const data = tail.data === undefined ? undefined : cloneJson(tail.data);
		createBlock(doc, newId, tail.type, data, place, claims, null, n);
	};

	/**
	 * Give the streamless block `id` its own text (`T.ownText`: a derived
	 * writer, a re-minted nonce) — before the first write that needs a stream.
	 */
	const ownText = (doc: EngineDoc, id: BlockId) => T.ownText(doc, view(doc).blocks.get(id)!);

	// ── queries ─────────────────────────────────────────────────────────

	/**
	 * Canonical projection: pure derivation from replicated state — the
	 * visible tree of live blocks ordered by `(rank, id)`, children of a
	 * merged-away parent under its owner, those of a deleted parent in its
	 * slot ({@link displaySlotOf}). Content is each block's display.
	 */
	const project = (doc: EngineDoc): ProjectedDoc => ({ children: R.attach(doc).project() });

	/**
	 * `positionOf` in a view: the display parent and the index among its
	 * visible children — a binary search by the block's display rank (the
	 * list's own order), not a scan of its siblings.
	 */
	const positionInView = (v: ModelView, id: BlockId): Destination | null => {
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
	const positionOf = (doc: EngineDoc, id: BlockId): Destination | null =>
		positionInView(view(doc), id);

	/** Pre-order ids of the visible tree — the document order. */
	const listBlockIds = (doc: EngineDoc): BlockId[] => [...view(doc).order.ids];

	/** Flat text of a block's OWNED content (atoms render as ''). */
	const blockText = (doc: EngineDoc, id: BlockId): string | null => {
		const v = view(doc);
		return isLiveIn(v, id) ? T.blockTextOf(id, v.blocks, v.own) : null;
	};

	/**
	 * Engine identity of the registry entry (`client:clock` of its item), or
	 * null when the block is absent from the visible tree (deleted, or hidden
	 * under a deleted/unreachable ancestor).
	 */
	const crdtId = (doc: EngineDoc, id: BlockId): string | null => {
		if (!isLive(doc, id)) return null;
		const node = blockNodeOf(doc, id);
		const item = node?._item;
		if (!node || !item || item.deleted || !item.id) return null;
		return `${item.id.client}:${item.id.clock}`;
	};

	/** Engine handle for a logical id, or null when absent or delete-marked (debug surface). */
	const resolveBlock = (doc: EngineDoc, id: BlockId): EngineNode | null => liveNodeOf(doc, id);

	return {
		// constants
		REGISTRY_KEY,
		// records / projection internals (exported for tests + ADR probes)
		registryOf,
		blockNodeOf,
		liveNodeOf,
		isLive,
		candidatesOf,
		/** The doc's index as a `ModelView`. */
		view,
		resolvePlacements,
		childrenIndex,
		positionInView,
		// write primitives (the document's prepared plans apply these)
		buildInline,
		isSelfOrDescendant,
		ranksAt,
		writePlacement,
		withdrawOnUndo,
		materializeSpec,
		collides,
		writeSplit,
		ownText,
		// the seed writer's bulk insert
		insertBlocks,
		insertBlock: (doc: EngineDoc, dest: Destination, spec: BlockSpec) =>
			insertBlocks(doc, dest, [spec]),
		restoreBlocks,
		// queries
		project,
		positionOf,
		listBlockIds,
		blockText,
		crdtId,
		resolveBlock
	};
};

export type PlacementModel = ReturnType<typeof bindModel>;
