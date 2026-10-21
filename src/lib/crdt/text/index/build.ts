/**
 * The per-document index (`indexOf`) as ONE closure: its state, then its
 * parts — the claim graph, the stream table and each block's claims, the
 * layout and table rules, placements and the children index (with THE
 * shown-kind rule, `typeOf`), block records, the run cache, the fold and the
 * change report — each reading the state and the parts before it as closure
 * variables, then the view (`RunView`) over them. `../runs.ts` declares the
 * index's types and contracts. The self-checks (`indexChecks`) read the
 * maintained facts through {@link IndexFacts} and rebuild their own.
 */
import type { EngineDoc, EngineNode, EngineTransaction } from '../../engine-api.js';
import {
	type BlockId,
	type BlockRec,
	bySlot,
	childrenIndex,
	type ChildSlot,
	type ContentItem,
	type DisplayOwnership,
	displaySlotOf,
	type DocOrder,
	documentOrder,
	type ModelView,
	type ProjectedBlock,
	REGISTRY_KEY,
	type ResolvedPlacement
} from '../../placement/model.js';
import {
	CONTENT,
	CONTENT_NODE,
	DOC_DATA_ROOT,
	hasDeleteMark,
	hasWithdrawMark,
	isNodeLike,
	NONCE
} from '../../schema.js';
import {
	changedUnder,
	engineOps,
	firstItem,
	itemOf,
	queuedTransactions,
	sequenceLength,
	type StoreStruct,
	walkRange
} from '../../structs.js';
import {
	gapOfItem,
	headOf,
	type LiveRow,
	placeRow,
	type RowItem,
	rowLength,
	rowOf,
	segmentAt,
	segmentClaims,
	segmentOfCut,
	segmentOfGap,
	shiftGap,
	streamOfSegment
} from '../rows.js';
import type {
	ContentRun,
	DisplayRoles,
	Folded,
	IndexReport,
	KindRole,
	RunView,
	RunViewDebug
} from '../runs.js';
import {
	addTo,
	type Cached,
	CONTENT_ATTR,
	DATA_SEQ_FACET,
	dataOf,
	type Deps,
	dropFrom,
	EMPTY_IDS,
	EMPTY_RUNS,
	ENTRY_FACET,
	type Facet,
	facetOf,
	indexChecks,
	keyOf,
	runEquals,
	sameShape,
	SEQ_FACET,
	typeAttr
} from './shared.js';
import { cloneJsonSafe, sameIds } from '../../../utils/json.js';
import {
	byId,
	canonKey,
	type Claim,
	cmpStamp,
	DEAD,
	deepFreeze,
	displayOf,
	isRowMark,
	type Owner,
	type RangeReadStats,
	readSegs,
	scanText,
	type Stamp,
	type Stream
} from '../model.js';
import { getOr } from '../../../utils.js';
import { removedKeys } from '../streams.js';
import { cellKey, denseKey, keyBetween, LAST_CELL, unlistedCellKey } from '../../placement/keys.js';
import { listedColumns, unlistedRank } from '../../tables.js';
import {
	byTail,
	candidatesOf,
	collectSlots,
	cycleThrough,
	type Edge,
	edgeParentOf,
	homeOf,
	NO_SLOT,
	ownerOfNode,
	positionsOfItem,
	registryOwners,
	slotOwner,
	type SlotRef,
	type Slots,
	slotsBefore
} from '../../placement/resolve.js';
import {
	type BlockSlot,
	cmpStamp as cmpSlotStamp,
	isBlockSlot,
	isDataSlot,
	isRecord,
	sameUnit,
	type SeqItem,
	type Stamp as SlotStamp,
	type Unit,
	unitOf
} from '../../placement/slots.js';
import { Y } from '../../engine.js';
import { readData } from '../../data.js';
import {
	baseIdOf,
	incarnationId,
	incarnationNode,
	incarnationsOf,
	isIncarnationId,
	LIVE_WRITERS
} from '../../incarnations.js';
import { callEach } from '../../protocols/observable.js';

// ── the edits of one fold (narrowed to what changed) ──────────
//
// A keystroke inserts or deletes countable items in one backing text.
// The fold records each edited item (the part the fold's id sets
// cover) per text; `foldTexts` places it in its row's gap by walking to
// the nearest boundary, so the row moves by the edit's units and only
// the display owner of that gap's stream recomputes. A boundary item
// written or removed makes the row rescan; a format marker (its effect
// runs to the next same-key marker) or an unresolvable id makes the
// text opaque: every consumer recomputes.
export type TextEdit = { item: RowItem; n: number };
export type TextEdits = { edits: TextEdit[]; scan: boolean; opaque: boolean };

/** One fold's effects: invalidated blocks, rescanned texts, rebuilt facets. */
export type FoldCtx = {
	invalidated: Set<BlockId>;
	/** Per home block: its text's edits, whether it rescans, whether every reader re-reads. */
	texts: Map<BlockId, { edits: TextEdit[]; scan: boolean; opaque: boolean; seen: Set<TextEdits> }>;
	/** The blocks whose entry or nonce changed: their delimiters are re-decided. */
	named: Set<BlockId>;
	table: boolean;
	/** The winning parents, before and after, of the blocks the fold touched. */
	parents: Set<BlockId>;
};

/** A slot in a children index: its display parent, rank and the island it displays out of. */
export type Slot = { parent: BlockId | null; rank: string; reset?: BlockId };

/** Each row's segments at its last placement: segment 0's block, then each cut's key and block. */
export type Placed = { head: BlockId | null; keys: string[]; blocks: (BlockId | null)[] };

/** The tree the change report last published. */
export type Published = {
	nodes: Map<
		BlockId,
		{
			parent: BlockId | null;
			index: number;
			type: string;
			data: unknown;
			runs: readonly ContentRun[];
			key?: string;
		}
	>;
	order: Map<BlockId | null, readonly BlockId[]>;
	/** The children index version it was taken at. */
	kids: number;
};

/** A transaction as the fold reads it. */
export type Tx = {
	changed?: EngineTransaction['changed'];
	/** What the transaction did to items, in order: per item `kind, client, clock, len` (fork patch YP33). */
	log?: number[];
};

/** The index's self-checks (`indexChecks`), run after each fold and each report. */
export type SelfChecks = { check: () => void; checkPublished: (pub: Published) => void };

/**
 * What the self-checks read of one index: the facts it maintains
 * incrementally (compared with their rebuild from the replicated state) and
 * the reads they compare through.
 */
export type IndexFacts = {
	doc: EngineDoc;
	registry: EngineNode;
	blocks: ReadonlyMap<BlockId, BlockRec>;
	displaysMap: ReadonlyMap<BlockId, ReadonlySet<BlockId>>;
	rows: ReadonlyMap<BlockId, LiveRow>;
	streamIx: ReadonlyMap<BlockId, unknown>;
	delim: ReadonlyMap<BlockId, string>;
	placementsMap: ReadonlyMap<BlockId, ResolvedPlacement>;
	slotsByBlock: ReadonlyMap<BlockId, SlotRef[]>;
	edges: ReadonlyMap<BlockId, Edge | null>;
	rejected: ReadonlySet<BlockId>;
	kids0: Map<BlockId | null, ChildSlot[]>;
	kidsMap: Map<BlockId | null, ChildSlot[]>;
	slots: ReadonlyMap<BlockId, Slot>;
	dissolved: ReadonlySet<BlockId>;
	following: ReadonlySet<BlockId>;
	cache: ReadonlyMap<BlockId, Cached>;
	dirty: ReadonlySet<BlockId>;
	ownShim: DisplayOwnership;
	own0: DisplayOwnership;
	ownerOf: (b: BlockId) => Owner;
	streamOf: (b: BlockId) => Stream | undefined;
	sameClaims: (x: readonly Claim[], y: readonly Claim[]) => boolean;
	dissolve: (kids: Map<BlockId | null, ChildSlot[]>) => Set<BlockId>;
	noteFollowing: (id: BlockId) => void;
	ensurePlacements: () => void;
	computeFresh: (b: BlockId) => { fresh: readonly ContentRun[] };
	unfolded: () => boolean;
	reachable: (prev?: Published['nodes']) => Published;
};

/** One index per engine doc, shared by every binding (the doc's lifetime). */
const indexes = new WeakMap<EngineDoc, RunView>();

/** The doc's index — built on first use, torn down when the doc is destroyed. */
export const indexOf = (doc: EngineDoc): RunView => getOr(indexes, doc, () => buildIndex(doc));

const buildIndex = (doc: EngineDoc): RunView => {
	// ══ The state ═══════════════════════════════════════════════════
	// Every fact the parts share. Containers are created once and mutated in
	// place; the fields a part reassigns (`delim`, `roles`, the children
	// indexes, the counters and flags) are `let`. What one part alone keeps
	// stays in that part.
	// The children index starts as the one without the layout rules (no layout yet).
	let kids0 = new Map<BlockId | null, ChildSlot[]>();
	let slots0 = new Map<BlockId, Slot>();
	const registry = doc.get(REGISTRY_KEY);
	/** The document's own data (`crdt/data.ts`): outside the registry, reported apart. */
	const dataRoot = doc.get(DOC_DATA_ROOT);

	// ── the replicated-state index
	const blocks = new Map<BlockId, BlockRec>();
	/** Withdrawn blocks without a delete mark (`hist.undo.withdraw`), see the fold's `settleShells`. */
	const shells = new Set<BlockId>();
	/** Forward dependencies of cached runs: backing text (by home) / walked block → consumers. */
	const textConsumers = new Map<BlockId, Set<BlockId>>();
	const listConsumers = new Map<BlockId, Set<BlockId>>();

	// ── the claim graph
	/** Owner → the blocks it displays (itself included while it owns itself). */
	const displaysMap = new Map<BlockId, Set<BlockId>>();
	/** Blocks whose claims, delete mark or record changed since the last owner pass. */
	const ownerSeeds = new Set<BlockId>();
	/** Blocks whose owner changed since the last placement pass. */
	const ownerChanged = new Set<BlockId>();

	// ── the stream table
	const rows = new Map<BlockId, LiveRow>();
	let delim = new Map<BlockId, string>();
	/** Each block's segment: its row and the cut that opens it (`null`: the row's segment 0). */
	const streamIx = new Map<BlockId, { home: BlockId; cut: string | null }>();
	const placed = new Map<BlockId, Placed>();
	/** Each row's text → its home (rows are keyed by home). */
	const homeOfText = new WeakMap<object, BlockId>();

	/** Blocks whose claims (implicit, then their stream's claim items) the next pass re-reads. */
	const reclaim = new Set<BlockId>();

	// ── roles
	/** The role table the display reads; `null` → none. */
	let roles: DisplayRoles | null = null;
	/** A stored kind changed since the last report: derived kinds may follow it. */
	let retyped = false;

	// ── placements, the layout rules and the children index
	/** The live blocks the layout rules do not display (`layout.*`), per placement build. */
	let dissolved = new Set<BlockId>();
	/** Resolved placements. */
	const placementsMap = new Map<BlockId, ResolvedPlacement>();
	/** Counts the folds that changed a sequence (a slot or record written or removed): a slot map read before one is stale. */
	let seqEpoch = 0;
	/** Every block slot by the id it names (`{ b }`, fork patch YP22), kept from the folds; a block's home is `homeFor`. */
	const slotsByBlock = new Map<BlockId, SlotRef[]>();
	/** Each sequence owner's blocks (every block whose display edge it holds), sorted by key. */
	const rawOrder = new Map<BlockId | null, ChildSlot[]>();
	/** Each block's display edge as accepted, or its strongest when none is (`null`: no slot). */
	const edges = new Map<BlockId, Edge | null>();
	/** The blocks shown below their strongest edge: a cycle dropped a later move, they are back where they stood. */
	const fallen = new Set<BlockId>();
	/** The blocks at the root's tail: every edge closes a cycle, or no slot. */
	const rejected = new Set<BlockId>();
	/** The children index without the layout rules (what they read), and with them. */
	let kidsMap = kids0;
	/** Each visible block's slot (display parent, rank, the island it displays out of). */
	let slots = slots0;
	/**
	 * The blocks whose shown kind follows their slot — displayed out of
	 * an island, then in a lined island or of a line kind — which the
	 * report re-reads after a retype.
	 */
	const following = new Set<BlockId>();
	/** Bumps whenever a child list changes (the report compares it). */
	let kidsVersion = 0;
	/** The child lists patched since the last report (`all`: every list was rebuilt). */
	const dirtyLists = new Set<BlockId | null>();
	/** The blocks that left every list since the last report. */
	const leftLists = new Set<BlockId>();
	let allListsDirty = true;
	/** The next pass rebuilds everything (first build, roles, an irregular state). */
	let placementFull = true;
	/** Blocks whose slot, record or mover changed; blocks whose display state changed. */
	const placementSeeds = new Set<BlockId>();
	const stateSeeds = new Set<BlockId>();
	/**
	 * Per block: whether its kind is a layout, an item, a lines island
	 * (with its line kind), a table, a table's row or a row's cell.
	 */
	const kindsOf = new Map<
		BlockId,
		{ layout: boolean; item: boolean; line?: string; table: boolean; row: boolean; cell: boolean }
	>();
	/** The item kinds the roles declare, and those the document holds. */
	let itemKinds = new Set<string>();
	/** The row kinds of the table kinds the roles declare and the document holds, with their cell kinds. */
	let rowKinds = new Map<string, string>();
	/** The cell kinds of {@link rowKinds}. */
	let cellKinds = new Set<string>();

	// ── records
	/**
	 * The losing incarnations each key shows (`id.same.concurrent`):
	 * blocks of their own under derived ids, claimed by the key's block
	 * before its own claims (`incarnations.ts`).
	 */
	const incarnations = new Map<BlockId, string[]>();

	// ── the run cache
	const cache = new Map<BlockId, Cached>();
	const dirty = new Set<BlockId>();
	/** The index version (`RunView.version`). */
	let version = 0;
	/** The fold counters `debug` exposes read-only. */
	const foldStats = { folds: 0, pairs: 0, structs: 0, placed: 0 };

	// ── the fold and the report
	/** Frames tracking the folds (the write funnel's `track()`), and the report's candidates. */
	const frames = new Set<Folded>();
	const candidates = new Set<BlockId>();
	let reporting = false;

	// ══ The claim graph ═════════════════════════════════════════════
	// The claim graph (maintained): each block's owner along the max-stamp
	// claims (`top`), the blocks each owner displays, and what a structural
	// change of a block invalidates.
	// ── the claim graph (maintained) ─────────────────────────────
	// `top(m)` is the max-stamp claim on `m` held by a live block; each
	// block's owner follows `top` up (`claimGraph`). A structural change
	// of a block (its claims, its delete mark, its record) re-decides the
	// `top` of the blocks it claims (before and after) and the owners of
	// those blocks and of every block whose `top` chain reaches them —
	// never the whole graph.
	const owners = new Map<BlockId, Owner>();
	const topOf = new Map<BlockId, { claimer: BlockId; stamp: Stamp }>();
	/** Claimer → the blocks it tops. */
	const topInv = new Map<BlockId, Set<BlockId>>();
	/** Claimed block → the blocks whose claims list names it (live or not). */
	const claimersOf = new Map<BlockId, Set<BlockId>>();
	/** The max-stamp claim on `m` held by a live block. */
	const topClaim = (m: BlockId): { claimer: BlockId; stamp: Stamp } | undefined => {
		let best: { claimer: BlockId; stamp: Stamp } | undefined;
		for (const holder of claimersOf.get(m) ?? []) {
			const rec = blocks.get(holder);
			if (rec === undefined || rec.deleted) continue;
			for (const c of rec.claims)
				if (c.m === m && (best === undefined || cmpStamp(c.stamp, best.stamp) > 0))
					best = { claimer: holder, stamp: c.stamp };
		}
		return best;
	};
	const setTop = (m: BlockId, t: { claimer: BlockId; stamp: Stamp } | undefined): boolean => {
		const old = topOf.get(m);
		if (old?.claimer === t?.claimer && (old === undefined || cmpStamp(old.stamp, t!.stamp) === 0))
			return false;
		if (old !== undefined) dropFrom(topInv, old.claimer, m);
		if (t === undefined) topOf.delete(m);
		else {
			topOf.set(m, t);
			addTo(topInv, t.claimer, m);
		}
		return true;
	};
	/** `owner(b)` along `top` (`claimGraph`'s walk), memoized into `owners`. */
	const walkOwner = (b: BlockId): void => {
		const path: BlockId[] = [];
		let cur = b;
		let result: Owner;
		for (;;) {
			const known = owners.get(cur);
			if (known !== undefined) {
				result = known;
				break;
			}
			const rec = blocks.get(cur);
			if (!rec || rec.deleted) {
				result = DEAD;
				break;
			}
			const at = path.indexOf(cur);
			if (at >= 0) {
				let best = topOf.get(path[at])!;
				for (const member of path.slice(at)) {
					const t = topOf.get(member)!;
					if (cmpStamp(t.stamp, best.stamp) > 0) best = t;
				}
				result = best.claimer;
				break;
			}
			const t = topOf.get(cur);
			if (t === undefined) {
				result = cur;
				break;
			}
			path.push(cur);
			cur = t.claimer;
		}
		if (blocks.has(cur)) owners.set(cur, result);
		for (const x of path) owners.set(x, result);
	};
	const setDisplay = (b: BlockId, from: Owner | undefined, to: Owner | undefined): void => {
		if (typeof from === 'string') dropFrom(displaysMap, from, b);
		if (typeof to === 'string') addTo(displaysMap, to, b);
	};
	const ensureOwners = (): void => {
		if (ownerSeeds.size === 0) return;
		// The tops a seed's claims (now, and those it dropped: noted in `claimersOf` changes) decide.
		const affected = new Set<BlockId>();
		const stack: BlockId[] = [];
		const seeds = [...ownerSeeds];
		for (const x of ownerSeeds) {
			stack.push(x);
			for (const m of claimTargets.get(x) ?? []) if (setTop(m, topClaim(m))) stack.push(m);
			for (const c of blocks.get(x)?.claims ?? []) if (setTop(c.m, topClaim(c.m))) stack.push(c.m);
		}
		ownerSeeds.clear();
		claimTargets.clear();
		for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
			if (affected.has(x)) continue;
			affected.add(x);
			for (const m of topInv.get(x) ?? []) stack.push(m);
		}
		const before = new Map<BlockId, Owner | undefined>();
		for (const x of affected) {
			before.set(x, owners.get(x));
			owners.delete(x);
		}
		for (const x of affected) if (blocks.has(x)) walkOwner(x);
		for (const [x, was] of before) {
			const now = owners.get(x);
			if (now === was) continue;
			setDisplay(x, was, now);
			ownerChanged.add(x);
		}
		// A holder whose claims changed re-slots what shows through them: their
		// order among its claims is the key of the blocks shown under it
		// (`claimedRank`) — under its owner when it is itself merged away.
		for (const x of seeds) {
			if (!blocks.has(x)) continue;
			ownerChanged.add(x);
			const o = owners.get(x);
			if (typeof o === 'string' && o !== x) ownerChanged.add(o);
		}
	};
	/** The claims each seed held before its record changed (their tops are re-decided too). */
	const claimTargets = new Map<BlockId, Set<BlockId>>();
	const ownerOf = (b: BlockId): Owner => {
		ensureOwners();
		return owners.get(b) ?? DEAD;
	};

	/** The live claimer of the max-stamp claim on `m` (`DisplayOwnership.top`). */
	const top = (m: BlockId): BlockId | undefined => {
		ensureOwners();
		return topOf.get(m)?.claimer;
	};

	/** The blocks `owner` displays (the delete step's marks). */
	const displays = (owner: BlockId): readonly BlockId[] => {
		ensureOwners();
		return [...(displaysMap.get(owner) ?? [])];
	};

	/** Union-ever claim targets per holder (never shrinks: a dropped claim still invalidates). */
	const effects = new Map<BlockId, Set<BlockId>>();
	const noteEffects = (id: BlockId, claims: readonly Claim[]): void => {
		const fx = getOr(effects, id, () => new Set());
		for (const c of claims) fx.add(c.m);
	};
	/** `id`'s claims went from `before` to `after`: its claim facts follow. */
	const noteClaims = (id: BlockId, before: readonly Claim[], after: readonly Claim[]): void => {
		noteEffects(id, after);
		const was = new Set(before.map((c) => c.m));
		const now = new Set(after.map((c) => c.m));
		for (const m of was)
			if (!now.has(m)) {
				dropFrom(claimersOf, m, id);
				addTo(claimTargets, id, m);
			}
		for (const m of now) if (!was.has(m)) addTo(claimersOf, m, id);
		ownerSeeds.add(id);
	};
	/** A structural change of `id`: its readers, and the blocks it claims, re-read. */
	const invalidateBlock = (id: BlockId, ctx: FoldCtx, claimsBefore: Claim[] = []): void => {
		ctx.invalidated.add(id);
		for (const c of listConsumers.get(id) ?? []) ctx.invalidated.add(c);
		for (const m of new Set([...(effects.get(id) ?? []), ...claimsBefore.map((c) => c.m)])) {
			ctx.invalidated.add(m);
			for (const c of listConsumers.get(m) ?? []) ctx.invalidated.add(c);
		}
	};

	// ══ The stream table ════════════════════════════════════════════
	// The stream table: one maintained row per backing text, the
	// delimiting boundary of each block, each block's segment, and each
	// block's claims (the claim items of its segment).
	// ── the stream table ────────────────────────────────────
	// One maintained row per backing text (keyed by its home block): its
	// live boundaries and the units between them (`text/rows.ts`), the
	// delimiting boundary of each block, and each block's segment. An edit
	// that writes or removes no boundary moves its row by its units
	// (`shiftGap`); a row is rescanned only when its boundary set (or its
	// text) changed, and only the delimiters of the blocks its boundaries
	// name are re-decided, so only the rows those delimiters cut re-place.
	/** Every live boundary naming a block, by block: key → its row and nonce. */
	const boundsBy = new Map<BlockId, Map<string, { home: BlockId; n: unknown }>>();
	const streamOf = (b: BlockId): Stream | undefined => {
		const at = streamIx.get(b);
		const row = at && rows.get(at.home);
		if (row === undefined) return undefined;
		const k = segmentOfCut(row, at!.cut);
		return k < 0 ? undefined : streamOfSegment(row, k, b);
	};
	const streamsIn = (home: BlockId): Stream[] => {
		const row = rows.get(home);
		const out: Stream[] = [];
		for (let k = 0; row !== undefined && k <= row.cuts.length; k++) {
			const b = headOf(row, k);
			if (b !== null) out.push(streamOfSegment(row, k, b));
		}
		return out;
	};
	const streamAt = (home: BlockId, i: number): Stream | undefined => {
		const row = rows.get(home);
		if (row === undefined) return undefined;
		const k = segmentAt(row, i);
		const b = headOf(row, k);
		if (b === null) return undefined;
		const st = streamOfSegment(row, k, b);
		return st.start <= i && i <= st.end ? st : undefined;
	};
	/** Record `home`'s new row (or none); the blocks its boundary set change names join `named`. */
	const setRow = (home: BlockId, row: LiveRow | undefined, named: Set<BlockId>): void => {
		const old = rows.get(home);
		if (row === undefined) rows.delete(home);
		else {
			rows.set(home, row);
			homeOfText.set(row.text, home);
		}
		if (old?.key === row?.key) return;
		for (const b of old?.bounds ?? []) {
			if (b.m !== undefined || row?.keyIndex.has(b.key)) continue;
			const by = boundsBy.get(b.s);
			// A text can change homes (a key's node becomes a losing incarnation,
			// `id.same.concurrent`): drop the entry only while it is still this row's.
			if (by?.get(b.key)?.home === home) by.delete(b.key);
			if (by?.size === 0) boundsBy.delete(b.s);
			named.add(b.s);
		}
		for (const b of row?.bounds ?? []) {
			if (b.m !== undefined || old?.keyIndex.has(b.key)) continue;
			const by = getOr(boundsBy, b.s, () => new Map());
			by.set(b.key, { home, n: b.n });
			named.add(b.s);
		}
	};
	/** A fresh row of `home`'s text (none without one). */
	const scanRow = (home: BlockId): LiveRow | undefined => {
		const text = blocks.get(home)?.content;
		return text === undefined ? undefined : rowOf(scanText(home, text));
	};
	/** A removed block's key (`room.purge.what`): its boundary delimits nobody's stretch. */
	const removed = removedKeys(registry);
	/** A cut's stretch is nobody's when it names no block (a removed one). */
	const nobody = (s: BlockId): boolean => !blocks.has(s);
	/** Re-decide the delimiting boundary of each block in `named`; the rows a change cuts join `homes`. */
	const refreshDelims = (named: Iterable<BlockId>, homes: Set<BlockId>): void => {
		for (const s of named) {
			const rec = blocks.get(s);
			const gone = rec === undefined && removed(s);
			let best: string | undefined;
			if (rec !== undefined || gone)
				for (const [key, b] of boundsBy.get(s) ?? [])
					if ((gone || b.n === rec!.n) && (best === undefined || byId(key, best) < 0)) best = key;
			const old = delim.get(s);
			if (old === best) {
				// The cut stays, and the block it opens may have come or gone (removed).
				if (best !== undefined) homes.add(boundsBy.get(s)!.get(best)!.home);
				continue;
			}
			if (best === undefined) delim.delete(s);
			else delim.set(s, best);
			const was = old === undefined ? undefined : boundsBy.get(s)?.get(old)?.home;
			if (was !== undefined) homes.add(was);
			if (best !== undefined) homes.add(boundsBy.get(s)!.get(best)!.home);
			if (rows.has(s) || placed.has(s)) homes.add(s);
		}
	};
	/**
	 * Place `home`'s row; invalidate the blocks whose segment changed (or
	 * appeared, or went). A segment is its two delimiting cuts, so only the
	 * segments between the longest common prefix and suffix of the old and
	 * new cut lists can differ: the others keep their entries untouched.
	 */
	const placeHome = (home: BlockId, invalidated: Set<BlockId>): void => {
		const row = rows.get(home);
		const before = placed.get(home) ?? { head: null, keys: [], blocks: [] };
		const now: Placed = { head: null, keys: [], blocks: [] };
		if (row !== undefined) {
			placeRow(row, delim, nobody);
			now.head = row.head;
			row.cuts.forEach((j, k) => {
				now.keys.push(row.bounds[j].key);
				now.blocks.push(row.heads[k]);
			});
		}
		if (row === undefined) placed.delete(home);
		else placed.set(home, now);
		// Its segments' claim items may have changed, or gone to other blocks.
		for (const x of [before, now]) {
			if (x.head !== null) reclaim.add(x.head);
			for (const b of x.blocks) if (b !== null) reclaim.add(b);
		}
		const [a, b] = [before.keys, now.keys];
		// A cut is the same when its boundary and the block it opens are (a
		// removed block's cut opens nobody's stretch).
		const same = (i: number, j: number) => a[i] === b[j] && before.blocks[i] === now.blocks[j];
		let p = 0;
		while (p < a.length && p < b.length && same(p, p)) p++;
		let q = 0;
		while (q < a.length - p && q < b.length - p && same(a.length - 1 - q, b.length - 1 - q)) q++;
		// Segment k ends at cut k: it changed iff k lies in [p, n - q] (segment 0 also with its block).
		const from = before.head === now.head ? p : 0;
		const changed = (blk: BlockId | null): void => {
			if (blk === null) return;
			invalidated.add(blk);
			for (const c of listConsumers.get(blk) ?? []) invalidated.add(c);
		};
		const blockOf = (x: Placed, k: number) => (k === 0 ? x.head : x.blocks[k - 1]);
		for (let k = from; k <= a.length - q; k++) {
			const blk = blockOf(before, k);
			if (blk !== null && streamIx.get(blk)?.home === home) streamIx.delete(blk);
			changed(blk);
		}
		for (let k = from; k <= b.length - q; k++) {
			const blk = blockOf(now, k);
			if (blk === null) continue;
			streamIx.set(blk, { home, cut: k === 0 ? null : b[k - 1] });
			changed(blk);
		}
	};
	/** Rebuild the delimiters and every row's segments (the first build). */
	const rebuildTable = (invalidated: Set<BlockId>): void => {
		boundsBy.clear();
		for (const [home, row] of rows)
			for (const b of row.bounds) {
				if (b.m !== undefined) continue;
				const by = getOr(boundsBy, b.s, () => new Map());
				by.set(b.key, { home, n: b.n });
			}
		delim = new Map();
		const homes = new Set<BlockId>([...rows.keys(), ...placed.keys()]);
		refreshDelims(boundsBy.keys(), homes);
		for (const home of homes) placeHome(home, invalidated);
	};

	// ── claims ──────────────────────────────────────────────
	// A block's claims are its implicit ones (`id.same.concurrent`), then
	// the claim items of its segment, in text order (fork patch YP21:
	// YATA placed each one, so a split its writer did not see leaves it in
	// the piece that ends its holder's region, `merge.claim.anchor`). They
	// change with the record (its implicit claims) and with its row's bounds
	// or cuts: re-read after each fold's texts for the blocks queued.
	const sameClaims = (x: readonly Claim[], y: readonly Claim[]): boolean =>
		x.length === y.length &&
		x.every((c, i) => c.m === y[i].m && cmpStamp(c.stamp, y[i].stamp) === 0);
	/** `b`'s claims now: its implicit ones, then its segment's claim items. */
	const claimsOf = (b: BlockId): Claim[] => {
		const at = streamIx.get(b);
		const row = at && rows.get(at.home);
		const k = row === undefined ? -1 : segmentOfCut(row, at!.cut);
		const items = k < 0 ? [] : segmentClaims(row!, k);
		const implicit = blocks.get(b)?.implicit ?? [];
		return implicit.length === 0 ? items : [...implicit, ...items];
	};
	/** Re-read the claims of the blocks queued; a change is a structural change of the block. */
	const applyReclaims = (ctx: FoldCtx | null): void => {
		for (const b of reclaim) {
			const rec = blocks.get(b);
			if (rec === undefined) continue;
			const before = rec.claims;
			const after = claimsOf(b);
			if (sameClaims(before, after)) continue;
			rec.claims = after;
			noteClaims(b, before, after);
			if (ctx !== null) invalidateBlock(b, ctx, before);
		}
		reclaim.clear();
	};

	// ══ The layout and table rules ══════════════════════════════════
	// The layout rules (`layout.*`) and the table rules (`table.*`) over a
	// children index, and the role table's answers for a block's stored kind
	// they read.
	/** The role of `b`'s stored kind; `undefined` without roles or a record. */
	const kindOf = (b: BlockId): KindRole | undefined => {
		const type = blocks.get(b)?.type;
		return roles === null || type === undefined ? undefined : roles.of(type);
	};
	/** The line kind of `b` when it is an island declared `lines`. */
	const lineKind = (b: BlockId): string | undefined => kindOf(b)?.line;
	/** The item kind of `b` when it is a layout. */
	const itemKind = (b: BlockId): string | undefined => kindOf(b)?.layout;
	/** The row kind of `b` when it is a table (`table.*`). */
	const rowKind = (b: BlockId): string | undefined => kindOf(b)?.table;
	/** `table`'s row kind and that row kind's cell kind, as `[row, cell]`. */
	const rowOfTable = (table: string): [string, string] | undefined => {
		const row = roles?.of(table).table;
		return row === undefined ? undefined : [row, roles!.of(row).child];
	};
	/** The cell kind of `b` when it is a row of a table kind. */
	const cellKind = (b: BlockId): string | undefined => rowKinds.get(blocks.get(b)?.type ?? '');
	/**
	 * The column ids of table `table` in their order, each with its
	 * position (`data.columns[i].id`), or `null` when it is no table or
	 * holds no `columns` array: its cells then show in their own order.
	 * Read from the record's data, memoized per data object.
	 */
	const columnsMemo = new WeakMap<object, Map<string, number> | null>();
	const columnsOf = (table: BlockId): Map<string, number> | null => {
		if (rowKind(table) === undefined) return null;
		const data = blocks.get(table)?.data;
		if (data === null || typeof data !== 'object') return null;
		let index = columnsMemo.get(data);
		if (index === undefined) {
			const ids = listedColumns(data);
			columnsMemo.set(data, (index = ids && new Map(ids.map((id, i) => [id, i]))));
		}
		return index;
	};
	/** The column a cell names (`data.column`), if any. */
	const columnOf = (cell: BlockId): string | undefined => {
		const c = (blocks.get(cell)?.data as { column?: unknown } | null | undefined)?.column;
		return typeof c === 'string' ? c : undefined;
	};
	/**
	 * What of `b`'s data the table rules read, as one key: a table's column
	 * ids, a cell's column (`''` for any other block). A change of it
	 * re-places the table's cells.
	 */
	const tableFacts = (b: BlockId, data: unknown): string => {
		const k = kindsOf.get(b);
		if (data === null || typeof data !== 'object') return '';
		if (k?.table) return JSON.stringify(listedColumns(data));
		if (k?.cell) {
			const c = (data as { column?: unknown }).column;
			return typeof c === 'string' ? c : '';
		}
		return '';
	};
	/**
	 * The rank cell `id` displays at in row `row` (`table.columns`): its
	 * column's position in the table holding the row, so every row shows its
	 * cells in the table's column order whatever their placements (a key of
	 * the position, ties by block id); a withdrawn cell of a
	 * column the table no longer lists after them, its column's place among
	 * those fixed by its id (`unlistedRank`); any other cell of no listed
	 * column last (it does not display, `table.cell`).
	 * `undefined`: no table with columns holds the row — its placement rank.
	 */
	const cellRank = (row: BlockId, id: BlockId): string | undefined => {
		const cell = cellKind(row);
		if (cell === undefined || blocks.get(id)?.type !== cell) return undefined;
		const table = placementsMap.get(row)?.parent;
		const index = typeof table === 'string' ? columnsOf(table) : null;
		if (index === null) return undefined;
		const column = columnOf(id);
		const at = column === undefined ? undefined : index.get(column);
		if (at === undefined && column !== undefined && shells.has(id))
			return unlistedCellKey(unlistedRank(column));
		return at === undefined ? LAST_CELL : cellKey(at);
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
	/**
	 * Where a visited node stands for the table rules: directly in a table,
	 * or directly in a row of one (with the table's columns and the columns
	 * a cell already took).
	 */
	type TableCtx =
		| { table: BlockId }
		| { row: BlockId; columns: Map<string, number> | null; seen: Set<string> }
		| null;
	/**
	 * The table rules (`table.*`), in the same pass: a cell displays only in
	 * a row of a table, and, when the table lists its columns, only for a
	 * listed column — or, withdrawn by an undo while it holds another
	 * writer's text (`hist.undo.withdraw`), for the column the undo took out
	 * of the list — and as the first of the row's cells for it
	 * (`table.cell`); a row displays only in a table and while it shows a
	 * cell (`table.row`); a table displays while it shows a row
	 * (`table.empty`). What does not display hands up nothing a table rule
	 * shows: a cell's text goes with it.
	 */
	const tableVisit = (
		kids: Map<BlockId | null, ChildSlot[]>,
		out: Set<BlockId>,
		id: BlockId,
		ctx: TableCtx,
		shown: Shown[]
	): void => {
		const k = kindsOf.get(id)!;
		const childIds = (kids.get(id) ?? []).map((c) => c.id);
		const pass = (sub: Shown[]) => {
			out.add(id);
			shown.push(...sub.filter((x) => !isTableish(x.id)));
		};
		if (k.table) {
			const sub = dissolveVisit(kids, out, childIds, false, { table: id });
			if (sub.some((x) => kindsOf.get(x.id)?.row)) shown.push({ id, kids: sub.map((x) => x.id) });
			else pass(sub);
		} else if (k.row) {
			const table = ctx !== null && 'table' in ctx ? ctx.table : null;
			const sub = dissolveVisit(
				kids,
				out,
				childIds,
				false,
				table === null ? null : { row: id, columns: columnsOf(table), seen: new Set() }
			);
			if (table !== null && sub.some((x) => kindsOf.get(x.id)?.cell))
				shown.push({ id, kids: sub.map((x) => x.id) });
			else pass(sub);
		} else {
			const sub = dissolveVisit(kids, out, childIds, false, null);
			const row = ctx !== null && 'row' in ctx ? ctx : null;
			let shows = row !== null;
			if (row !== null && row.columns !== null) {
				const column = columnOf(id);
				shows =
					column !== undefined &&
					(row.columns.has(column) || shells.has(id)) &&
					!row.seen.has(column);
				if (shows) row.seen.add(column!);
			}
			if (shows) shown.push({ id, kids: sub.map((x) => x.id) });
			else pass(sub);
		}
	};
	/** `b`'s kind is a table, a table's row or a row's cell. */
	const isTableish = (b: BlockId): boolean => {
		const k = kindsOf.get(b);
		return k !== undefined && (k.table || k.row || k.cell);
	};
	const dissolveVisit = (
		kids: Map<BlockId | null, ChildSlot[]>,
		out: Set<BlockId>,
		ids: readonly BlockId[],
		layout: boolean,
		ctx: TableCtx = null
	): Shown[] => {
		const isItem = (b: BlockId) => itemKinds.has(blocks.get(b)?.type ?? '');
		const shown: Shown[] = [];
		for (const id of ids) {
			if (isTableish(id)) {
				tableVisit(kids, out, id, ctx, shown);
				continue;
			}
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
			return k !== undefined && (k.layout || k.item || k.table || k.row || k.cell);
		};
		const roots = new Set<BlockId>();
		const climb = (b: BlockId | null | undefined): void => {
			let top: BlockId | undefined;
			for (let x = b; typeof x === 'string' && isLayoutish(x); x = slots0.get(x)?.parent) top = x;
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
			climb(slots0.get(id)?.parent);
			for (const k of kids0.get(id) ?? []) climb(k.id);
			// Only a layout, an item or a table's block dissolves: one that left those kinds shows again.
			if (!isLayoutish(id) && dissolved.delete(id)) flips.add(id);
		}
		for (const root of roots) {
			if (!slots0.has(root)) continue;
			const parent = slots0.get(root)!.parent;
			const nodes: BlockId[] = [];
			const stack = [root];
			for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
				nodes.push(x);
				for (const k of kids0.get(x) ?? []) stack.push(k.id);
			}
			const out = new Set<BlockId>();
			dissolveVisit(kids0, out, [root], parent !== null && itemKind(parent) !== undefined);
			for (const x of nodes) {
				if (out.has(x) === dissolved.has(x)) continue;
				if (out.has(x)) dissolved.add(x);
				else dissolved.delete(x);
				flips.add(x);
			}
		}
		// A block that left the index (hidden, removed) dissolves no more.
		for (const id of changed.keys()) if (!slots0.has(id) && dissolved.delete(id)) flips.add(id);
		return flips;
	};

	// ══ Placements and the children index ═══════════════════════════
	// Placements and the children index (maintained), the display
	// ownership the display reads (`ownShim`), and THE shown-kind rule
	// (`typeOf`).
	//
	// A structural change re-decides only what it can change: the display
	// edge of the blocks whose slot, record or mover changed (fork patch
	// YP22), and the display slot of every block whose slot walk
	// (`displaySlotOf`) reads one that changed — its stored subtree, through
	// the blocks it displays — patched into the parents' child lists. A
	// block's candidate edges are its live move records, strongest first, then
	// its home slot; it shows at the first that closes no cycle through the
	// accepted edges (`settle`): the later move wins, and the block whose edge
	// is the oldest of a cycle falls back to its next candidate, back where it
	// stood (its previous record, else home; the root's tail only when every
	// candidate closes a cycle), so a cycle resolves locally: no global pass.
	// The first build places every block the same way (their unique acyclic
	// acceptance, whatever the order; the tests' greedy rebuild,
	// `src/tests/oracles/placements.ts`, is what the self-checks compare). A
	// placed block's order key is found from its sequence neighbours
	// (`placement/keys.ts`), never by walking the parent's sequence; a rebuild
	// keys every list once, in its sequence's order. The layout rules re-run
	// only on the layouts a change reaches.
	/** Fork patch YP14's predicate: the registry values the engine keeps. */
	const kept = engineOps(Y).isKeptReplaced;

	// ── placements and the children index (maintained) ────────────
	/** The document holds a layout or an item kind: `kids0` and `kidsMap` differ. */
	let layoutMode = false;
	/** The line kinds the roles declare, and those of the lines islands the document holds. */
	let lineKinds = new Set<string>();
	let orderCache: DocOrder | null = null;
	let layoutBlocks = 0;
	let itemBlocks = 0;
	/** Tables, rows and cells (`table.*`): their rules run in the layout pass. */
	let tableBlocks = 0;
	const lineCounts = new Map<string, number>();
	const ownShim: DisplayOwnership = {
		ownerOf,
		hidden: (b) => ownerOf(b) !== b || dissolved.has(b),
		childless: (b) => kindOf(b)?.childless === true,
		island: (b) => kindOf(b)?.island === true,
		container: (b) => kindOf(b)?.container === true,
		lined: (b) => lineKind(b) !== undefined,
		passes: (b) => dissolved.has(b),
		sheds: (owner, child) => {
			// A layout shows only its items, a table its rows, a row its cells.
			const only = itemKind(owner) ?? rowKind(owner) ?? cellKind(owner);
			return only !== undefined && blocks.get(child)?.type !== only;
		},
		slotRank: (owner, id) => cellRank(owner, id),
		top,
		claimIndex: (holder, m) => blocks.get(holder)?.claims.findIndex((c) => c.m === m) ?? -1,
		streamOf,
		streamsIn,
		streamAt,
		display: (b) => displayOf(b, blocks, ownShim)
	};
	/** Re-count `id`'s kind facts; a fact the roles never declared forces a full pass. */
	const noteKind = (id: BlockId): void => {
		const old = kindsOf.get(id);
		const type = blocks.get(id)?.type;
		const now =
			type === undefined
				? undefined
				: {
						layout: itemKind(id) !== undefined,
						item: itemKinds.has(type),
						line: lineKind(id),
						table: rowKind(id) !== undefined,
						row: rowKinds.has(type),
						cell: cellKinds.has(type)
					};
		const tableish = (k: { table: boolean; row: boolean; cell: boolean } | undefined) =>
			k?.table || k?.row || k?.cell ? 1 : 0;
		tableBlocks += tableish(now) - tableish(old);
		if (old?.layout) layoutBlocks--;
		if (old?.item) itemBlocks--;
		if (old?.line !== undefined) lineCounts.set(old.line, lineCounts.get(old.line)! - 1);
		if (now === undefined) kindsOf.delete(id);
		else kindsOf.set(id, now);
		if (now?.layout) layoutBlocks++;
		if (now?.item) itemBlocks++;
		if (now?.line !== undefined) lineCounts.set(now.line, (lineCounts.get(now.line) ?? 0) + 1);
		const item = itemKind(id);
		if (item !== undefined && !itemKinds.has(item)) placementFull = true;
		if (now?.line !== undefined && !lineKinds.has(now.line)) placementFull = true;
		// A table of a kind whose row the index does not know yet: its rows and cells change kind facts.
		const rows = type === undefined ? undefined : rowOfTable(type);
		if (rows !== undefined && rowKinds.get(rows[0]) !== rows[1]) placementFull = true;
		if (layoutMode !== layoutBlocks + itemBlocks + tableBlocks > 0) placementFull = true;
	};
	/** The ownership the layout rules read: none of their decisions applied. */
	const own0: DisplayOwnership = {
		...ownShim,
		hidden: (b) => ownerOf(b) !== b,
		passes: () => false
	};
	/** `id`'s slot in the index `own` reads (none: hidden, or under no live parent). */
	const slotIn = (own: DisplayOwnership, id: BlockId): Slot | undefined => {
		const pl = placementsMap.get(id);
		if (pl === undefined || !blocks.has(id) || own.hidden(id)) return undefined;
		const { parent, rank, reset } = displaySlotOf(own, placementsMap, pl, id);
		if (parent === DEAD) return undefined;
		return reset === null ? { parent, rank } : { parent, rank, reset };
	};
	/** The index of the first slot of `list` not before `x`. */
	const seek = (list: readonly ChildSlot[], x: { id: BlockId; rank: string }): number => {
		let lo = 0;
		let hi = list.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (bySlot(list[mid], x) < 0) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	};
	/**
	 * Re-decide the slots of `affected` in `kids`/`slotMap` (read through
	 * `own`), patching the child lists they leave or join (each list
	 * copied once: a list a reader holds never changes under it). Returns
	 * the blocks whose slot changed, with their parents before and after.
	 */
	const patch = (
		kids: Map<BlockId | null, ChildSlot[]>,
		slotMap: Map<BlockId, Slot>,
		own: DisplayOwnership,
		affected: Iterable<BlockId>
	): Map<BlockId, [BlockId | null | undefined, BlockId | null | undefined]> => {
		const changed = new Map<BlockId, [BlockId | null | undefined, BlockId | null | undefined]>();
		const copies = new Map<BlockId | null, ChildSlot[]>();
		const list = (p: BlockId | null): ChildSlot[] => {
			return getOr(copies, p, () => [...(kids.get(p) ?? [])]);
		};
		for (const id of affected) {
			const old = slotMap.get(id);
			const next = slotIn(own, id);
			if (
				old?.parent === next?.parent &&
				old?.rank === next?.rank &&
				old?.reset === next?.reset &&
				(old === undefined) === (next === undefined)
			)
				continue;
			if (old !== undefined) {
				const l = list(old.parent);
				const at = seek(l, { id, rank: old.rank });
				if (l[at]?.id === id) l.splice(at, 1);
			}
			if (next !== undefined) {
				const l = list(next.parent);
				const slot: ChildSlot =
					next.reset === undefined
						? { id, rank: next.rank }
						: { id, rank: next.rank, reset: next.reset };
				l.splice(seek(l, slot), 0, slot);
				slotMap.set(id, next);
			} else {
				slotMap.delete(id);
				if (kids === kidsMap) leftLists.add(id);
			}
			changed.set(id, [old?.parent, next?.parent]);
		}
		for (const [p, l] of copies) {
			if (l.length === 0) kids.delete(p);
			else kids.set(p, l);
			if (kids === kidsMap) dirtyLists.add(p);
		}
		return changed;
	};
	/** `seeds` and every block whose slot walk reads one of them: stored subtrees, through what each displays. */
	const reach = (seeds: Iterable<BlockId>): Set<BlockId> => {
		const out = new Set<BlockId>();
		const stack = [...seeds];
		for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
			if (out.has(x)) continue;
			out.add(x);
			for (const c of rawOrder.get(x) ?? []) stack.push(c.id);
			for (const d of displaysMap.get(x) ?? [])
				if (d !== x) for (const c of rawOrder.get(d) ?? []) stack.push(c.id);
		}
		return out;
	};
	/** Whether `id` shows as its slot's kind (`following`): read from its slot and kinds. */
	const noteFollowing = (id: BlockId): void => {
		const slot = slots.get(id);
		const follows =
			slot !== undefined &&
			(slot.reset !== undefined ||
				(slot.parent !== null && lineKind(slot.parent) !== undefined) ||
				lineKinds.has(blocks.get(id)?.type ?? ''));
		if (follows) following.add(id);
		else following.delete(id);
	};

	// ── edges, keys and acceptance ─────────────────────────────────
	/**
	 * Whether the slot map has been read from the sequences: once, before the
	 * first rebuild (a shell settled on the first fold asks for a home), then
	 * the fold keeps it and every rebuild fills it again.
	 */
	let slotsRead = false;
	/** What the first read collected, for a rebuild while no sequence changed since (one scan). */
	let collected: Slots | null = null;
	let collectedAt = -1;
	const readSlots = (): void => {
		slotsRead = true;
		slotsByBlock.clear();
		// Every registry node, its kept incarnations too (the records may not all be built yet).
		collected = collectSlots(doc, registryOwners(registry, kept));
		collectedAt = seqEpoch;
		for (const [b, refs] of collected.slots) slotsByBlock.set(b, refs);
	};
	/** Put `ref` (`null`: none) where the slot map holds unit `u` of the slots naming id `b`. */
	const putSlot = (b: BlockId, u: Unit, ref: SlotRef | null): void => {
		const list = (slotsByBlock.get(b) ?? []).filter((x) => !sameUnit(x, u));
		if (ref !== null) list.push(ref);
		if (list.length === 0) slotsByBlock.delete(b);
		else slotsByBlock.set(b, list);
	};
	/** `id`'s home slot among the slots naming its registry id (`null`: none). */
	const homeFor = (id: BlockId): ReturnType<typeof homeOf> => {
		if (!slotsRead) readSlots();
		return homeOf(registry, kept, slotsByBlock, id);
	};
	/**
	 * Re-own the home slots of `node`'s sequence after the registry value it
	 * stands for changed (a concurrent creation of one id won or lost, its
	 * losing incarnation shown or not): each slot's parent is the node's owner
	 * now, and its block re-placed; a node that is no block of the document
	 * any more holds no slot (as a rebuild reads it).
	 */
	const reslot = (node: EngineNode): void => {
		if (!slotsRead) return; // the first read collects them as they are
		const owner = ownerOfNode(registry, kept, node);
		for (let it = firstItem<SeqItem>(node); it !== null; it = it.right)
			for (const { value, unit, via } of positionsOfItem(doc, it)) {
				if (via !== null) continue; // a record's unit is another sequence's slot
				const b = (value as BlockSlot).b;
				putSlot(b, unit, owner === undefined ? null : { parent: owner, ...unit });
				for (const id of new Set([b, slotOwner(registry, kept, b, unit.c)])) {
					const rec = blocks.get(id);
					if (rec !== undefined) rec.home = homeOf(registry, kept, slotsByBlock, id);
					placementSeeds.add(id);
				}
			}
	};
	/** The slot items a rebuild collected (its homes' items, read once), while it places every block. */
	let known: Map<SlotRef, SeqItem> | null = null;
	/** `id`'s candidate edges, read from the engine: its live records, strongest first, then home (`[]`: no slot, or gone). */
	const candidatesFor = (id: BlockId): Edge[] => {
		const home = blocks.get(id)?.home ?? homeFor(id);
		return home === null ? [] : candidatesOf(doc, registry, kept, home, known?.get(home));
	};
	/** The owner of the sequence `id`'s slot shows in as the engine stands (its mover's, else home's; `null`: the root). */
	const edgeParent = (id: BlockId): BlockId | null | undefined => {
		const home = blocks.get(id)?.home ?? homeFor(id);
		return home === null ? undefined : edgeParentOf(doc, registry, kept, home);
	};
	/** The raw children of `parent` in order (every block whose edge parent it is), kept sorted by key. */
	const rawList = (parent: BlockId | null): ChildSlot[] => {
		return getOr(rawOrder, parent, () => []);
	};
	/** Counts the placement writes: a key's walk that saw one happen under it walks again. */
	let placedEpoch = 0;
	/** Whether a placement is keyed as it is decided: not while a rebuild places every block (it keys them after, in one pass). */
	let keyed = true;
	const setPlacement = (id: BlockId, pl: ResolvedPlacement | undefined): void => {
		foldStats.placed++;
		placedEpoch++;
		const old = placementsMap.get(id);
		if (keyed && old !== undefined) {
			const l = rawList(old.parent);
			const at = seek(l, { id, rank: old.rank });
			if (l[at]?.id === id) l.splice(at, 1);
			if (l.length === 0) rawOrder.delete(old.parent);
		}
		if (pl === undefined) placementsMap.delete(id);
		else {
			placementsMap.set(id, pl);
			if (!keyed) return;
			const l = rawList(pl.parent);
			const slot = { id, rank: pl.rank };
			l.splice(seek(l, slot), 0, slot);
		}
	};
	/**
	 * The key `id` takes under `edge.parent`: between the key of the nearest
	 * block shown where it stands before `id`'s place in the sequence (placed
	 * first when it is a pending seed; walked past when it shows elsewhere)
	 * and the next key of that list. Placing a pending neighbour can drop a
	 * block the walk already passed back into that stretch (a cycle's
	 * fallback, back where it stood): a walk under which a placement changed
	 * walks again, so the key it returns reads one state.
	 */
	const keyFor = (id: BlockId, edge: Edge, place: (b: BlockId) => void): string => {
		for (;;) {
			const before = placedEpoch;
			const lrank = leftKey(id, edge, place);
			if (placedEpoch !== before) continue;
			const list = rawOrder.get(edge.parent as BlockId | null) ?? [];
			const i = lrank === undefined ? 0 : seek(list, { id: '', rank: lrank }) + 1;
			return keyBetween(lrank, list[i]?.rank);
		}
	};
	/** The key of the nearest block shown before `id`'s place at `edge`, under its parent (`undefined`: none). */
	const leftKey = (id: BlockId, edge: Edge, place: (b: BlockId) => void): string | undefined => {
		const home = blocks.get(id)?.home ?? homeFor(id)!;
		for (const e of slotsBefore(doc, edge, home)) {
			const b = slotOwner(registry, kept, (e.value as { b: BlockId }).b, e.unit.c);
			// `id` itself (its place before this one) keys nothing.
			if (b === id) continue;
			// A slot that is not its block's home (a second creation of one id) places nothing.
			const h = blocks.get(b)?.home ?? homeFor(b);
			if (h === null || !sameUnit(h, e.unit)) continue;
			place(b);
			const pl = placementsMap.get(b);
			const shows = edges.get(b);
			if (
				pl !== undefined &&
				pl.parent === edge.parent &&
				!rejected.has(b) &&
				shows != null &&
				shows.via === e.via
			)
				return pl.rank;
		}
		return undefined;
	};
	/** The key of `id` at the root's tail, among the rejected by stamp then id, after the last top-level block. */
	const tailKey = (id: BlockId, stamp: SlotStamp): string => {
		const tail = [...rejected]
			.filter((x) => x !== id)
			.map((x) => ({ id: x, stamp: edges.get(x)?.stamp ?? NO_SLOT }))
			.sort(byTail);
		const list = rawOrder.get(null) ?? [];
		const me = { id, stamp };
		let at = 0;
		while (at < tail.length && byTail(tail[at]!, me) < 0) at++;
		const prev =
			at > 0
				? placementsMap.get(tail[at - 1]!.id)?.rank
				: list[list.length - tail.length - 1]?.rank;
		const next = at < tail.length ? placementsMap.get(tail[at]!.id)?.rank : undefined;
		return keyBetween(prev, next);
	};
	/** Show `id` at the root's tail: every edge closes a cycle, or none. */
	const reject = (id: BlockId, edge: Edge | null): void => {
		edges.set(id, edge);
		if (placementsMap.has(id)) setPlacement(id, undefined);
		fallen.delete(id);
		rejected.add(id);
		const rank = keyed ? tailKey(id, edge?.stamp ?? NO_SLOT) : '';
		setPlacement(id, { parent: null, rank });
	};
	/** The same display edge: the same sequence, the same record, the same stamp. */
	const sameEdge = (a: Edge, b: Edge): boolean =>
		a.parent === b.parent && a.via === b.via && cmpSlotStamp(a.stamp, b.stamp) === 0;
	/** Whether `edge` (of `id`) is a place `id` may take now: a live parent, and no cycle it would be the oldest edge of. */
	const admits = (id: BlockId, edge: Edge): { ok: boolean; drop: BlockId | null } => {
		const parent = edge.parent;
		if (parent === undefined || (parent !== null && !blocks.has(parent)))
			return { ok: false, drop: null };
		const cycle = cycleThrough(placementsMap, ownerOf, id, parent);
		if (cycle === null) return { ok: true, drop: null };
		let [min, minStamp] = [id, edge.stamp];
		for (const m of cycle) {
			const e = m === id ? edge : edges.get(m);
			if (m !== id && e && cmpSlotStamp(e.stamp, minStamp) < 0) [min, minStamp] = [m, e.stamp];
		}
		return min === id ? { ok: false, drop: null } : { ok: true, drop: min };
	};
	/**
	 * Place `id` at its strongest candidate edge from `from` on that closes no
	 * cycle it would be the oldest edge of (the later move wins). When the
	 * edge closes a cycle through an older edge, that edge's block is dropped
	 * to its next candidate (back where it stood before that move), and so on
	 * down its records to home; a block every candidate of which fails shows
	 * at the root's tail. `place` places a pending neighbour first. Returns
	 * the blocks whose placement changed.
	 */
	const settle = (id: BlockId, place: (b: BlockId) => void, from = 0): BlockId[] => {
		const changed = [id];
		const cands = candidatesFor(id);
		for (let n = from; n < cands.length; n++) {
			const edge = cands[n]!;
			// The key first: its walk places the pending neighbours, so the cycle
			// check reads them placed (a neighbour placed after it could close a
			// cycle through `id` that no check saw).
			const rank = keyed ? keyFor(id, edge, place) : '';
			const { ok, drop } = admits(id, edge);
			if (!ok) continue;
			edges.set(id, edge);
			rejected.delete(id);
			if (n > 0) fallen.add(id);
			else fallen.delete(id);
			if (placementsMap.has(id)) setPlacement(id, undefined);
			setPlacement(id, { parent: edge.parent as BlockId | null, rank });
			if (drop !== null) {
				const now = edges.get(drop);
				const at = now ? candidatesFor(drop).findIndex((c) => sameEdge(c, now)) : -1;
				changed.push(...settle(drop, () => {}, at + 1));
			}
			return changed;
		}
		reject(id, cands[0] ?? null);
		return changed;
	};
	/** Whether a candidate stronger than `id`'s accepted edge would take it now. */
	const canRise = (id: BlockId): boolean => {
		const cands = candidatesFor(id);
		const now = edges.get(id);
		const at = rejected.has(id) || !now ? cands.length : cands.findIndex((c) => sameEdge(c, now));
		for (let n = 0; n < (at < 0 ? cands.length : at); n++)
			if (admits(id, cands[n]!).ok) return true;
		return false;
	};
	/**
	 * Try every block below its strongest edge again (a changed edge may have
	 * broken its cycle, or made another the one to drop): those that rise join
	 * `moved`.
	 */
	const retryFallen = (moved: Set<BlockId>): void => {
		for (let round = 0; round < fallen.size + rejected.size + 2; round++) {
			let changed = false;
			const below = [...rejected, ...fallen]
				.map((x) => ({ id: x, stamp: candidatesFor(x)[0]?.stamp ?? NO_SLOT }))
				.sort((a, b) => -byTail(a, b));
			for (const { id } of below) {
				if (!canRise(id)) continue;
				for (const x of settle(id, () => {})) moved.add(x);
				changed = true;
			}
			if (!changed) break;
		}
	};
	/**
	 * Everything rebuilt from the sequences (the first build, roles): every
	 * block placed as an edit places one (`settle`, then `retryFallen`) —
	 * the one acyclic acceptance, whatever the order the blocks come in —
	 * then keyed in one pass over each sequence's places (dense keys in its
	 * order), the root's tail after the last top-level block.
	 */
	const rebuildPlacements = (): void => {
		placementFull = false;
		placementSeeds.clear();
		stateSeeds.clear();
		ownerChanged.clear();
		const declared = roles?.declared();
		itemKinds = new Set(declared?.items);
		for (const b of blocks.keys()) {
			const item = itemKind(b);
			if (item !== undefined) itemKinds.add(item);
		}
		lineKinds = new Set(declared?.lines);
		rowKinds = new Map(declared?.rows);
		for (const b of blocks.keys()) {
			const type = blocks.get(b)?.type;
			const rows = type === undefined ? undefined : rowOfTable(type);
			if (rows !== undefined && rowKind(b) !== undefined) rowKinds.set(rows[0], rows[1]);
		}
		cellKinds = new Set(rowKinds.values());
		kindsOf.clear();
		[layoutBlocks, itemBlocks, tableBlocks] = [0, 0, 0];
		lineCounts.clear();
		for (const b of blocks.keys()) noteKind(b);
		for (const line of lineCounts.keys()) lineKinds.add(line);
		placementFull = false;
		// The first read's slots while no sequence changed since (one scan).
		const {
			slots: found,
			items,
			places
		} = collected !== null && collectedAt === seqEpoch
			? collected
			: collectSlots(doc, blocks.values());
		collected = null;
		slotsByBlock.clear();
		for (const [b, refs] of found) slotsByBlock.set(b, refs);
		slotsRead = true;
		placementsMap.clear();
		edges.clear();
		rawOrder.clear();
		fallen.clear();
		rejected.clear();
		[keyed, known] = [false, items];
		for (const id of blocks.keys()) settle(id, () => {});
		if (fallen.size + rejected.size > 0) retryFallen(new Set());
		[keyed, known] = [true, null];
		// The lists in key order: a block where its edge shows it, in its sequence's order.
		for (const [owner, list] of places)
			for (const e of list) {
				const b = slotOwner(registry, kept, (e.value as BlockSlot).b, e.unit.c);
				const pl = placementsMap.get(b);
				const h = blocks.get(b)?.home;
				if (pl?.parent !== owner || rejected.has(b) || !h || !sameUnit(h, e.unit)) continue;
				if (edges.get(b)?.via !== e.via) continue;
				const l = rawList(owner);
				pl.rank = denseKey(l.length);
				l.push({ id: b, rank: pl.rank });
			}
		// The root's tail, keyed as an edit keys a rejected block, in its order.
		const tail = [...rejected].map((x) => ({ id: x, stamp: edges.get(x)?.stamp ?? NO_SLOT }));
		rejected.clear();
		for (const { id } of tail.sort(byTail)) reject(id, edges.get(id) ?? null);
		layoutMode = layoutBlocks + itemBlocks + tableBlocks > 0;
		dissolved = new Set();
		const index = (map: Map<BlockId | null, ChildSlot[]>) => {
			const at = new Map<BlockId, Slot>();
			for (const [parent, list] of map)
				for (const { id, rank, reset } of list)
					at.set(id, reset === undefined ? { parent, rank } : { parent, rank, reset });
			return at;
		};
		kids0 = childrenIndex(placementsMap, own0);
		slots0 = index(kids0);
		if (layoutMode) {
			dissolved = dissolve(kids0);
			kidsMap = childrenIndex(placementsMap, ownShim);
			slots = index(kidsMap);
		} else [kidsMap, slots] = [kids0, slots0];
		following.clear();
		for (const id of slots.keys()) noteFollowing(id);
		orderCache = null;
		kidsVersion++;
		allListsDirty = true;
	};
	const ensurePlacements = (): void => {
		ensureOwners();
		if (placementFull) return rebuildPlacements();
		if (placementSeeds.size + stateSeeds.size + ownerChanged.size === 0) return;
		const moved = new Set<BlockId>();
		const seeds = new Set(placementSeeds);
		const done = new Set<BlockId>();
		/** Place one seed (its left neighbour first, when it is a seed too). */
		const place = (id: BlockId): void => {
			if (done.has(id) || !seeds.has(id)) return;
			done.add(id);
			if (!blocks.has(id)) {
				if (placementsMap.has(id)) {
					setPlacement(id, undefined);
					edges.delete(id);
					fallen.delete(id);
					rejected.delete(id);
					moved.add(id);
				}
				return;
			}
			const top = candidatesFor(id)[0] ?? null;
			const old = edges.get(id);
			// The same edge, placed at its strongest: its key still orders it (its neighbours' keys are theirs).
			if (
				top !== null &&
				old &&
				!rejected.has(id) &&
				!fallen.has(id) &&
				placementsMap.has(id) &&
				sameEdge(top, old)
			)
				return;
			for (const x of settle(id, place)) moved.add(x);
		};
		for (const id of [...seeds]) place(id);
		// A changed claim owner can close a cycle through a display edge that did not change.
		for (const o of ownerChanged)
			for (const c of [...(rawOrder.get(o) ?? [])]) {
				const edge = edges.get(c.id);
				if (!edge || rejected.has(c.id) || edge.parent === undefined) continue;
				if (cycleThrough(placementsMap, ownerOf, c.id, edge.parent) !== null)
					for (const x of settle(c.id, () => {})) moved.add(x);
			}
		if (rejected.size + fallen.size > 0 && (moved.size > 0 || ownerChanged.size > 0))
			retryFallen(moved);
		const seeds2 = new Set<BlockId>([...moved, ...stateSeeds, ...ownerChanged]);
		const kinds = [...stateSeeds];
		placementSeeds.clear();
		stateSeeds.clear();
		ownerChanged.clear();
		const affected = reach(seeds2);
		let touched: Iterable<BlockId> = affected;
		const changed = patch(kids0, slots0, own0, affected);
		let any = changed.size > 0;
		if (layoutMode) {
			const flips = redissolve(changed, kinds);
			const again = flips.size > 0 ? reach([...affected, ...flips]) : affected;
			any = patch(kidsMap, slots, ownShim, again).size > 0 || any;
			touched = again;
		}
		for (const id of touched) noteFollowing(id);
		if (any) {
			orderCache = null;
			kidsVersion++;
		}
	};

	/**
	 * A plain block (the document's default kind) directly in a container
	 * whose item is a kind of its own that renders content (a list) shows
	 * as that item — the read-time side of the facade's `fitted`: a race
	 * (a peer's lift of an item another peer's outdent moves, a concurrent
	 * undo of a retype) or an explicit write never shows a bare paragraph
	 * in a list. Anywhere else it shows `plain`.
	 */
	const shownItem = (under: BlockId, plain: string): string => {
		const parent = typeOf(under);
		const { container, child } = roles!.of(parent);
		return container && roles!.of(child).rendersContent ? child : plain;
	};

	/**
	 * The kind `id` displays as — THE shown-kind rule, read from its slot
	 * and the role table. A block directly in an island declared `lines`
	 * shows its line kind. A block of a line kind anywhere else shows its
	 * display parent's default child — an undo can put a line a peer
	 * retyped back in its island, or leave one a peer moved away outside
	 * it — and so does a block displayed out of an island
	 * or a container (a list) that still has its default child
	 * kind, unless an outer container shows it as one of its
	 * items (a nested list's item). A block that renders
	 * content never shows as a kind that does not: a line kind
	 * then shows the document's default kind. A block stored as the
	 * document's default kind directly in a list shows as its item
	 * (`shownItem`). Any other shows its stored kind (a retype shows). Read from the stored kinds
	 * at call time: a retype rebuilds no placement.
	 */
	const typeOf = (id: BlockId): string => {
		const stored = blocks.get(id)?.type ?? 'unknown';
		const slot = slots.get(id);
		if (roles === null || slot === undefined) return stored;
		const { parent: under, reset } = slot;
		const line = under === null || lineKinds.size === 0 ? undefined : lineKind(under);
		if (line !== undefined) return line;
		const lined = lineKinds.has(stored);
		const from = reset === undefined ? undefined : (blocks.get(reset)?.type ?? null);
		const plain = roles.of(null).child;
		if (!lined && (from === undefined || stored !== roles.of(from).child))
			return stored === plain && under !== null ? shownItem(under, stored) : stored;
		// Out of a removed list, inside an outer list of its kind: still an item. A
		// container whose item is the document's default kind (a column) holds no
		// items of its own: a paragraph under one is no list's item.
		if (!lined && typeof from === 'string' && roles.of(from).container)
			for (let u = under; u !== null; u = slots.get(u)?.parent ?? null) {
				const t = roles.of(typeOf(u));
				if (t.container && t.child === stored && stored !== plain) return stored;
			}
		const kind = roles.of(under === null ? null : typeOf(under)).child;
		if (roles.of(kind).rendersContent || !roles.of(stored).rendersContent) return kind;
		// Never a line kind outside its island, even where the slot's kind shows nothing.
		return lined ? plain : stored;
	};

	/** The document order, cached until a child list changes. */
	const order = (): DocOrder => (orderCache ??= documentOrder(kidsMap));

	// ══ Block records ═══════════════════════════════════════════════
	// Block records: each registry entry's record (and the losing
	// incarnations a key shows), rebuilt on a structural change, noting what
	// the maintained facts must re-decide.
	// ── records ──────────────────────────────────────────────────────

	/** The node of `id`: its registry value, or the losing incarnation a derived id names. */
	const nodeAt = (id: BlockId): unknown => {
		const v = registry.getAttr(id);
		if (isNodeLike(v) || !isIncarnationId(id)) return v;
		return incarnationNode(registry, id, kept) ?? undefined;
	};

	const buildRec = (id: BlockId, node: EngineNode): BlockRec => {
		const content = node.getAttr(CONTENT);
		const derived = isIncarnationId(id);
		// A losing incarnation lives and dies with its key's block: hidden by its
		// own delete mark or while that block is deleted (a withdrawn one included).
		const keyDeleted = derived ? (blocks.get(baseIdOf(id))?.deleted ?? true) : false;
		// The implicit claims stamp below every written one: an explicit claim
		// (a split moving them to its tail block) outranks them.
		const implicit: Claim[] = derived
			? []
			: incarnationsOf(registry, id, kept).map((x, i) => ({
					m: x.id,
					stamp: { c: -1, k: -1 - i }
				}));
		return {
			id,
			node,
			type: typeAttr(node),
			data: readData(node),
			n: node.getAttr(NONCE),
			deleted: hasDeleteMark(node) || keyDeleted,
			content: isNodeLike(content) ? content : undefined,
			implicit,
			// Read from its stream once the record is in (`claimsOf`), again after the fold's texts.
			claims: [],
			home: homeFor(id)
		};
	};

	/**
	 * Rebuild (or create, or drop) block `id`'s record, and note what the
	 * maintained facts must re-decide: its owner and the tops of the
	 * blocks it claims, its placement — and, when its entry came or
	 * went, the placements of the blocks whose display edge it holds.
	 */
	const updateBlockRec = (id: BlockId): void => {
		const old = blocks.get(id);
		const node = nodeAt(id);
		if (!isNodeLike(node)) blocks.delete(id);
		else {
			const rec = buildRec(id, node);
			blocks.set(id, rec);
			rec.claims = claimsOf(id);
			reclaim.add(id);
		}
		const rec = blocks.get(id);
		// Another node now stands for `id` (or none): its sequence's slots change owner.
		if (old?.node !== rec?.node) {
			if (old !== undefined) reslot(old.node);
			if (rec !== undefined) reslot(rec.node);
		}
		noteShell(id);
		noteClaims(id, old?.claims ?? [], rec?.claims ?? []);
		placementSeeds.add(id);
		if ((old === undefined) !== (rec === undefined)) {
			stateSeeds.add(id);
			for (const c of rawOrder.get(id) ?? []) placementSeeds.add(c.id);
		}
		if (old?.type !== rec?.type) {
			noteKind(id);
			if (
				old === undefined ||
				rec === undefined ||
				roles === null ||
				!sameShape(roles, old.type, rec.type)
			)
				stateSeeds.add(id);
		}
	};
	/** A withdrawn block without a delete mark: its `deleted` is settled after each fold. */
	const noteShell = (id: BlockId): void => {
		const rec = blocks.get(id);
		const was = shells.has(id);
		// A losing incarnation is never withdrawn on its own: its key's block decides.
		if (isIncarnationId(id)) shells.delete(id);
		else if (rec !== undefined && !rec.deleted && hasWithdrawMark(rec.node)) shells.add(id);
		else shells.delete(id);
		// A withdrawn cell shows in a column its table no longer lists (`table.cell`): re-place it.
		if (was !== shells.has(id) && rec !== undefined && cellKinds.has(rec.type)) stateSeeds.add(id);
	};
	const ensureRec = (id: BlockId): void => {
		if (!blocks.has(id)) updateBlockRec(id);
	};
	/**
	 * Re-read the losing incarnations of key `id` after its record
	 * changed: each one shown now or before gets its record rebuilt (its
	 * liveness is the key's); returns them, for the fold to rescan.
	 */
	const syncIncarnations = (id: BlockId): string[] => {
		if (isIncarnationId(id)) return [];
		const before = incarnations.get(id) ?? [];
		const now = incarnationsOf(registry, id, kept).map((x) => x.id);
		if (now.length === 0) incarnations.delete(id);
		else incarnations.set(id, now);
		const all = [...new Set([...before, ...now])];
		for (const v of all) updateBlockRec(v);
		return all;
	};

	// ══ The run cache ═══════════════════════════════════════════════
	// The run cache: each block's visible runs as a frozen snapshot, recomputed
	// when a fold invalidates it, sharing unchanged runs and interned payloads.
	const rangeStats: RangeReadStats = { items: 0, markers: 0 };

	// ── run cache ────────────────────────────────────────────────────
	const internMap = new Map<string, unknown>();
	const debug: RunViewDebug = {
		recomputes: 0,
		recomputed: new Set<BlockId>(),
		get itemsWalked() {
			return rangeStats.items;
		},
		get markersWalked() {
			return rangeStats.markers;
		},
		get frames() {
			return frames.size;
		},
		get folds() {
			return foldStats.folds;
		},
		get foldedPairs() {
			return foldStats.pairs;
		},
		get foldedStructs() {
			return foldStats.structs;
		},
		get placements() {
			return foldStats.placed;
		},
		reset() {
			debug.recomputes = 0;
			debug.recomputed.clear();
			foldStats.folds = 0;
			foldStats.pairs = 0;
			foldStats.structs = 0;
			foldStats.placed = 0;
			rangeStats.items = 0;
			rangeStats.markers = 0;
		}
	};

	// ── interning / freezing ─────────────────────────────────────────
	// `cloneJsonSafe` is total even against hostile replicated payloads,
	// and interning the normalized form keys it by its own canonical shape.
	// The shared instance is built FROM that key (sorted keys): it must not
	// remember the key order its first reader happened to fold, or
	// `toJSON` would depend on when the view was read.
	const intern = <T>(v: T): T => {
		const key = canonKey(cloneJsonSafe(v));
		let f = internMap.get(key) as T | undefined;
		if (f === undefined) internMap.set(key, (f = deepFreeze(JSON.parse(key)) as T));
		return f;
	};

	// ── dep bookkeeping ──────────────────────────────────────────────

	const drop = (index: Map<BlockId, Set<BlockId>>, keys: Set<BlockId>, b: BlockId) => {
		for (const k of keys) {
			const set = index.get(k);
			set?.delete(b);
			if (set?.size === 0) index.delete(k);
		}
	};
	const add = (index: Map<BlockId, Set<BlockId>>, keys: Set<BlockId>, b: BlockId) => {
		for (const k of keys) {
			const set = getOr(index, k, () => new Set());
			set.add(b);
		}
	};
	const applyDeps = (b: BlockId, deps: Deps): void => {
		const old = cache.get(b)?.deps;
		if (old) {
			drop(textConsumers, old.texts, b);
			drop(listConsumers, old.lists, b);
		}
		add(textConsumers, deps.texts, b);
		add(listConsumers, deps.lists, b);
	};

	// ── snapshot construction ────────────────────────────────────────

	const freezeFresh = (r: ContentRun): ContentRun => Object.freeze(r) as ContentRun;

	/** The normalized fresh runs of `b` (interned payloads, equal marks merged) and their deps. */
	const computeFresh = (b: BlockId): { fresh: ContentRun[]; deps: Deps } => {
		const deps: Deps = { texts: new Set(), lists: new Set([b]) };
		const segs =
			displayOf(b, blocks, ownShim, (x, home) => {
				deps.lists.add(x);
				if (home !== undefined) deps.texts.add(home);
				// Every claim on a walked list is read, followed or not: a claim
				// skipped for a dead target or a higher claimer becomes effective
				// when that target revives or its winning claim goes away.
				for (const c of blocks.get(x)?.claims ?? []) deps.lists.add(c.m);
			}) ?? [];
		const fresh: ContentRun[] = [];
		for (const item of readSegs(segs, rangeStats)) {
			if (item.kind === 'text') {
				const last = fresh[fresh.length - 1];
				const marks = item.marks === undefined ? undefined : intern(item.marks);
				if (last && last.kind === 'text' && last.marks === marks) {
					(last as { text: string }).text += item.text;
				} else {
					fresh.push({
						kind: 'text',
						text: item.text,
						...(marks === undefined ? {} : { marks })
					} as ContentRun);
				}
			} else {
				fresh.push({
					kind: 'inline',
					id: item.id,
					type: item.type,
					...(item.data === undefined ? {} : { data: intern(item.data) })
				} as ContentRun);
			}
		}
		return { fresh, deps };
	};

	/**
	 * Structural sharing: reuse unchanged run objects from `old` — maximal
	 * equal prefix + equal suffix; `old` itself when every run is identical.
	 */
	const reconcile = (
		old: readonly ContentRun[] | undefined,
		fresh: ContentRun[]
	): readonly ContentRun[] => {
		if (!old) return Object.freeze(fresh.map(freezeFresh));
		let s = 0;
		const n = Math.min(old.length, fresh.length);
		while (s < n && runEquals(old[s], fresh[s])) s++;
		if (s === old.length && s === fresh.length) return old;
		let eo = old.length - 1;
		let ef = fresh.length - 1;
		while (eo >= s && ef >= s && runEquals(old[eo], fresh[ef])) {
			eo--;
			ef--;
		}
		const out: ContentRun[] = new Array(fresh.length);
		for (let i = 0; i < s; i++) out[i] = old[i];
		for (let i = s; i <= ef; i++) out[i] = freezeFresh(fresh[i]);
		for (let i = eo + 1; i < old.length; i++) out[fresh.length - (old.length - i)] = old[i];
		return Object.freeze(out);
	};

	// ── recompute ────────────────────────────────────────────────────

	const computeRuns = (b: BlockId): void => {
		const old = cache.get(b);
		const { fresh, deps } = computeFresh(b);
		const runs = reconcile(old?.runs, fresh);
		applyDeps(b, deps);
		cache.set(b, { runs, deps });
		dirty.delete(b);
		debug.recomputes++;
		debug.recomputed.add(b);
	};

	// ══ The fold ════════════════════════════════════════════════════
	// THE fold: one pass over a transaction's changed `(type, parentSub)` pairs
	// into the index, once at commit and, for read-your-writes, over the
	// pending part of every transaction whose commit fold has not run.

	const NO_EDITS: TextEdits = Object.freeze({
		edits: [],
		scan: false,
		opaque: false
	}) as TextEdits;
	const holdsBoundary = (s: StoreStruct, from: number, to: number): boolean => {
		const arr = s.content?.arr;
		if (arr === undefined) return false;
		for (let k = from - s.id.clock; k < to - s.id.clock; k++) if (isRowMark(arr[k])) return true;
		return false;
	};
	/** What a fold changed in one sequence (fork patch YP22): the blocks whose slot, record or mover it touched, and its data slots. */
	type SeqChange = { blocks: Set<BlockId>; data: boolean };
	/** How much of a transaction's log a read folded: its length, and its last entry's `len` then (the engine extends a run's entry). */
	type Cursor = readonly [from: number, seen?: number];
	/**
	 * What a transaction's log past a read's cursor did (fork patch YP33:
	 * per run of items `kind, client, clock, len`, in order), in one pass: per text
	 * (`texts`), its edits (the units each item showed or hid, in order); per
	 * sequence (`seqs`), what changed in it: the slots written and removed, the
	 * records written and removed and the units whose mover changed name
	 * the blocks to re-place; with `pairs` (a read's fold), the `(type, key)`
	 * pairs it changed, and the structs it named (`structs`). Reading the sequences writes the
	 * slot map (the slots written and removed, `putSlot`) and lists the ids
	 * whose home to read again (`rehome`).
	 */
	const makeEditIndex = (
		log: readonly number[],
		[from, seen]: Cursor,
		pairs?: Map<EngineNode, Set<string | null>>
	) => {
		const texts = new Map<EngineNode, TextEdits>();
		const seqs = new Map<EngineNode, SeqChange>();
		const rehome = new Set<BlockId>();
		let structs = 0;
		const seqOf = (node: EngineNode): SeqChange =>
			getOr(seqs, node, () => ({ blocks: new Set(), data: false }));
		const note = (s: StoreStruct): void => {
			if (pairs && isNodeLike(s.parent)) getOr(pairs, s.parent, () => new Set()).add(s.parentSub);
		};
		/** Note unit `c:k` (`value`) of a sequence: a block slot names its block, a data slot its data. */
		const noteUnit = (
			e: SeqChange,
			owner: BlockId | null | undefined,
			value: unknown,
			c: number,
			k: number,
			inserted: boolean | null
		): void => {
			if (isBlockSlot(value)) {
				e.blocks.add(slotOwner(registry, kept, value.b, c));
				if (inserted === null || (inserted && owner === undefined)) return;
				putSlot(value.b, { c, k }, inserted ? { parent: owner as BlockId | null, c, k } : null);
				rehome.add(value.b);
			} else if (isDataSlot(value)) e.data = true;
		};
		/** Walk `n` units of entry `i` from clock `k` (`n`'s sign is the entry's). */
		const run = (i: number, k: number, n: number): void => {
			const kind = log[i]!;
			walkRange(Y, doc, log[i + 1]!, k, Math.abs(n), (s, a, b) => {
				structs++;
				note(s);
				// A unit a record moved: where it shows now changed too.
				const mover = (s as SeqItem).mover;
				if (mover) {
					note(mover);
					seqOf(mover.parent as EngineNode);
				}
				const parent = s.parent as EngineNode;
				const it = s as SeqItem;
				if (s.parentSub !== null || !isNodeLike(parent) || it.content === undefined) return;
				if (parent.name === CONTENT_NODE) {
					if (kind > 1) return;
					const e = getOr(texts, parent, () => ({ edits: [], scan: false, opaque: false }));
					// A format marker moves no unit; its effect reaches past the edit.
					if (s.countable !== true) e.opaque = true;
					else if (holdsBoundary(s, a, b)) e.scan = true;
					else e.edits.push({ item: s as RowItem, n: n < 0 ? a - b : b - a });
					return;
				}
				const e = seqOf(parent);
				const owner = ownerOfNode(registry, kept, parent);
				const inserted = kind > 1 ? null : n > 0;
				if (isRecord(it)) {
					const ids = it.content.ids!;
					for (let i = 0; i < ids.length; i += 3)
						for (let j = 0; j < ids[i + 2]!; j++) {
							const u = unitOf(doc, { c: ids[i]!, k: ids[i + 1]! + j });
							if (u !== null) noteUnit(e, owner, u.value, ids[i]!, ids[i + 1]! + j, null);
						}
				} else if (it.content.arr !== undefined)
					for (let k = a; k < b; k++)
						noteUnit(e, owner, it.content.arr[k - s.id.clock], s.id.client, k, inserted);
			});
		};
		// The units the engine added to the entry a read folded last (`seen`: its length then), then the rest.
		if (from > 0 && log[from - 1] !== seen)
			run(from - 4, log[from - 2]! + Math.abs(seen!), log[from - 1]! - seen!);
		for (let i = from; i < log.length; i += 4) run(i, log[i + 2]!, log[i + 3]!);
		return { texts, seqs, structs, rehome };
	};
	type EditLookup = ReturnType<typeof makeEditIndex>;

	const runs = (b: BlockId): readonly ContentRun[] => {
		// Read-your-writes: fold the open transaction's pending writes first.
		syncAll();
		if (dirty.has(b) || !cache.has(b)) computeRuns(b);
		return cache.get(b)?.runs ?? EMPTY_RUNS;
	};

	// ── the fold ─────────────────────────────────────────────────────

	/** The owner of the sequence `id`'s slot shows in (its display edge's parent), as the engine stands. */
	const parentOf = (id: BlockId): BlockId | null | undefined => edgeParent(id);
	/** Note edits of `id`'s own text (`null`: unknown — rescan, every reader re-reads). */
	const noteText = (ctx: FoldCtx, id: BlockId, e: TextEdits | null): void => {
		let t = ctx.texts.get(id);
		if (t === undefined)
			ctx.texts.set(id, (t = { edits: [], scan: false, opaque: false, seen: new Set() }));
		if (e === null) {
			t.scan = t.opaque = true;
			return;
		}
		if (t.seen.has(e)) return;
		t.seen.add(e);
		t.scan ||= e.scan;
		t.opaque ||= e.opaque;
		for (const x of e.edits) t.edits.push(x);
	};

	/** Fold one block's changed facets (`edits`: its own text's, one per changed content node). */
	const foldBlock = (
		id: BlockId,
		facets: ReadonlySet<string>,
		edits: readonly (TextEdits | null)[],
		ctx: FoldCtx,
		editsOf: EditLookup
	): void => {
		const kinds = new Set<Facet | 'entry'>();
		for (const f of facets) kinds.add(f === ENTRY_FACET ? 'entry' : facetOf(f));
		// The display parents a shell may flip by (`settleShells`): read while there are shells.
		const parentBefore = shells.size > 0 ? parentOf(id) : undefined;
		if (typeof parentBefore === 'string') ctx.parents.add(parentBefore);
		if (kinds.has('entry') || kinds.has('structure')) {
			const [claimsBefore, typeBefore] = [blocks.get(id)?.claims, blocks.get(id)?.type];
			updateBlockRec(id);
			// A retype that lands with a structure facet is still a retype.
			if (typeBefore !== undefined && blocks.get(id)?.type !== typeBefore) retyped = true;
			// A new entry, a nonce or an own text can move streams.
			if (kinds.has('entry') || facets.has(NONCE) || facets.has(CONTENT_ATTR)) {
				ctx.table = true;
				ctx.named.add(id);
				noteText(ctx, id, null);
			}
			// The key's losing incarnations follow its entry and its liveness.
			for (const v of syncIncarnations(id)) {
				ctx.table = true;
				ctx.named.add(v);
				noteText(ctx, v, null);
				invalidateBlock(v, ctx);
			}
			invalidateBlock(id, ctx, claimsBefore);
		} else {
			ensureRec(id);
			const rec = blocks.get(id);
			// A data slot in the block's sequence: its arrays' items changed (the seq pass seeded the blocks).
			if (kinds.has('seq') && rec && editsOf.seqs.get(rec.node)?.data) kinds.add('meta');
			if (kinds.has('meta') && rec) {
				const was = rec.type;
				const facts = tableFacts(id, rec.data);
				rec.type = typeAttr(rec.node);
				rec.data = readData(rec.node);
				if (rec.type !== was) {
					retyped = true;
					noteKind(id);
				}
				// A table's columns or a cell's column re-place the table's cells (`table.columns`).
				if (tableFacts(id, rec.data) !== facts) stateSeeds.add(id);
				// A retype that changes the kind's display shape re-parents
				// (or re-kinds) its children.
				if (roles !== null && !sameShape(roles, was, rec.type)) stateSeeds.add(id);
			}
		}
		const parentAfter = shells.size > 0 ? parentOf(id) : undefined;
		if (typeof parentAfter === 'string') ctx.parents.add(parentAfter);
		if (kinds.has('content')) for (const e of edits) noteText(ctx, id, e);
	};

	/**
	 * Move each edited text's row by its edits (or rescan it), re-decide the
	 * delimiters a boundary change names, re-place the rows they cut, and
	 * invalidate the readers: the display owner of each edited stream,
	 * the blocks whose stream changed, every reader of an opaque text.
	 */
	const foldTexts = (ctx: FoldCtx): void => {
		const homes = new Set<BlockId>();
		const gapsOf = new Map<BlockId, number[] | null>();
		const gapsIn = (row: LiveRow, edits: readonly TextEdit[]): number[] | null => {
			const gaps: number[] = [];
			for (const e of edits) {
				const gap = gapOfItem(row, e.item);
				if (gap < 0) return null;
				gaps.push(gap);
			}
			return gaps;
		};
		for (const [home, t] of ctx.texts) {
			const text = blocks.get(home)?.content;
			const row = rows.get(home);
			let gaps: number[] | null = [];
			let fresh = t.scan || row === undefined || text === undefined || row.text !== text;
			if (!fresh) {
				for (const e of t.edits) {
					const gap = gapOfItem(row!, e.item);
					if (gap < 0 || !shiftGap(row!, gap, e.n)) {
						fresh = true;
						break;
					}
					gaps.push(gap);
				}
				// The engine's own count of live units: a row that disagrees is stale.
				if (!fresh && rowLength(row!) !== sequenceLength(text!)) fresh = true;
			}
			if (fresh) {
				const next = scanRow(home);
				const same = next !== undefined && row !== undefined && next.key === row.key;
				if (same) [next.cuts, next.heads, next.head] = [row.cuts, row.heads, row.head];
				setRow(home, next, ctx.named);
				if (!same) homes.add(home);
				gaps = next === undefined ? [] : gapsIn(next, t.edits);
			}
			gapsOf.set(home, t.opaque ? null : gaps);
		}
		refreshDelims(ctx.named, homes);
		if (homes.size > 0) ctx.table = true;
		for (const home of homes) placeHome(home, ctx.invalidated);
		for (const [home, gaps] of gapsOf) {
			if (gaps === null) {
				for (const c of textConsumers.get(home) ?? []) ctx.invalidated.add(c);
				continue;
			}
			// Only the stream each edit lies in changes its display.
			const row = rows.get(home);
			if (row === undefined) continue;
			for (const gap of gaps) {
				const b = headOf(row, segmentOfGap(row, gap));
				const owner = b === null ? DEAD : ownerOf(b);
				if (typeof owner === 'string') ctx.invalidated.add(owner);
			}
		}
	};

	/** The blocks whose stream lies in a text the fold edited. */
	const editedStreams = (ctx: FoldCtx): BlockId[] =>
		[...ctx.texts.keys()].flatMap((home) => streamsIn(home).map((st) => st.block));
	/** A live unit in `id`'s stream (boundaries excepted). */
	const streamHolds = (id: BlockId): boolean => {
		const st = streamOf(id);
		return st !== undefined && st.end - st.start > st.inert.length;
	};
	/** A live unit in `id`'s stream or in the stream of a losing incarnation it shows. */
	const holdsUnit = (id: BlockId): boolean =>
		streamHolds(id) || (incarnations.get(id)?.some(streamHolds) ?? false);

	/**
	 * Settle the withdrawn blocks (`hist.undo.withdraw`): a shell is deleted
	 * iff it holds nothing — no live unit in its stream and no child (a
	 * block whose winning candidate names it) that is itself not deleted.
	 * The least fixpoint, computed over every shell whenever an `affected`
	 * one may flip (one whose stream still holds a unit keeps its answer),
	 * so every replica settles the same whatever the fold order. A flip is
	 * a structural change of the shell.
	 */
	const settleShells = (affected: Iterable<BlockId>, ctx: FoldCtx | null): void => {
		if (shells.size === 0) return;
		let quiet = true;
		for (const x of affected) {
			const id = baseIdOf(x);
			if (!shells.has(id)) continue;
			if (blocks.get(id)?.deleted !== false || !holdsUnit(id)) quiet = false;
		}
		if (quiet) return;
		const alive = new Set<BlockId>();
		const up: BlockId[] = [];
		const hold = (id: BlockId): void => {
			if (alive.has(id)) return;
			alive.add(id);
			up.push(id);
		};
		for (const id of shells) if (holdsUnit(id)) hold(id);
		for (const [id, rec] of blocks) {
			if (shells.has(id) || rec.deleted) continue;
			const p = parentOf(id);
			if (typeof p === 'string' && shells.has(p)) hold(p);
		}
		for (let id = up.pop(); id !== undefined; id = up.pop()) {
			const p = parentOf(id);
			if (typeof p === 'string' && shells.has(p)) hold(p);
		}
		for (const id of shells) {
			const rec = blocks.get(id)!;
			if (rec.deleted === !alive.has(id)) continue;
			rec.deleted = !alive.has(id);
			ownerSeeds.add(id);
			// Its losing incarnations follow it.
			for (const v of incarnations.get(id) ?? []) {
				const inc = blocks.get(v);
				if (inc === undefined) continue;
				const deleted = hasDeleteMark(inc.node) || rec.deleted;
				if (inc.deleted === deleted) continue;
				inc.deleted = deleted;
				ownerSeeds.add(v);
				if (ctx !== null) invalidateBlock(v, ctx);
			}
			if (ctx === null) continue;
			invalidateBlock(id, ctx);
		}
	};

	const registryNode: EngineNode = registry;

	/**
	 * The block a changed `(type, parentSub)` pair belongs to, the facet it
	 * entered through (the block attr the chain hangs under; the `content`
	 * attr itself is {@link CONTENT_ATTR}), and whether it is a sequence
	 * edit of the block's own text. `null` outside the registry subtree.
	 */
	const locate = (type: EngineNode, sub: string | null): [BlockId, string, boolean] | null => {
		if (type === registryNode) return typeof sub === 'string' ? [sub, ENTRY_FACET, false] : null;
		let below: EngineNode | null = null;
		for (let cur = type; ; ) {
			const it = cur._item;
			const parent = it?.parent as EngineNode | undefined;
			if (parent === registryNode) {
				let id = it!.parentSub;
				if (typeof id !== 'string') return null;
				// A losing incarnation's subtree: its derived id; a seed's shows nothing.
				if (it!.deleted && kept(it)) {
					const item = itemOf(cur)!;
					if (item.id.client < LIVE_WRITERS) return null;
					id = incarnationId(id, item);
				}
				// The block's own sequence (its slots and records: `SEQ_FACET`), or one of its attrs.
				if (below === null)
					return [id, sub === CONTENT ? CONTENT_ATTR : sub === null ? SEQ_FACET : sub, false];
				const facet = below._item?.parentSub ?? CONTENT;
				return [id, facet, sub === null && below === type && facet === CONTENT];
			}
			if (!isNodeLike(parent)) return null;
			below = cur;
			cur = parent;
		}
	};

	/** THE fold: one pass over changed `(type, parentSub)` pairs, each block folded once. */
	const fold = (
		changed: Map<unknown, Set<string | null>>,
		editsOf: EditLookup
	): Map<BlockId, Set<string>> => {
		const touched = new Map<BlockId, Set<string>>();
		const edits = new Map<BlockId, (TextEdits | null)[]>();
		let derived = changed.has(dataRoot);
		foldStats.folds++;
		for (const [type, subs] of changed) {
			foldStats.pairs += subs.size;
			for (const sub of subs) {
				const hit = locate(type as EngineNode, sub);
				if (hit === null) continue;
				const [id, facet, seq] = hit;
				const facets = getOr(touched, id, () => new Set());
				facets.add(facet);
				if (facet !== CONTENT) continue;
				// A sequence edit of the block's own text, or a change inside one of its atoms.
				const list = getOr(edits, id, () => []);
				list.push(seq ? (editsOf.texts.get(type as EngineNode) ?? NO_EDITS) : null);
			}
		}
		const ctx: FoldCtx = {
			invalidated: new Set(),
			texts: new Map(),
			named: new Set(),
			table: false,
			parents: new Set()
		};
		// The sequences (the root's, the blocks'): their slots index the blocks' homes, their changes seed the placements.
		for (const [node, ch] of editsOf.seqs) {
			seqEpoch++;
			for (const b of ch.blocks) placementSeeds.add(b);
			if (ch.blocks.size > 0 || ch.data) derived = true;
			const owner = ownerOfNode(registry, kept, node);
			if (typeof owner === 'string') {
				const facets = getOr(touched, owner, () => new Set());
				facets.add(SEQ_FACET);
				if (ch.data) facets.add(DATA_SEQ_FACET);
			}
		}
		// A slot's block, and its losing incarnations, re-read their home (which slot is whose).
		for (const b of editsOf.rehome)
			for (const id of [b, ...(incarnations.get(b) ?? [])]) {
				const rec = blocks.get(id);
				if (rec === undefined) continue;
				const home = homeFor(id);
				if (home?.c !== rec.home?.c || home?.k !== rec.home?.k) placementSeeds.add(id);
				rec.home = home;
			}
		for (const [id, facets] of touched) {
			foldBlock(id, facets, edits.get(id) ?? [], ctx, editsOf);
			derived ||= [...facets].some((f) => f === ENTRY_FACET || facetOf(f) !== 'ignore');
		}
		foldTexts(ctx);
		if (reclaim.size > 0) applyReclaims(ctx);
		if (shells.size > 0)
			settleShells(
				ctx.table ? shells : [...touched.keys(), ...ctx.parents, ...editedStreams(ctx)],
				ctx
			);
		for (const b of ctx.invalidated) dirty.add(b);
		if (indexChecks.on) checker().check();
		if (derived) version++;
		if (reporting) {
			for (const id of touched.keys()) candidates.add(id);
			for (const id of ctx.invalidated) candidates.add(id);
		}
		for (const f of frames) {
			for (const [id, facets] of touched) {
				const into = f.touched.get(id);
				if (into === undefined) f.touched.set(id, new Set(facets));
				else for (const x of facets) into.add(x);
			}
		}
		return touched;
	};

	/** Each transaction's folded part (`Cursor`). */
	const cursors = new WeakMap<Tx, Cursor>();
	const NONE: Cursor = [0];
	/** Whether `log` holds entries or units past `cursor`. */
	const past = (log: readonly number[], [from, seen]: Cursor): boolean =>
		log.length !== from || log[from - 1] !== seen;
	/** The transactions whose commit fold ran. */
	const committed = new WeakSet<Tx>();

	/**
	 * Fold the pending part of `tr` — the entries its log gained since the
	 * last fold — before a read inside it (read-your-writes;
	 * `transaction.changed` does not grow on a second edit to an
	 * already-changed type).
	 */
	const syncPending = (tr: Tx | null | undefined): boolean => {
		const log = tr?.log;
		const cursor = cursors.get(tr!) ?? NONE;
		if (log === undefined || !past(log, cursor)) return false;
		cursors.set(tr!, [log.length, log[log.length - 1]]);
		for (const f of frames) f.wrote = true;
		const pairs = new Map<EngineNode, Set<string | null>>();
		const edits = makeEditIndex(log, cursor, pairs);
		foldStats.structs += edits.structs;
		fold(pairs, edits);
		return true;
	};
	const openTx = (): Tx | null | undefined => doc._transaction as Tx | null | undefined;
	/**
	 * Fold every transaction whose writes are in the document and whose
	 * commit fold has not run, in their order: the open one, and those a
	 * transaction's cleanup started (an observer's or an `update`
	 * listener's write runs its body at once, its observers later) — a
	 * read in between must not mix their items with an index that never
	 * saw them.
	 */
	const syncAll = (): void => {
		for (const tr of queuedTransactions(doc) as Tx[]) if (!committed.has(tr)) syncPending(tr);
	};
	/** Some queued transaction holds writes no fold has seen. */
	const unfolded = (): boolean =>
		(queuedTransactions(doc) as Tx[]).some(
			(tr) => !committed.has(tr) && tr.log !== undefined && past(tr.log, cursors.get(tr) ?? NONE)
		);

	/**
	 * The commit of a transaction that changed the registry or a node under
	 * it: fold `transaction.changed` once (the report publishes from `update`).
	 */
	const onCommit = (tr: Tx): void => {
		if (!changedUnder(tr as { changed: Map<unknown, unknown> }, [registry])) return;
		// The writes a read folded already moved the rows: only the rest
		// are edits now (the facets fold again, idempotent).
		const cursor = cursors.get(tr) ?? NONE;
		cursors.delete(tr);
		committed.add(tr);
		fold(tr.changed ?? new Map(), makeEditIndex(tr.log ?? [], cursor));
	};

	// ══ The change report ═══════════════════════════════════════════
	// The change report: the fold against the last published index, one per
	// commit that changed the visible document, and the projection it carries.
	const docData = (): Record<string, unknown> => cloneJsonSafe(readData(dataRoot) ?? {});
	let dataChanged = false;

	// ── projection ───────────────────────────────────────────────────

	/** `id`'s visible content items: its runs, as fresh wrappers over their shared payloads. */
	const itemsOf = (id: BlockId): ContentItem[] => runs(id).map((r) => ({ ...r }));

	const projectBlock = (id: BlockId): ProjectedBlock => {
		const rec = blocks.get(id)!;
		const projected: ProjectedBlock = {
			id,
			type: typeOf(id),
			data: dataOf(rec),
			content: itemsOf(id),
			children: []
		};
		for (const k of kidsMap.get(id) ?? []) projected.children.push(projectBlock(k.id));
		return projected;
	};

	// ── the change report: the fold against the last published index ─

	let published: Published | null = null;
	const reportSubs = new Set<(r: IndexReport, origin: unknown, local: boolean) => void>();

	/** The reachable tree — nodes carry `prev`'s published payloads where they exist. */
	const reachable = (prev?: Published['nodes']): Published => {
		ensurePlacements();
		const nodes: Published['nodes'] = new Map();
		const order: Published['order'] = new Map();
		const stack: (BlockId | null)[] = [null];
		for (let parent = stack.pop(); parent !== undefined; parent = stack.pop()) {
			const ks = kidsMap.get(parent) ?? [];
			if (ks.length === 0) continue;
			order.set(parent, Object.freeze(ks.map((k) => k.id)));
			for (let index = ks.length - 1; index >= 0; index--) stack.push(ks[index].id);
			ks.forEach(({ id }, index) => {
				const old = prev?.get(id);
				const rec = blocks.get(id)!;
				nodes.set(
					id,
					old === undefined
						? { parent, index, type: typeOf(id), data: rec.data, runs: runs(id) }
						: { ...old, parent, index }
				);
			});
		}
		return { nodes, order, kids: kidsVersion };
	};

	/**
	 * The report's structural part from the child lists patched since the
	 * last report, advancing the published tree in place — what
	 * `reachable` would give, without walking the lists nothing changed:
	 * a published block no longer shown leaves (a root when its parent
	 * stays), its still-shown descendants staying; each patched list's
	 * new order is news, a block in it at a new parent or index moved, one
	 * not published before is added with its subtree.
	 */
	const advance = (
		pub: Published,
		r: IndexReport,
		covered: Set<BlockId>,
		reparented: Set<BlockId>
	): void => {
		const { nodes, order } = pub;
		const shown = (x: BlockId): boolean => {
			for (let c: BlockId | null = x; c !== null; ) {
				const slot = slots.get(c);
				if (slot === undefined) return false;
				c = slot.parent;
			}
			return true;
		};
		const lists = [...dirtyLists];
		// Leaving: a published block of a patched list that no longer shows.
		const drop = (id: BlockId): void => {
			const ks = order.get(id);
			if (ks !== undefined) {
				order.delete(id);
				r.order.set(id, EMPTY_IDS);
				for (const k of ks) if (!shown(k)) drop(k);
			}
			nodes.delete(id);
		};
		for (const id of leftLists) {
			const o = nodes.get(id);
			if (o === undefined || shown(id)) continue;
			if (o.parent === null || shown(o.parent)) r.removed.add(id);
			drop(id);
		}
		// Each patched list that shows: its order, its moved and new blocks.
		const fresh = new Map<BlockId, { parent: BlockId | null; index: number }>();
		for (const p of lists) {
			if (p !== null && !shown(p)) continue;
			const ks = kidsMap.get(p) ?? [];
			const prev = order.get(p);
			if (ks.length === 0) {
				if (prev !== undefined) {
					order.delete(p);
					r.order.set(p, EMPTY_IDS);
				}
				continue;
			}
			const ids = ks.map((k) => k.id);
			if (prev === undefined || !sameIds(prev, ids)) {
				const frozen = Object.freeze(ids);
				order.set(p, frozen);
				r.order.set(p, frozen);
			}
			ks.forEach(({ id }, index) => {
				const n = nodes.get(id);
				if (n === undefined) fresh.set(id, { parent: p, index });
				else if (n.parent !== p || n.index !== index) {
					r.moved.add(id);
					if (n.parent !== p) reparented.add(id);
					n.parent = p;
					n.index = index;
				}
			});
		}
		// New roots (no new ancestor) bring their subtree.
		const add = (b: ProjectedBlock, parent: BlockId | null, index: number): void => {
			if (!nodes.has(b.id)) {
				covered.add(b.id);
				const rec = blocks.get(b.id)!;
				nodes.set(b.id, { parent, index, type: typeOf(b.id), data: rec.data, runs: runs(b.id) });
			}
			if (b.children.length > 0 && !order.has(b.id)) {
				const ids = Object.freeze(b.children.map((c) => c.id));
				order.set(b.id, ids);
				r.order.set(b.id, ids);
			}
			b.children.forEach((c, i) => add(c, b.id, i));
		};
		for (const [id, at] of fresh) {
			let under = false;
			for (
				let c = slots.get(id)?.parent ?? null;
				c !== null && !under;
				c = slots.get(c)?.parent ?? null
			)
				under = fresh.has(c);
			if (under || covered.has(id)) continue;
			const b = projectBlock(id);
			r.added.set(id, b);
			add(b, at.parent, at.index);
		}
	};

	/** The blocks whose shown kind followed their slot at the last report. */
	let followingBefore: BlockId[] = [];
	/** The document data's key at the last report. */
	let dataKey = '';
	/** Build the commit's report and advance the published index to it. */
	const report = (): IndexReport | null => {
		const before = published!;
		// Fold every queued transaction first: a follow-up a cleanup
		// started (a delete-mark repair) has already written, and the
		// first content read below would fold it mid-report, after the
		// child lists were read (found by the purge fuzz, rich lane, seeds 651 and 1271).
		syncAll();
		ensurePlacements();
		const r: IndexReport = {
			added: new Map(),
			removed: new Set(),
			moved: new Set(),
			meta: new Map(),
			content: new Map(),
			order: new Map()
		};
		// The document's data is news when it differs from what was published.
		if (dataChanged) {
			dataChanged = false;
			const data = docData();
			const key = keyOf(data);
			if (key !== dataKey) [r.data, dataKey] = [data, key];
		}
		if (kidsVersion === before.kids && candidates.size === 0) return r.data ? r : null;
		// Added subtrees carry their new descendants. A descendant that was
		// visible before is reported like any visible block (moved, retyped,
		// edited against its published baseline), so consumers keep it.
		const covered = new Set<BlockId>();
		/** Moved to another display parent: only those can show another kind (an index never does). */
		const reparented = new Set<BlockId>();
		const lists = kidsVersion !== before.kids && !allListsDirty;
		const after = kidsVersion === before.kids || lists ? before : reachable(before.nodes);
		if (lists) advance(before, r, covered, reparented);
		else if (after !== before) {
			for (const [parent, ids] of after.order) {
				const prev = before.order.get(parent);
				if (prev === undefined || !sameIds(prev, ids)) r.order.set(parent, ids);
			}
			for (const parent of before.order.keys()) {
				if (!after.order.has(parent)) r.order.set(parent, EMPTY_IDS);
			}
			const register = (b: ProjectedBlock): void => {
				if (!before.nodes.has(b.id)) covered.add(b.id);
				b.children.forEach(register);
			};
			for (const [id, n] of after.nodes) {
				if (!before.nodes.has(id)) {
					if (covered.has(id)) continue;
					const b = projectBlock(id);
					r.added.set(id, b);
					register(b);
				} else {
					const o = before.nodes.get(id)!;
					if (o.parent !== n.parent || o.index !== n.index) r.moved.add(id);
					if (o.parent !== n.parent) reparented.add(id);
				}
			}
			// Removed subtree ROOTS: a removed id whose before-parent stays
			// visible (or is the root). One under a removed parent leaves with
			// it; one under a surviving child of a removed subtree does not.
			for (const [id, o] of before.nodes) {
				if (after.nodes.has(id)) continue;
				if (o.parent === null || after.nodes.has(o.parent)) r.removed.add(id);
			}
		}
		const meta = (id: BlockId, n: NonNullable<ReturnType<typeof after.nodes.get>>) => {
			const rec = blocks.get(id)!;
			const type = typeOf(id);
			r.meta.set(id, { type, data: dataOf(rec) });
			n.type = type;
			n.data = rec.data;
		};
		for (const id of candidates) {
			const n = after.nodes.get(id);
			if (n === undefined || covered.has(id)) continue;
			const rec = blocks.get(id)!;
			if (typeOf(id) !== n.type || keyOf(rec.data) !== keyOf(n.data)) meta(id, n);
			const next = runs(id);
			if (next !== n.runs) {
				const key = keyOf(next);
				if ((n.key ??= keyOf(n.runs)) !== key) r.content.set(id, next);
				n.runs = next;
				n.key = key;
			}
		}
		// A block that starts or stops displaying a kind other than its
		// stored one moved, or its kind follows (or followed) its slot:
		// its kind is news. Without a placement change, only a retype
		// changes a shown kind — the retyped block's (a candidate) and the
		// kinds derived from it: a promoted or stray line shows its display
		// parent's default child.
		if (after !== before || lists || retyped) {
			const now = [...following];
			for (const id of [...reparented, ...now, ...followingBefore]) {
				const n = after.nodes.get(id);
				if (n !== undefined && !candidates.has(id) && !covered.has(id) && typeOf(id) !== n.type)
					meta(id, n);
			}
			followingBefore = now;
		}
		// A plain block directly in a list shows as its item (`shownItem`):
		// a block whose shown kind changed re-reads its children's (a worklist:
		// the map visits the entries added meanwhile).
		for (const id of r.meta.keys())
			for (const { id: kid } of kidsMap.get(id) ?? []) {
				const n = after.nodes.get(kid);
				if (n !== undefined && !covered.has(kid) && !r.meta.has(kid) && typeOf(kid) !== n.type)
					meta(kid, n);
			}
		retyped = false;
		candidates.clear();
		published = after;
		after.kids = kidsVersion;
		dirtyLists.clear();
		leftLists.clear();
		allListsDirty = false;
		if (indexChecks.on) checker().checkPublished(published!);
		const empty =
			r.added.size + r.removed.size + r.moved.size + r.meta.size + r.content.size + r.order.size;
		return empty === 0 && !r.data ? null : r;
	};

	/** Report the commit (or role change) to every subscriber, when it changed the visible document. */
	const publish = (origin: unknown, local: boolean): void => {
		const r = report();
		if (r !== null) callEach('[edytor-doc] change', [...reportSubs], r, origin, local);
	};
	const onUpdate = (_u: Uint8Array, origin: unknown, _d: EngineDoc, tr: unknown): void => {
		if ((tr as Tx).changed?.has(dataRoot)) dataChanged = true;
		publish(origin, (tr as { local?: boolean }).local === true);
	};

	/** Subscribe to the change report; the first subscription takes the baseline. */
	const onReport = (
		cb: (r: IndexReport, origin: unknown, local: boolean) => void
	): (() => void) => {
		if (reportSubs.size === 0) {
			syncAll();
			published = reachable();
			dataKey = keyOf(docData());
			candidates.clear();
			reporting = true;
			doc.on('update', onUpdate);
		}
		reportSubs.add(cb);
		return () => {
			if (!reportSubs.delete(cb) || reportSubs.size > 0) return;
			doc.off('update', onUpdate);
			published = null;
			reporting = false;
			candidates.clear();
		};
	};
	const hasSubscribers = (): boolean => reportSubs.size > 0;

	// ── the self-checks (`indexChecks`), built on their first run: a rebuild
	// from the replicated state each fact this index maintains must equal
	let checks: SelfChecks | undefined;
	const checker = (): SelfChecks =>
		(checks ??= indexChecks.of!({
			doc,
			registry,
			blocks,
			displaysMap,
			rows,
			streamIx,
			get delim() {
				return delim;
			},
			placementsMap,
			slotsByBlock,
			edges,
			rejected,
			get kids0() {
				return kids0;
			},
			get kidsMap() {
				return kidsMap;
			},
			get slots() {
				return slots;
			},
			get dissolved() {
				return dissolved;
			},
			following,
			cache,
			dirty,
			ownShim,
			own0,
			ownerOf,
			streamOf,
			sameClaims,
			dissolve,
			noteFollowing,
			ensurePlacements,
			computeFresh,
			unfolded,
			reachable
		}));

	// ── the view ──────────────────────────────────────────────────

	const ctx: ModelView = {
		blocks,
		own: ownShim,
		get placements() {
			ensurePlacements();
			return placementsMap;
		},
		get kids() {
			ensurePlacements();
			return kidsMap;
		},
		get order() {
			ensurePlacements();
			return order();
		},
		// The publication boundary shares THIS interner, so a payload
		// emitted by `project()`/`contentItems()` is `===` the runs' one.
		intern,
		displays,
		accepted: (id) => {
			ensurePlacements();
			return rejected.has(id) ? null : (edges.get(id) ?? null);
		}
	};

	// ── initial scan: index every existing block ────────────────────
	registry.forEachAttr((v: unknown, id: string) => {
		if (!isNodeLike(v)) return;
		updateBlockRec(id);
		for (const b of [id, ...syncIncarnations(id)]) {
			const row = scanRow(b);
			if (row !== undefined) {
				rows.set(b, row);
				homeOfText.set(row.text, b);
			}
		}
	});
	rebuildTable(new Set());
	applyReclaims(null);
	settleShells(shells, null);

	// Every commit folds once, before the document's `afterTransaction` listeners.
	doc.on('commit', onCommit);
	/** Derived state lives exactly as long as the doc. */
	const teardown = (): void => {
		doc.off('commit', onCommit);
		doc.off('destroy', teardown);
		doc.off('update', onUpdate);
		indexes.delete(doc);
	};
	doc.on('destroy', teardown);

	// ── public surface ───────────────────────────────────────────────
	const view: RunView = {
		version: () => {
			syncAll();
			return version;
		},
		runs,
		contentItems: (b: BlockId): ContentItem[] => {
			syncAll();
			return blocks.get(b)?.deleted === false ? itemsOf(b) : [];
		},
		// Inline atoms always carry `data` (`{}` when absent) — the public
		// `JSONInlineBlock` shape of `edytor.value`.
		contentJSON: (b: BlockId) =>
			runs(b).map((r) =>
				r.kind === 'text'
					? { text: r.text, ...(r.marks !== undefined && { marks: cloneJsonSafe(r.marks) }) }
					: { id: r.id, type: r.type, data: r.data === undefined ? {} : cloneJsonSafe(r.data) }
			),
		view: (tr?: unknown): ModelView => {
			syncAll();
			if (tr !== undefined && !committed.has(tr as Tx)) syncPending(tr as Tx);
			return ctx;
		},
		displayType: (id) => {
			if (roles === null) return undefined;
			syncAll();
			ensurePlacements();
			const shown = blocks.has(id) ? typeOf(id) : undefined;
			return shown === blocks.get(id)?.type ? undefined : shown;
		},
		dissolved: (id) => {
			syncAll();
			ensurePlacements();
			return dissolved.has(id);
		},
		project: (root?: BlockId): ProjectedBlock[] => {
			syncAll();
			ensurePlacements();
			return root === undefined
				? (kidsMap.get(null) ?? []).map((k) => projectBlock(k.id))
				: [projectBlock(root)];
		},
		roles: (next) => {
			roles = next;
			placementFull = true;
			version++;
			// No commit carries a role change: report it now (not inside a
			// transaction, whose commit reports it), so every view follows.
			if (hasSubscribers() && !openTx()) publish(null, false);
		},
		track: () => {
			syncAll();
			const f: Folded = { touched: new Map(), wrote: false };
			frames.add(f);
			return {
				end: () => {
					syncAll();
					frames.delete(f);
					return f;
				},
				quiet: (write) => {
					syncAll();
					const g: Folded = { touched: new Map(), wrote: false };
					frames.delete(f);
					frames.add(g);
					try {
						write();
						syncAll();
					} finally {
						frames.delete(g);
						frames.add(f);
						f.wrote ||= g.wrote;
					}
				}
			};
		},
		onReport,
		debug
	};
	return view;
};
