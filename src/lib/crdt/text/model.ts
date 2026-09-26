/**
 * Text ownership layer (U04) — stable backing texts + ordered slice claims.
 *
 * Every block keeps a private *backing text* (`content` node) whose items are
 * never moved or copied. A block's visible content is DERIVED from its
 * `slices` sequence — an ordered list of replicated claim records:
 *
 * - slice record `{t, s, e}` — claims the atoms of backing text `t` in the
 *   range `[resolve(s), resolve(e))`. `t` is the home block id of the text.
 * - merge claim `{m}` — claims whatever block `m`'s slice list currently
 *   covers (a live, transitive claim — splits inside `m`'s list propagate).
 *
 * Anchors are relative positions into the backing text:
 *
 * - `{i: null, a: -1}` — "beginning of the type" (resolves to 0; covers
 *   prepends — this is what makes typing at the start of a head slice work).
 * - `{i: null, a: 0}` — "end of the type" (resolves to the live length;
 *   covers appends).
 * - `{i: {c, k}, a: 0}` — bound to the item `(client, clock)`; resolves to
 *   the position *before* that item and follows it (never resurrects it: a
 *   deleted anchor item resolves to the gap where it lived).
 *
 * Ownership resolution (see docs/crdt-v14-text-ownership-adr.md):
 *
 * - `owner(b)` — the block that displays `b`'s slice list: `del` → `DEAD`
 *   (an internal unique symbol, never a block id); otherwise follow the
 *   max-stamp merge claim on `b`'s list; unclaimed → `b` itself. Cycles
 *   (concurrent `A→B` / `B→A` merges) resolve to the claimer of the
 *   max-stamp claim edge inside the cycle.
 * - `hidden(b)` ⟺ `owner(b) !== b` — merged-away blocks have no display.
 * - Atom `i` of text `t` is displayed by the live slice record covering it
 *   with the best key `(g, stamp)` — generation first (a later split's
 *   materialized records outrank the coverage they replace, through any
 *   claim depth), then the claim item's `(client, clock)` stamp for truly
 *   concurrent overlaps. The candidate block is `owner(holderOf(record))`,
 *   so a merged block's records route to its owner automatically.
 * - A deleted holder's records keep contesting: atoms they win are hidden
 *   (R3 — deleting a block hides what it displays, including atoms a peer
 *   typed concurrently into its claim window), never handed to a covering
 *   neighbour.
 *
 * Engine notes: slice entries are `ContentAny` objects; their item id
 * `(client, clock + offset-in-item)` is the claim stamp. Anchors use the
 * vendored relative-position machinery with `followUndoneDeletions = false`
 * for replica-independent resolution.
 */
import type { EngineApi, EngineDoc, EngineNode, YDoc, YNode } from '../engine-api.js';
import { DATA, ID, TYPE } from '../schema.js';
import { sanitizeWireJson, sanitizeWireString } from '../../utils/json.js';

/** Block-id of the backing text a slice record points into. */
export type TextId = string;
export type BlockId = string;

/** Serialized anchor inside a slice record. */
export type Anchor = { i: { c: number; k: number } | null; a: number };

/**
 * Slice-record payload stored in a block's `slices` sequence.
 *
 * `g` is a claim GENERATION: records written by a split (or a boundary
 * rewrite) carry `maxG(text) + 1` for the text they cover, so a causally
 * later partition deterministically outranks every record that covered
 * those atoms before it — including records reached through live merge
 * claims. Missing `g` reads as 0 (seed and legacy records).
 */
export type SliceRecord = { t: TextId; s: Anchor; e: Anchor; g?: number };
/** Merge-claim payload: "this list claims block `m`'s slice list". */
export type MergeClaim = { m: BlockId };
export type SlicePayload = SliceRecord | MergeClaim;

export const isSliceRecord = (v: unknown): v is SliceRecord =>
	v != null &&
	typeof v === 'object' &&
	typeof (v as SliceRecord).t === 'string' &&
	(v as SliceRecord).s != null &&
	(v as SliceRecord).e != null;
export const isMergeClaim = (v: unknown): v is MergeClaim =>
	v != null && typeof v === 'object' && typeof (v as MergeClaim).m === 'string';

/** Deterministic claim stamp = engine item id (client-major order). */
export type Stamp = { c: number; k: number };
export const cmpStamp = (a: Stamp, b: Stamp): number => a.c - b.c || a.k - b.k;

/** One live entry of a `slices` sequence. */
export type SliceEntry = {
	payload: SlicePayload;
	stamp: Stamp;
	/** Live index inside the holder's `slices` sequence (for patching). */
	seqIndex: number;
};

/** Structural item for sequence walks (`node._start`). */
export type SeqItem = {
	id: { client: number; clock: number };
	length: number;
	deleted: boolean;
	right: SeqItem | null;
	content: {
		getContent(): unknown[];
		isCountable?(): boolean;
		/** `ContentString` — the item's whole string (slice it; never `getContent()`-split). */
		str?: string;
		/** `ContentFormat` — the mark key this marker sets (`value == null` clears). */
		key?: string;
		value?: unknown;
	};
};

/**
 * The per-atom claim-contest key — the same order `computeOwnership` runs
 * per atom and `insertIntoText` runs over the append range:
 *
 * - `g` (generation): records written by a later split/rewrite carry a
 *   strictly larger `g` than every record that covered the text before
 *   them, so causal partitions beat any pre-existing coverage (in
 *   particular a claimed list's own records can never re-swallow atoms a
 *   sibling now owns — this is what makes split-of-claimed-content
 *   deterministic at any claim depth).
 * - `s0` (resolved left edge): at equal generation the innermost claim
 *   wins — concurrent splits at different anchors then produce the
 *   seam-preserving nested partition (split at 3 + split at 8 ⇒
 *   [0,3)|[3,8)|[8,E)) rather than winner-take-all.
 * - `st` (stamp): the claim item's (client, clock) — arbitrary but
 *   deterministic order for genuinely concurrent overlaps with equal
 *   generation AND equal left edge (same-anchor concurrent splits).
 */
export type ClaimKey = { g: number; s0: number; st: Stamp };
export const claimKeyBetter = (a: ClaimKey, b: ClaimKey | null | undefined): boolean =>
	b == null ||
	a.g - b.g > 0 ||
	(a.g === b.g && (a.s0 - b.s0 > 0 || (a.s0 === b.s0 && cmpStamp(a.st, b.st) > 0)));

export const nodeStart = (node: EngineNode): SeqItem | null =>
	(node as unknown as { _start?: SeqItem | null })._start ?? null;

/**
 * Read a `slices` sequence into live entries with claim stamps. Deleted items
 * are skipped entirely — a tombstoned record no longer claims (undo of a
 * merge/split relinquishes the claim).
 */
export const readSliceEntries = (slicesNode: EngineNode | undefined): SliceEntry[] => {
	const out: SliceEntry[] = [];
	if (!slicesNode) return out;
	let seqIndex = 0;
	for (let it = nodeStart(slicesNode); it !== null; it = it.right) {
		if (it.deleted) continue;
		const countable = it.content.isCountable ? it.content.isCountable() : true;
		if (!countable) continue;
		const arr = it.content.getContent();
		const n = Math.min(arr.length, it.length);
		for (let j = 0; j < n; j++) {
			const payload = arr[j];
			if (isSliceRecord(payload) || isMergeClaim(payload)) {
				out.push({
					payload,
					stamp: { c: it.id.client, k: it.id.clock + j },
					seqIndex
				});
			}
			seqIndex++;
		}
		// A countable item's live span is its length even when some entries
		// are unrecognized payloads (they still occupy positions).
		seqIndex += it.length - n;
	}
	return out;
};

// ── bounded formatted range reads (WU8 → U3) ─────────────────────────
//
// `itemsOfRange` used to render the WHOLE backing text through
// `toDelta().toJSON()` and then clip — repeated small slices of one long
// text paid O(text length) each. U3 consolidated the physical-sequence
// interpretation itself into the vendored engine: `openRangeCursor`
// opens the vendored `Y.RangeCursor`, which walks the live item list
// with the SAME `readItemPieces` dispatch `toDelta` consumes — format
// markers fold into cursor state by their effective deleted flag,
// countable pieces emit only where they overlap `[i0, i1)`, and the
// engine's search-marker pool supplies format-aware checkpoints (cold
// walks plant sparse markers at a fixed cadence, so repeated reads stay
// bounded by gap + range — the role the Edytor-side checkpoint index
// played in WU8). Like `toDelta()`, the walk sees items integrated
// earlier in the SAME transaction, so read-your-writes is preserved.
//
// What stays Edytor-side (the projection layer): `readRange` maps the
// native piece stream to `RangeItem`s — UTF-16 `str` slices, inline-atom
// `getContent()` entries, canonical-mark merging — and `protectItems`/
// interning make the borrowed payloads immutable before publication.
//
// Mark-state aliasing contract: an emitted `marks` object ALIASES the
// cursor's materialized format state for its fold span — SHARED between
// adjacent pieces of one state. Mutating it corrupts subsequent pieces
// of the same read, so consumers must treat emitted `marks` as
// read-only — the run layer interns them before publishing.

/** Canonical JSON key (sorted keys, recursive) — mark-set equality/interning. */
export const canonKey = (v: unknown): string => {
	if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
	if (Array.isArray(v)) return `[${v.map(canonKey).join(',')}]`;
	const keys = Object.keys(v as Record<string, unknown>).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonKey((v as Record<string, unknown>)[k])}`).join(',')}}`;
};

/** One emitted range-read element — the `ContentItem` shape. */
export type RangeItem =
	| { kind: 'text'; text: string; marks?: Record<string, unknown> }
	| { kind: 'inline'; id: string; type: string; data?: Record<string, unknown> };

/**
 * One element of the vendored `Y.RangeCursor` piece stream — the
 * read-side analogue of a `toDelta` op's content payload, carrying the
 * same attribution inputs (structural mirror of the engine's
 * `RangePiece`; see `vendor/yjs/src/utils/RangeCursor.js`).
 */
export type RangePiece = {
	/**
	 * The piece's content object — BORROWED, never mutated/copied. Emit
	 * `[offset, offset + len)` of it: `str` slices for `ContentString`,
	 * `getContent()` entries for element content.
	 */
	content: {
		getContent?(): unknown[];
		str?: string;
		key?: string;
		value?: unknown;
	};
	/** Replicated id of the first emitted element. */
	id: { client: number; clock: number };
	/** Rendered position the emitted range starts at. */
	index: number;
	/** Start of the emitted range inside `content`. */
	offset: number;
	/** Rendered length (`0` for format markers/invisible pieces). */
	len: number;
	/** Effective tombstone flag (renderer-aware). */
	deleted: boolean;
	/** Native attribution inputs; `null` when unattributed. */
	attrs: unknown[] | null;
	/** Folded mark state at the piece — SHARED across same-state pieces; read-only. */
	formats: Record<string, unknown> | undefined;
};

/**
 * The vendored bounded read cursor (U3) — a forward-only cursor over one
 * backing text's item list producing {@link RangePiece}s. `read` seeks via
 * the engine's search-marker checkpoints; a range ending inside an item
 * leaves the cursor parked at that item's left edge; a backward read
 * rewinds and re-seeks (format state cannot un-apply).
 */
export type RangeCursor = {
	read(i0: number, i1: number, stats?: RangeReadStats): RangePiece[];
};

/** Per-read instrumentation: sequence items stepped over / format markers seen. */
export type RangeReadStats = { items: number; markers: number };

const marksEqual = (
	a: Record<string, unknown> | undefined,
	b: Record<string, unknown> | undefined
): boolean => a === b || (a !== undefined && b !== undefined && canonKey(a) === canonKey(b));

/**
 * Recursively freeze a JSON payload — the immutable form public snapshot
 * surfaces hand out (the runs view's `intern` freezes its canonical copies
 * with this; the same helper backs the freeze-clone fallback interner).
 */
export const deepFreeze = <T>(v: T): T => {
	if (v !== null && typeof v === 'object') {
		for (const k of Object.keys(v as Record<string, unknown>))
			deepFreeze((v as Record<string, unknown>)[k]);
		Object.freeze(v);
	}
	return v;
};

/**
 * Publication boundary for range-read items (R4 hardening).
 *
 * `readRange`/`itemsOfRange`/`contentItemsOf` emit BORROWED payloads — a
 * text item's `marks` can alias the cursor's live format state (and, via a
 * checkpoint-seeded cursor, the maintained read index itself), while an
 * inline item's `data` IS the replicated attr object. Publishing them
 * verbatim lets a caller's mutation reach live engine state and — through
 * the next `encodeStateAsUpdate` — every peer, with no update event.
 *
 * Rewriting each payload through `intern` substitutes a canonical
 * deep-frozen clone (the shared model state's interner, or a plain
 * freeze-clone where no state is attached): mutating a published item
 * throws or lands nowhere, never on engine state. Item wrappers and the
 * array stay fresh mutable copies — callers may splice/reorder them.
 * `intern` MUST return a frozen value; both provided interners do.
 */
export const protectItems = (items: RangeItem[], intern: <T>(v: T) => T): RangeItem[] => {
	for (const item of items) {
		if (item.kind === 'text') {
			if (item.marks !== undefined) item.marks = intern(item.marks);
		} else if (item.data !== undefined) {
			item.data = intern(item.data);
		}
	}
	return items;
};

/**
 * One inline-atom element → its `ContentItem` shape. Live `YNode`
 * children read via `getAttr` (fresh-render shape); serialized
 * `{attrs:{k:{value}}}` payloads (the maintained `.delta` shape, kept
 * for parity with the old reader) unwrap the op-wrapped values.
 */
export const inlineItemOf = (entry: unknown): RangeItem => {
	let id: unknown;
	let type: unknown;
	let data: unknown;
	if (entry != null && typeof (entry as { getAttr?: unknown }).getAttr === 'function') {
		const node = entry as EngineNode;
		id = node.getAttr(ID);
		type = node.getAttr(TYPE);
		data = node.getAttr(DATA);
	} else {
		const attrs = (entry as { attrs?: Record<string, unknown> })?.attrs ?? {};
		const attrVal = (a: unknown) =>
			a !== null && typeof a === 'object' && 'value' in (a as object)
				? (a as { value: unknown }).value
				: a;
		id = attrVal(attrs.id);
		type = attrVal(attrs.type);
		data = attrVal(attrs.data);
	}
	return {
		kind: 'inline',
		id: id as string,
		type: type as string,
		...(data === undefined ? {} : { data: data as Record<string, unknown> })
	};
};

/**
 * Read `[i0, i1)` through the cursor — the Edytor projection over the
 * native piece stream. Deleted and zero-length pieces (format markers,
 * renderer-hidden ranges) emit nothing; `ContentString` pieces emit
 * UTF-16 `str` slices under their folded marks; element pieces emit one
 * `inline` item per `getContent()` entry. Text pieces adjacent under
 * canonically-equal marks merge into one item — the old delta-JSON
 * reader's merge — so consumers see identical shapes either way.
 */
export const readRange = (
	cur: RangeCursor,
	i0: number,
	i1: number,
	stats?: RangeReadStats
): RangeItem[] => {
	const items: RangeItem[] = [];
	for (const piece of cur.read(i0, i1, stats)) {
		if (piece.deleted || piece.len === 0) continue;
		const c = piece.content;
		if (typeof c.str === 'string') {
			const marks = piece.formats;
			const slice = c.str.slice(piece.offset, piece.offset + piece.len);
			const last = items[items.length - 1];
			if (last !== undefined && last.kind === 'text' && marksEqual(last.marks, marks)) {
				(last as { text: string }).text += slice;
			} else {
				// JSON-payload contract: no `marks: undefined` key.
				items.push({
					kind: 'text',
					text: slice,
					...(marks === undefined ? {} : { marks })
				});
			}
		} else if (typeof c.getContent === 'function') {
			const arr = c.getContent();
			for (let k = piece.offset; k < piece.offset + piece.len; k++) {
				items.push(inlineItemOf(arr[k]));
			}
		}
	}
	return items;
};

/** The block-records view the ownership engine needs. */
export type TextBlockRec = {
	id: BlockId;
	deleted: boolean;
	/** Backing text node (the block's `content` child). */
	content: EngineNode | undefined;
	/** The `slices` child node (write handle). */
	slicesNode: EngineNode | undefined;
	/** Parsed live entries of `slices`. */
	entries: SliceEntry[];
};

/**
 * The internal "no display owner" verdict. A `unique symbol` — never a
 * block-id string: a caller block literally named `'dead'` must stay an
 * ordinary editable block (U04-F1 defect C: the old `'dead'` string sentinel
 * collided with that valid id, blanking its content and confusing the
 * placement/run consumers that compared owners by string).
 */
export const DEAD: unique symbol = Symbol('edytor.crdt.dead');
export type Owner = BlockId | typeof DEAD;

/**
 * `owner(b)` — the block that displays `b`'s slice list.
 *
 * - unknown / `del`-flagged → `DEAD`
 * - no merge claims on `b`'s list → `b`
 * - else follow the max-stamp claim's claimer, transitively; a claim cycle
 *   resolves to the claimer of the cycle's max-stamp edge (the block that
 *   issued the winning claim keeps its own list).
 */
export const computeOwners = (blocks: Map<BlockId, TextBlockRec>): Map<BlockId, Owner> => {
	// claimsOn[X] = every live `{m:X}` entry held by a LIVE block. A claim
	// written by a `del`-flagged block is inert — deleting the merge
	// destination voids its claims rather than swallowing the claimed
	// content into a dead subtree (delete-beats-merge).
	const claimsOn = new Map<BlockId, { claimer: BlockId; stamp: Stamp }[]>();
	for (const [holderId, rec] of blocks) {
		if (rec.deleted) continue;
		for (const e of rec.entries) {
			if (!isMergeClaim(e.payload)) continue;
			const list = claimsOn.get(e.payload.m) ?? [];
			list.push({ claimer: holderId, stamp: e.stamp });
			claimsOn.set(e.payload.m, list);
		}
	}
	const topClaim = (id: BlockId): { claimer: BlockId; stamp: Stamp } | null => {
		const claims = claimsOn.get(id);
		if (!claims || claims.length === 0) return null;
		let best = claims[0];
		for (const c of claims) if (cmpStamp(c.stamp, best.stamp) > 0) best = c;
		return best;
	};
	const memo = new Map<BlockId, Owner>();
	const ownerOf = (b: BlockId): Owner => {
		if (memo.has(b)) return memo.get(b)!;
		const path: BlockId[] = [];
		let cur = b;
		let result: Owner;
		for (;;) {
			if (memo.has(cur)) {
				result = memo.get(cur)!;
				break;
			}
			const rec = blocks.get(cur);
			if (!rec || rec.deleted) {
				result = DEAD;
				break;
			}
			const inPath = path.indexOf(cur);
			if (inPath >= 0) {
				// Claim cycle: the max-stamp claim edge inside the cycle wins —
				// its claimer keeps its own list, everything else routes to it.
				const cycle = path.slice(inPath);
				let winner: BlockId = cur;
				let winnerStamp: Stamp | null = null;
				for (const member of cycle) {
					const top = topClaim(member)!;
					if (winnerStamp === null || cmpStamp(top.stamp, winnerStamp) > 0) {
						winnerStamp = top.stamp;
						winner = top.claimer;
					}
				}
				result = winner;
				break;
			}
			const top = topClaim(cur);
			if (top === null) {
				result = cur;
				break;
			}
			path.push(cur);
			cur = top.claimer;
		}
		// The terminal node owns `result` too — `path` only holds the hops
		// that were followed, so without this the queried block itself is
		// never memoized (and `owners.get(b)` reports DEAD for every
		// unclaimed block).
		memo.set(cur, result);
		for (const p of path) memo.set(p, result);
		return result;
	};
	for (const id of blocks.keys()) ownerOf(id);
	return memo;
};

/**
 * Resolve one anchor against `text` → live index, or `null` when the anchor's
 * item is not yet integrated on this replica (converges once it arrives).
 * `assoc < 0` + `i: null` → 0; `i: null` + `assoc >= 0` → live length.
 */
export type AnchorResolver = (text: EngineNode, anchor: Anchor) => number | null;

/** A contiguous run of atoms one block displays, inside one backing text. */
export type OwnedSeg = {
	t: TextId;
	i0: number;
	i1: number;
	/** The block whose `slices` list physically holds the covering record. */
	holder: BlockId;
	/** That record's live index inside the holder's `slices` sequence. */
	seqIndex: number;
	/** The entry on the FLATTENED block's own list this atom range entered
	 *  through — the record itself for direct coverage, or the top-level
	 *  merge claim that pulled it in. Used by splitSlices to partition at
	 *  entry granularity. */
	via: SliceEntry;
};

/**
 * Resolved ownership as ONE disjoint interval inside a backing text (WU6):
 * a maximal run of positions sharing the same winning claim record — the
 * per-atom contest's victor — and therefore the same display owner. A single
 * winning claim over 100k positions is ONE interval; interval count is
 * bounded by claim-boundary count (≤ 2·claims − 1 per text), never by the
 * covered text length. Intervals per text are ordered and disjoint, so
 * point/range queries are binary searches and nearest-owned-position
 * queries hop between interval boundaries.
 *
 * `claim` identity matters, not just `owner`: two overlapping records
 * routing to the same owner must not double-emit (concurrent splits at
 * overlapping anchors produce exactly such records), so adjacent spans won
 * by DIFFERENT records stay separate intervals even under the same owner.
 */
export type OwnInterval = {
	/** Start offset (inclusive) in the backing text. */
	i0: number;
	/** End offset (exclusive). */
	i1: number;
	/** The block displaying these atoms (`owner(holderOf(claim))`). */
	owner: BlockId;
	/** The winning slice-record entry. */
	claim: SliceEntry;
};

/**
 * Index of the first interval in sorted disjoint `ivs` whose `i1` is > `pos`
 * — the only interval that can contain `pos` and, when `pos` sits in a gap,
 * the first interval starting after it. Binary search over interval ends.
 */
const intervalIndexAt = (ivs: readonly OwnInterval[], pos: number): number => {
	let lo = 0;
	let hi = ivs.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (ivs[mid].i1 <= pos) lo = mid + 1;
		else hi = mid;
	}
	return lo;
};

/** The interval containing `pos`, or `undefined` (gap / out of range). */
export const intervalAt = (
	ivs: readonly OwnInterval[] | undefined,
	pos: number
): OwnInterval | undefined => {
	if (!ivs || ivs.length === 0) return undefined;
	const iv = ivs[intervalIndexAt(ivs, pos)];
	return iv !== undefined && iv.i0 <= pos ? iv : undefined;
};

/**
 * Display owner of atom `pos` — the interval analogue of the old dense
 * `atomOwner.get(t)[pos]` (`undefined` = dead/unclaimed).
 */
export const ownerAt = (
	ivs: readonly OwnInterval[] | undefined,
	pos: number
): BlockId | undefined => intervalAt(ivs, pos)?.owner;

/**
 * The intervals overlapping `[i0, i1)`, in order. Full intervals are yielded
 * (not clipped) — callers that need only the overlap clip against `i0`/`i1`.
 */
export function* intervalsOver(
	ivs: readonly OwnInterval[] | undefined,
	i0: number,
	i1: number
): IterableIterator<OwnInterval> {
	if (!ivs || ivs.length === 0 || i1 <= i0) return;
	for (let k = intervalIndexAt(ivs, i0); k < ivs.length; k++) {
		const iv = ivs[k];
		if (iv.i0 >= i1) break;
		yield iv;
	}
}

/**
 * Nearest owned position to `i` inside `[0, len)` scanning in `dir`:
 * `dir < 0` finds the last owned position ≤ `i − 1`, `dir > 0` the first
 * owned position ≥ `i`. −1 when none exists. Interval-boundary hopping
 * replaces the old per-position outward scan of the dense owner row.
 */
export const nearestOwned = (
	ivs: readonly OwnInterval[] | undefined,
	i: number,
	dir: number,
	len: number
): number => {
	if (!ivs || ivs.length === 0) return -1;
	if (dir < 0) {
		const target = Math.min(i - 1, len - 1);
		if (target < 0) return -1;
		const k = intervalIndexAt(ivs, target);
		const iv = ivs[k];
		if (iv !== undefined && iv.i0 <= target) return target; // inside an interval
		const prev = ivs[k - 1];
		return prev !== undefined ? prev.i1 - 1 : -1; // gap → prior interval's tail atom
	}
	const target = Math.max(i, 0);
	if (target >= len) return -1;
	const k = intervalIndexAt(ivs, target);
	const iv = ivs[k];
	if (iv === undefined) return -1;
	return iv.i0 <= target ? target : Math.min(iv.i0, len - 1); // gap → next interval's head
};

/** One resolved claim feeding the ownership sweep. */
export type SweepClaim = {
	/** Covered span `[lo, hi)` inside the text (already clamped to its length). */
	lo: number;
	hi: number;
	/** The contest key — same order the dense per-position loop applied. */
	key: ClaimKey;
	/** The slice-record entry claiming the span. */
	entry: SliceEntry;
	/** The resolved display owner of `entry`'s holder; `DEAD` hides what it wins. */
	owner: Owner;
};

// ── ownership sweep internals ────────────────────────────────────────
// A lazy-expiry max-heap over active claims. Between two consecutive
// claim endpoints the active set is constant, so the winner is too; the
// heap keeps the max-key claimant on top in O(log n).

const heapBetter = (a: SweepClaim, b: SweepClaim): boolean => claimKeyBetter(a.key, b.key);

const heapPush = (h: SweepClaim[], c: SweepClaim): void => {
	h.push(c);
	let i = h.length - 1;
	while (i > 0) {
		const p = (i - 1) >> 1;
		if (!heapBetter(h[i], h[p])) break;
		const tmp = h[i];
		h[i] = h[p];
		h[p] = tmp;
		i = p;
	}
};

const heapPop = (h: SweepClaim[]): void => {
	const tail = h.pop()!;
	if (h.length === 0) return;
	h[0] = tail;
	let i = 0;
	for (;;) {
		const l = i * 2 + 1;
		const r = l + 1;
		let m = i;
		if (l < h.length && heapBetter(h[l], h[m])) m = l;
		if (r < h.length && heapBetter(h[r], h[m])) m = r;
		if (m === i) break;
		const tmp = h[i];
		h[i] = h[m];
		h[m] = tmp;
		i = m;
	}
};

/**
 * Ordered disjoint winner intervals over one text's resolved claims — the
 * same per-atom contest the old dense loop ran (max `(g, s0, stamp)` per
 * position), computed over claim ENDPOINTS instead of positions. Each
 * elementary span between consecutive endpoints takes the max-key active
 * claim; adjacent spans won by the SAME record coalesce into one interval.
 * A gap (no active claim) resets coalescing, so intervals stay disjoint
 * and identical-record coverage on both sides of a gap stays two
 * intervals — exactly what the dense `claims[i] === entry` row encoded.
 *
 * Cost is O(c log c) for `c` claims on the text — independent of the
 * text's length. Interval count ≤ 2c − 1.
 */
export const sweepOwnership = (claims: SweepClaim[]): OwnInterval[] => {
	const ivs: OwnInterval[] = [];
	if (claims.length === 0) return ivs;
	// Unique sorted claim endpoints — the only positions where the winner
	// (or covered-ness) can change.
	const pts: number[] = [];
	for (const c of claims) pts.push(c.lo, c.hi);
	pts.sort((a, b) => a - b);
	let np = 0;
	for (const p of pts) {
		if (np === 0 || pts[np - 1] !== p) pts[np++] = p;
	}
	pts.length = np;
	const byLo = claims.slice().sort((a, b) => a.lo - b.lo);
	const heap: SweepClaim[] = [];
	let ci = 0;
	let last: OwnInterval | null = null;
	for (let pi = 0; pi + 1 < pts.length; pi++) {
		const p = pts[pi];
		while (ci < byLo.length && byLo[ci].lo <= p) heapPush(heap, byLo[ci++]);
		while (heap.length > 0 && heap[0].hi <= p) heapPop(heap);
		const top = heap[0];
		if (top === undefined || top.owner === DEAD) {
			last = null; // unowned or dead-won span — break coalescing
			continue;
		}
		const q = pts[pi + 1];
		if (last !== null && last.claim === top.entry) {
			last.i1 = q; // same winning record — extend the open interval
		} else {
			last = { i0: p, i1: q, owner: top.owner, claim: top.entry };
			ivs.push(last);
		}
	}
	return ivs;
};

/**
 * Every `(holder, entry)` pair whose payload is a slice record — the
 * shared enumeration behind the claim-election passes
 * ({@link gatherClaims}) and the `maxG` scan.
 */
export function* eachSliceRecord(
	blocks: Map<BlockId, TextBlockRec>
): IterableIterator<[BlockId, SliceEntry]> {
	for (const [holderId, rec] of blocks) {
		for (const e of rec.entries) {
			if (isSliceRecord(e.payload)) yield [holderId, e];
		}
	}
}

/** A resolved claim candidate — {@link SweepClaim} plus text + holder identity. */
export type GatheredClaim = SweepClaim & {
	/** `entry.payload.t` — the backing text the record covers. */
	t: TextId;
	/** The block whose `slices` list physically holds the record. */
	holder: BlockId;
};

/**
 * The shared claim-election gather (S2) — one pass over `(holder, entry)`
 * pairs resolving each slice record to its clamped `[lo, hi)` span and
 * stamping the `(g, s0, stamp)` contest key. Used by `computeOwnership`
 * (all texts), `claimRoutesToB` (one text), `undoRepairClaims` (one text,
 * redone-space resolution) and the runs layer's per-text claim index —
 * the four sites used to each re-implement this walk.
 *
 * `resolve` parameterizes anchor→index resolution because the callers
 * deliberately differ: `computeOwnership` shares the view's memoized
 * resolver, `claimRoutesToB` must resolve FRESH (it runs post-insert,
 * before any view cache could know the new atoms), `undoRepairClaims`
 * resolves through the local `redone` chain, and the runs layer uses its
 * maintained `rangeCache`.
 *
 * `pairs` is the pair source — `eachSliceRecord(blocks)` for a whole-
 * registry scan, or the runs layer's per-text record index. `opts.t`
 * narrows to one text; `opts.skip` drops an entry before resolution
 * (undo-repair's fresh-claim exclusion). Dead-held records contest with
 * owner `DEAD` (the sweep hides what they win); records on a missing text
 * or with unresolvable anchors contribute nothing.
 */
export const gatherClaims = (
	blocks: Map<BlockId, TextBlockRec>,
	ownerOf: (b: BlockId) => Owner,
	pairs: Iterable<[BlockId, SliceEntry]>,
	resolve: (entry: SliceEntry, text: EngineNode) => readonly [number, number] | null,
	opts?: { t?: TextId; skip?: (entry: SliceEntry) => boolean }
): GatheredClaim[] => {
	const out: GatheredClaim[] = [];
	for (const [holder, e] of pairs) {
		const owner = ownerOf(holder);
		const p = e.payload as SliceRecord;
		if (opts?.t !== undefined && p.t !== opts.t) continue;
		if (opts?.skip !== undefined && opts.skip(e)) continue;
		const textRec = blocks.get(p.t);
		if (!textRec || !textRec.content) continue;
		const range = resolve(e, textRec.content);
		if (range === null) continue;
		// Clamp to the text's live length — a record's resolved range can
		// extend past the end (shrink raced a claim), and atoms past `len`
		// don't exist to own.
		const lo = Math.min(range[0], textRec.content.length);
		const hi = Math.min(range[1], textRec.content.length);
		if (lo >= hi) continue;
		out.push({
			lo,
			hi,
			// `s0` is the RAW resolved start (not the length-clamped `lo`):
			// the innermost-claim tiebreak ranks the claim's authored edge.
			key: { g: p.g ?? 0, s0: range[0], st: e.stamp },
			entry: e,
			owner,
			t: p.t,
			holder
		});
	}
	return out;
};

/**
 * Optional traversal hooks {@link bindText}'s `flatten` invokes — the
 * maintained-runs layer's dependency capture (`flattenTracked`): every
 * consulted `slices` list (with its live entries, for effects indexing)
 * and every consulted record's text.
 */
export type FlattenTrack = {
	list?: (listId: BlockId, entries: readonly SliceEntry[] | undefined) => void;
	text?: (t: TextId) => void;
};

/**
 * Bound context the ownership engine works over — one pass over the registry.
 * `intervals.get(t)` = the ordered disjoint {@link OwnInterval}s of text `t`
 * (`undefined` positions = dead/unclaimed). `iv.claim` is the winning slice
 * RECORD for the whole span — ownership is per-record, not per-holder, so
 * two overlapping records routing to the same block cannot double-emit an
 * atom (concurrent splits at overlapping anchors produce exactly such
 * records). Point queries go through {@link ownerAt}/{@link intervalAt},
 * range scans through {@link intervalsOver}, and nearest-owned-position
 * queries through {@link nearestOwned} — no dense per-position arrays.
 */
export type Ownership = {
	ownerOf: (b: BlockId) => Owner;
	hidden: (b: BlockId) => boolean;
	/** Per-text ordered disjoint ownership intervals. Texts only appear when
	 *  a record covers ≥1 of their positions. */
	intervals: Map<TextId, OwnInterval[]>;
	/** Resolved (anchor → index) view used to build `intervals` — reused by
	 *  flatten so ops never resolve the same anchor twice. */
	resolvedRange: (entry: SliceEntry, text: EngineNode) => [number, number] | null;
	/** Highest generation `g` of any record covering each text — rewrites
	 *  write `maxG + 1` to deterministically win their range. Tracked over
	 *  EVERY slice record, including dead-held and never-winning ones. */
	maxG: Map<TextId, number>;
};

export const bindText = (Y: EngineApi) => {
	const newNode = (name: string): EngineNode => new Y.Node(name) as unknown as EngineNode;

	/**
	 * Anchor JSON → engine RelativePosition → live index.
	 *
	 * `followUndoneDeletions = false` (the default everywhere outside the
	 * undo-repair planner) resolves item-bound anchors to the gap where the
	 * item lives — a deleted anchor never resurrects and every replica
	 * derives the same position. `true` additionally follows the LOCAL
	 * `redone` chain of a tombstoned item to its undo-resurrected copy —
	 * replica-DEPENDENT (peers that never ran the undo have no redone
	 * pointers), so it is used ONLY by {@link undoRepairClaims} as the
	 * local oracle for "which record owned these atoms before the delete";
	 * its verdict is then materialized into ordinary replicated slice
	 * records that resolve under `false` on every replica.
	 */
	const resolveAnchor = (
		doc: EngineDoc,
		text: EngineNode,
		anchor: Anchor,
		followUndoneDeletions = false
	): number | null => {
		const itemId = (text._item as { id?: { client: number; clock: number } } | null)?.id;
		if (!itemId) return anchor.i === null ? (anchor.a < 0 ? 0 : text.length) : null;
		const rpos = Y.createRelativePositionFromJSON({
			type: { client: itemId.client, clock: itemId.clock },
			item: anchor.i === null ? null : { client: anchor.i.c, clock: anchor.i.k },
			assoc: anchor.a
		});
		const abs = Y.createAbsolutePositionFromRelativePosition(
			rpos,
			doc as unknown as YDoc,
			followUndoneDeletions
		);
		return abs === null ? null : abs.index;
	};

	/** Live index in `text` → stored anchor (`B`/`E` sentinels at the ends). */
	const anchorAt = (doc: EngineDoc, text: EngineNode, index: number): Anchor => {
		if (index <= 0) return { i: null, a: -1 };
		if (index >= text.length) return { i: null, a: 0 };
		const rpos = Y.createRelativePositionFromTypeIndex(text as unknown as YNode, index, 0);
		const json = Y.relativePositionToJSON(rpos) as {
			item?: { client: number; clock: number };
			assoc?: number;
		};
		return {
			i: json.item ? { c: json.item.client, k: json.item.clock } : null,
			a: json.assoc ?? 0
		};
	};

	/**
	 * Live index in `text` → caret anchor bound to the atom on the `assoc`
	 * side of the position (U09 selection anchors — distinct from the
	 * slice-record convention {@link anchorAt}, which uses index sentinels
	 * rather than affinity sentinels):
	 *
	 * - `assoc < 0` (LEFT affinity) binds the atom BEFORE `index`; the
	 *   position resolves right after it, so an insert exactly at `index`
	 *   lands to the caret's right — the caret does NOT absorb boundary
	 *   inserts. At `index <= 0` there is no left atom → `{i:null,a:-1}`
	 *   live-start sentinel (stays before prepends). At `index >= len` the
	 *   last atom is bound (resolves to `len` — does NOT follow appends).
	 * - `assoc >= 0` (RIGHT affinity) binds the atom AT `index`; the
	 *   position resolves right before it, so an insert at `index` lands
	 *   to the caret's left — a range START stays glued to the first
	 *   selected atom. At `index >= len` there is no right atom →
	 *   `{i:null,a:0}` live-end sentinel (follows appends). At `index <= 0`
	 *   of a non-empty text the first atom is bound.
	 *
	 * Binding to a tombstoned atom resolves to the gap where it lived —
	 * deleted content never resurrects and never displaces the anchor.
	 */
	const atomAnchorAt = (doc: EngineDoc, text: EngineNode, index: number, assoc: number): Anchor => {
		const len = text.length;
		const i = Math.max(0, Math.min(index, len));
		if (assoc < 0) {
			if (i === 0) return { i: null, a: -1 };
		} else if (i === len) {
			return { i: null, a: 0 };
		}
		const rpos = Y.createRelativePositionFromTypeIndex(text as unknown as YNode, i, assoc);
		const json = Y.relativePositionToJSON(rpos) as {
			item?: { client: number; clock: number };
			assoc?: number;
		};
		return {
			i: json.item ? { c: json.item.client, k: json.item.clock } : null,
			a: json.assoc ?? assoc
		};
	};

	/**
	 * Memoized anchor→`[i0, i1)` resolution of one slice record — the
	 * shared body behind `Ownership.resolvedRange` (a per-view `Map`) and
	 * the runs layer's maintained `rangeCache` (`WeakMap`). The CACHE
	 * lifetime is the caller's contract: a per-view map needs no
	 * invalidation (the view is a snapshot); a maintained cache must drop
	 * an entry when its text's items change (anchor positions shift).
	 */
	const sliceRange = (
		doc: EngineDoc,
		entry: SliceEntry,
		text: EngineNode,
		cache?: {
			has(e: SliceEntry): boolean;
			get(e: SliceEntry): readonly [number, number] | null | undefined;
			set(e: SliceEntry, v: readonly [number, number] | null): unknown;
		}
	): readonly [number, number] | null => {
		if (cache !== undefined && cache.has(entry)) return cache.get(entry)!;
		const rec = entry.payload as SliceRecord;
		const i0 = resolveAnchor(doc, text, rec.s);
		const i1 = resolveAnchor(doc, text, rec.e);
		const r = i0 === null || i1 === null ? null : ([Math.min(i0, i1), Math.max(i0, i1)] as const);
		cache?.set(entry, r);
		return r;
	};

	/**
	 * Build the ownership context over a collected block map.
	 * Pure — reads replicated state only; safe to call mid-transaction.
	 */
	const computeOwnership = (doc: EngineDoc, blocks: Map<BlockId, TextBlockRec>): Ownership => {
		const owners = computeOwners(blocks);
		const ownerOf = (b: BlockId): Owner => owners.get(b) ?? DEAD;
		const hidden = (b: BlockId): boolean => ownerOf(b) !== b;

		// Resolved ranges cache: entry identity → [i0, i1) | null.
		const rangeCache = new Map<SliceEntry, readonly [number, number] | null>();
		const resolve = (entry: SliceEntry, text: EngineNode) =>
			sliceRange(doc, entry, text, rangeCache);
		const resolvedRange = (entry: SliceEntry, text: EngineNode): [number, number] | null =>
			resolve(entry, text) as [number, number] | null;

		// Per-text per-atom winner: the live covering record with the best key
		// (generation, start, stamp) — see {@link claimKeyBetter}. Resolved
		// claims feed {@link sweepOwnership}, which produces disjoint
		// intervals keyed by the winning RECORD so two overlapping records
		// routing to the same owner still emit each atom exactly once
		// (concurrent splits at overlapping anchors produce exactly such
		// records). `maxG` records the highest generation seen covering each
		// text — materializing records bump it to win their own range — and
		// is tracked over EVERY slice record, including dead-held,
		// unresolvable, and never-winning ones (losing claims still raise
		// the generation bar) — hence the separate unfiltered pass.
		const byText = new Map<TextId, GatheredClaim[]>();
		const maxG = new Map<TextId, number>();
		for (const [, e] of eachSliceRecord(blocks)) {
			const p = e.payload as SliceRecord;
			const g = p.g ?? 0;
			if (g > (maxG.get(p.t) ?? 0)) maxG.set(p.t, g);
		}
		for (const c of gatherClaims(blocks, ownerOf, eachSliceRecord(blocks), resolve)) {
			let list = byText.get(c.t);
			if (!list) byText.set(c.t, (list = []));
			list.push(c);
		}
		const intervals = new Map<TextId, OwnInterval[]>();
		for (const [t, claims] of byText) {
			const ivs = sweepOwnership(claims);
			if (ivs.length > 0) intervals.set(t, ivs);
		}
		return { ownerOf, hidden, intervals, resolvedRange, maxG };
	};

	/**
	 * Flatten `b`'s displayed content into ordered owned segments.
	 * Merge claims recurse into the claimed list (cycle-safe); only atoms whose
	 * computed owner is exactly `b` are emitted — an ineffective claim (one
	 * that lost the list contest) silently contributes nothing.
	 *
	 * `track` (optional) reports every consulted `slices` list and record
	 * text — the maintained-runs layer's dependency capture
	 * (`flattenTracked` in `text/runs.ts`) runs THIS walk over its own
	 * `Ownership` shim rather than duplicating it.
	 */
	const flatten = (
		b: BlockId,
		blocks: Map<BlockId, TextBlockRec>,
		own: Ownership,
		track?: FlattenTrack
	): OwnedSeg[] => {
		const segs: OwnedSeg[] = [];
		const emitRecord = (entry: SliceEntry, holder: BlockId, via: SliceEntry) => {
			const rec = entry.payload as SliceRecord;
			track?.text?.(rec.t);
			const textRec = blocks.get(rec.t);
			if (!textRec || !textRec.content) return;
			const range = own.resolvedRange(entry, textRec.content);
			if (range === null) return;
			// Emit only atoms this RECORD wins — a losing overlapping record
			// contributes nothing even when it routes to the same owner
			// (otherwise concurrent splits would double-display the overlap).
			// Intervals are disjoint and per-winning-record, so each matching
			// interval inside the record's resolved range is one seg.
			for (const iv of intervalsOver(own.intervals.get(rec.t), range[0], range[1])) {
				if (iv.claim === entry && iv.owner === b) {
					segs.push({
						t: rec.t,
						i0: Math.max(iv.i0, range[0]),
						i1: Math.min(iv.i1, range[1]),
						holder,
						seqIndex: entry.seqIndex,
						via
					});
				}
			}
		};
		const walk = (listId: BlockId, seen: Set<BlockId>, via: SliceEntry | null) => {
			if (seen.has(listId)) return;
			seen.add(listId);
			const rec = blocks.get(listId);
			track?.list?.(listId, rec?.entries);
			if (!rec) return;
			for (const entry of rec.entries) {
				if (isSliceRecord(entry.payload)) emitRecord(entry, listId, via ?? entry);
				else if (isMergeClaim(entry.payload)) walk(entry.payload.m, seen, via ?? entry);
			}
		};
		walk(b, new Set(), null);
		return segs;
	};

	/** Total displayed-atom count of a block. */
	const ownedLength = (segs: OwnedSeg[]): number => segs.reduce((n, s) => n + (s.i1 - s.i0), 0);

	// ── atom reading (payload + marks) ─────────────────────────────────

	/**
	 * Open a native bounded read cursor on `text` — the vendored
	 * `Y.RangeCursor` (U3). Positions are rendered length (countable,
	 * non-deleted units under the node's active renderer); the cursor seeds
	 * itself from the engine's search-marker checkpoints, so opening is
	 * O(1) and the first read pays only its checkpoint gap plus the range.
	 * Detached nodes (`doc === null`) read as empty — identical to the old
	 * guard.
	 */
	const openRangeCursor = (text: EngineNode): RangeCursor =>
		new Y.RangeCursor(text as unknown as YNode) as unknown as RangeCursor;

	/**
	 * Read atoms `[i0, i1)` of `text` into ContentItems (text runs grouped by
	 * identical marks; inline atoms as `{kind:'inline'}`).
	 *
	 * U3: a fresh native cursor visits the checkpoint gap plus the items
	 * overlapping the range instead of materializing the whole backing text
	 * through `toDelta().toJSON()` on every call. Mid-transaction safe for
	 * the same reason `toDelta()` was: uncommitted items are already linked
	 * into `_start`.
	 */
	const itemsOfRange = (text: EngineNode, i0: number, i1: number): RangeItem[] =>
		readRange(openRangeCursor(text), i0, i1);

	/** The block's canonical `ContentItem[]` (text runs + inline atoms). */
	const contentItemsOf = (
		b: BlockId,
		blocks: Map<BlockId, TextBlockRec>,
		own: Ownership
	): unknown[] => {
		const out: unknown[] = [];
		// One native cursor per backing text — adjacent segs of the same
		// text share the format-state walk instead of re-seeking per slice.
		const cursors = new Map<TextId, RangeCursor>();
		for (const seg of flatten(b, blocks, own)) {
			const text = blocks.get(seg.t)?.content;
			if (!text) continue;
			let cur = cursors.get(seg.t);
			if (cur === undefined) cursors.set(seg.t, (cur = openRangeCursor(text)));
			for (const it of readRange(cur, seg.i0, seg.i1)) out.push(it);
		}
		return out;
	};

	/** Flat text of a block (inline atoms contribute ''). */
	const blockTextOf = (b: BlockId, blocks: Map<BlockId, TextBlockRec>, own: Ownership): string => {
		let s = '';
		for (const item of contentItemsOf(b, blocks, own)) {
			const i = item as { kind: string; text?: string };
			if (i.kind === 'text') s += i.text;
		}
		return s;
	};

	// ── writes (must run inside doc.transact) ──────────────────────────

	/**
	 * The winner of the per-atom claim contest at `pos` of `text` —
	 * evaluated with POST-insert anchor resolution (call after the atoms
	 * are inserted). Every pre-existing record's resolved range either
	 * covers the whole freshly inserted run or none of it: no anchor binds
	 * inside the run (records only reference atoms that existed when they
	 * were written), so a single point decides the entire run's owner.
	 * Returns whether the winning record's holder routes to `b` — when it
	 * does not, a foreign record claims the typed atoms and they display
	 * under a rival block (the gate-F1 steal shape). The caller then
	 * writes a claim record on `b`'s own list covering exactly the new
	 * atoms; `maxG + 1` and a fresh stamp beat every pre-existing record.
	 */
	const claimRoutesToB = (
		doc: EngineDoc,
		blocks: Map<BlockId, TextBlockRec>,
		own: Ownership,
		b: BlockId,
		t: TextId,
		text: EngineNode,
		pos: number
	): boolean => {
		// Resolve FRESH — never through `own.resolvedRange`: the caller has
		// just inserted atoms the view's range cache cannot know about.
		const freshRange = (entry: SliceEntry, tx: EngineNode): readonly [number, number] | null => {
			const p = entry.payload as SliceRecord;
			const i0 = resolveAnchor(doc, tx, p.s);
			const i1 = resolveAnchor(doc, tx, p.e);
			return i0 === null || i1 === null ? null : [Math.min(i0, i1), Math.max(i0, i1)];
		};
		let winKey: ClaimKey | null = null;
		let routesToB = false;
		for (const c of gatherClaims(blocks, own.ownerOf, eachSliceRecord(blocks), freshRange, { t })) {
			if (pos < c.lo || pos >= c.hi) continue;
			if (claimKeyBetter(c.key, winKey)) {
				winKey = c.key;
				routesToB = c.owner === b;
			}
		}
		return routesToB;
	};

	/**
	 * R3 — the slice records to write after an undo resurrected deleted
	 * atoms in backing text `t`.
	 *
	 * The vendored UndoManager recreates deleted atoms as NEW items (the
	 * tombstones gain a LOCAL `redone` pointer to their copies). Existing
	 * slice records anchored to the tombstones then resolve PAST the copies
	 * (`followUndoneDeletions=false` — the convergent resolution), so the
	 * resurrected atoms get swallowed by whichever record's other end still
	 * covers them — the classic R3 shape: a split-off tail's deleted text
	 * comes back inside the source paragraph.
	 *
	 * This function re-runs the claim contest with
	 * `followUndoneDeletions=true` — the "as if the deletion never
	 * happened" view the undoing replica alone can compute — and diffs it
	 * against the normal-resolution winner at every resurrected position:
	 *
	 * - Same winning record → the atoms already emit under the record that
	 *   displayed them pre-delete → nothing to write (the common
	 *   single-block undo therefore produces ZERO extra state).
	 * - Different winner (or none) → the atoms' pre-delete claim is
	 *   re-asserted: a fresh `{t, s, e, g: maxG+1}` record on the SAME
	 *   holder's `slices` list, inserted at the winning entry's live
	 *   `seqIndex` so the copies emit at the exact display slot they
	 *   occupied before the delete. The fresh generation outranks every
	 *   record that currently wins them; the bound COPY atoms keep the
	 *   claim exact — foreign atoms inserted between delete and undo are
	 *   never covered (they sit outside the copy spans, or split the
	 *   spans into per-winner pieces).
	 * - No redone-space winner (the pre-delete holder is dead/hidden) → no
	 *   claim: the atoms surface under whatever record already covers
	 *   them — the documented dead-owner fallback.
	 *
	 * The `redone` traversal is a LOCAL-ONLY oracle: the emitted records
	 * are ordinary replicated slice state, so receivers and reloaded
	 * clients derive the identical ownership without any redone knowledge.
	 *
	 * `spans` = the `[i0,i1)` atom ranges of `text` the undo transaction
	 * resurrected (from the transaction's `insertSet`). Returns
	 * holder → (seqIndex → records, position-ordered) groups; the caller
	 * inserts each group at `seqIndex` in DESCENDING index order.
	 *
	 * `freshClaim` (optional) marks record-entry ids minted NON-resurrected
	 * in the same transaction — writes made alongside the undo (e.g. an
	 * edge-anchored record rewrite, which can widen an `e` anchor to the
	 * live end). Such records did not exist before the resurrection, so
	 * they cannot witness pre-delete ownership and are excluded from the
	 * redone-space contest; they still participate in the normal-resolution
	 * winner (`own`), so a fresh claim that legitimately covers the atoms
	 * keeps them. Records RESURRECTED by this transaction (copies with a
	 * `redone` source) are NOT marked — they are the restored pre-delete
	 * claims.
	 */
	const undoRepairClaims = (
		doc: EngineDoc,
		blocks: Map<BlockId, TextBlockRec>,
		own: Ownership,
		t: TextId,
		text: EngineNode,
		spans: { i0: number; i1: number }[],
		freshClaim?: (client: number, clock: number) => boolean
	): Map<BlockId, Map<number, SliceRecord[]>> => {
		const out = new Map<BlockId, Map<number, SliceRecord[]>>();
		if (spans.length === 0) return out;
		// The redone-space claim set: every live holder's records over `t`,
		// anchors resolved through the local redone chain
		// (`followUndoneDeletions = true` — the replica-dependent oracle;
		// see {@link resolveAnchor}).
		const redoneRange = (entry: SliceEntry, tx: EngineNode): readonly [number, number] | null => {
			const p = entry.payload as SliceRecord;
			const i0 = resolveAnchor(doc, tx, p.s, true);
			const i1 = resolveAnchor(doc, tx, p.e, true);
			return i0 === null || i1 === null ? null : [Math.min(i0, i1), Math.max(i0, i1)];
		};
		const redClaims = gatherClaims(blocks, own.ownerOf, eachSliceRecord(blocks), redoneRange, {
			t,
			skip: freshClaim === undefined ? undefined : (e) => freshClaim(e.stamp.c, e.stamp.k)
		});
		if (redClaims.length === 0) return out;
		const redIvs = sweepOwnership(redClaims);
		const holderOf = new Map<SliceEntry, BlockId>();
		for (const c of redClaims) holderOf.set(c.entry, c.holder);
		const normIvs = own.intervals.get(t) ?? [];
		const g = (own.maxG.get(t) ?? 0) + 1;
		// Pending (holder → seqIndex → last emitted span): adjacent
		// elementary intervals won by the same entry coalesce into one
		// record (and adjacent copy spans merge the same way). The lookup is
		// a NESTED map — the `(holder, seqIndex)` pair is the real key; the
		// old flat `${holder}${seqIndex}` string was not injective (e.g.
		// ('x', 10) and ('x1', 0) both encode 'x10'), so one holder's open
		// span could extend a DIFFERENT claim's pending record — the merged
		// record then landed on the wrong list, stealing the resurrected
		// atoms (D6).
		const pending = new Map<BlockId, Map<number, { i0: number; i1: number }>>();
		const ordered: { holder: BlockId; seqIndex: number; i0: number; i1: number }[] = [];
		for (const span of spans.slice().sort((a, b) => a.i0 - b.i0)) {
			// The winner can only change at a claim edge or a span edge —
			// elementary intervals between consecutive boundary points each
			// get one winner under each resolution.
			const pts = new Set<number>([span.i0, span.i1]);
			const clip = (ivs: OwnInterval[]): void => {
				for (const iv of ivs) {
					if (iv.i0 >= span.i1 || iv.i1 <= span.i0) continue;
					pts.add(Math.max(iv.i0, span.i0));
					pts.add(Math.min(iv.i1, span.i1));
				}
			};
			clip(redIvs);
			clip(normIvs);
			const xs = [...pts].sort((a, b) => a - b);
			for (let i = 0; i + 1 < xs.length; i++) {
				const x = xs[i];
				const y = xs[i + 1];
				const rw = intervalAt(redIvs, x);
				if (rw === undefined) continue; // no pre-delete owner → dead-owner fallback
				if (rw.claim === intervalAt(normIvs, x)?.claim) continue; // already attributed correctly
				const holder = holderOf.get(rw.claim);
				if (holder === undefined) continue;
				const seqIndex = rw.claim.seqIndex;
				const last = pending.get(holder)?.get(seqIndex);
				if (last !== undefined && last.i1 === x) {
					last.i1 = y;
				} else {
					const next = { holder, seqIndex, i0: x, i1: y };
					let bySeq = pending.get(holder);
					if (bySeq === undefined) pending.set(holder, (bySeq = new Map()));
					bySeq.set(seqIndex, next);
					ordered.push(next);
				}
			}
		}
		for (const s of ordered) {
			let groups = out.get(s.holder);
			if (groups === undefined) out.set(s.holder, (groups = new Map()));
			let list = groups.get(s.seqIndex);
			if (list === undefined) groups.set(s.seqIndex, (list = []));
			list.push({
				t,
				s: anchorAt(doc, text, s.i0),
				e: anchorAt(doc, text, s.i1),
				g
			});
		}
		return out;
	};

	/**
	 * Insert `text` (with optional marks) at displayed offset `offset` of
	 * block `b`. Boundary rule: an insert at a slice's right edge belongs to
	 * that slice (end anchors include inserts to their left); an insert at a
	 * slice's LEFT edge belongs to it too — implemented by extending the
	 * covering record's start anchor to the newly inserted atoms (the record
	 * is deleted+reinserted, so its fresh stamp wins the edge contest).
	 */
	const insertIntoText = (
		doc: EngineDoc,
		blocks: Map<BlockId, TextBlockRec>,
		own: Ownership,
		b: BlockId,
		offset: number,
		payload: string | EngineNode,
		marks?: Record<string, unknown>
	): boolean => {
		// Clone caller marks ONCE at the boundary: `text.insert` keeps the
		// format object by reference, so a caller-held marks payload would
		// alias straight into replicated state (gate-2 finding 11).
		// `sanitizeWireJson` normalizes lone surrogates to U+FFFD at the same
		// boundary — the wire's UTF-8 encoder would otherwise deliver a
		// different string to every receiving replica (F2-M1).
		if (marks !== undefined) marks = sanitizeWireJson(marks);
		// Text payloads normalize the same way — verbatim lone surrogates
		// are not wire-idempotent; U+FFFD is what the wire delivers.
		if (typeof payload === 'string') payload = sanitizeWireString(payload);
		const rec = blocks.get(b);
		if (!rec) return false;
		// Empty payload: resolve the block (above) but skip every write
		// branch — an `''` insert would otherwise rewrite the covering
		// slice record at a bumped generation (a real ~40–60B update on a
		// semantic no-op) or pin a `revive` record claiming [tLen, E) with
		// nothing appended.
		if (payload === '') return true;
		const segs = flatten(b, blocks, own);
		const total = ownedLength(segs);
		const at = Math.max(0, Math.min(offset, total));
		// Locate the covering segment: offset strictly inside, or at the right
		// edge of a segment (left-wins boundary rule) — but NOT at the left edge
		// of a later segment, which prefers the earlier segment's right edge.
		let base = 0;
		let segIdx = -1;
		for (let i = 0; i < segs.length; i++) {
			const len = segs[i].i1 - segs[i].i0;
			if (at < base + len || i === segs.length - 1) {
				segIdx = i;
				break;
			}
			base += len;
		}
		if (segIdx < 0 || segs.length === 0) {
			// Empty display: revive coverage on the block's own backing text so
			// future inserts have a home. The record covers [len(T_b), ∞) — it
			// must NOT swallow atoms another block already owns, so the start
			// anchor is pinned at the current text end. Skip it only when the
			// append point is already owned by THIS block — see below.
			const ownText = rec.content;
			if (!ownText || !rec.slicesNode) return false;
			const tLen = ownText.length;
			// The appended atoms occupy [tLen, tLen+len) of T_b. The only
			// records that can claim them are END-sentinel records
			// (`e:{i:null,a>=0}` resolves to the live end — an item-anchored
			// end resolves to a fixed boundary ≤ tLen) whose start resolves
			// at/before tLen (an END-sentinel START chases the live end and
			// can never cover appends). Coverage EXISTENCE on b's own list is
			// not enough — the winner is the best (g, resolved-start, stamp)
			// key across ALL holders, the same per-atom contest
			// computeOwnership runs ({@link claimRoutesToB}). A losing record
			// on b's own list still covers the point while a rival's
			// higher-generation record claims the typed atoms — gate-F1
			// defect: typing into the emptied block appended to the rival's
			// display. The revive record is skipped only when the append
			// winner routes to `b` (its own {B,E} slice auto-extends — e.g.
			// the canonical empty block — or a claimed sibling list's record
			// wins it back to b).
			// Insert FIRST, then judge coverage and write the revive record:
			// its start must bind the FIRST appended atom, which only exists
			// after the insert. Anchoring before the insert resolves
			// `anchorAt(tLen)` against the pre-insert text — `tLen === len`
			// yields the dynamic END sentinel, which then advances past the
			// appended atoms and the record claims nothing (the tail's {B,E}
			// record displayed them instead — defect B). `anchorAt(tLen)` on
			// the post-insert text binds the atom now at `tLen`, so the
			// record covers [tLen, E).
			if (typeof payload === 'string') ownText.insert(tLen, payload, marks);
			else ownText.insert(tLen, [payload]);
			if (!claimRoutesToB(doc, blocks, own, b, b, ownText, tLen)) {
				const revive: SliceRecord = {
					t: b,
					s: anchorAt(doc, ownText, tLen),
					e: { i: null, a: 0 },
					// Bump the generation so the appended atoms — which an
					// end-sentinel record on another block's list may already
					// cover — display under this block deterministically:
					// `maxG + 1` outranks every record that covered the text
					// before it, including the rival that won the contest
					// above. The record claims ONLY the appended range
					// ([tLen, E)) — the rival keeps its owned range.
					g: (own.maxG.get(b) ?? 0) + 1
				};
				rec.slicesNode.insert(rec.slicesNode.length, [revive]);
			}
			return true;
		}
		const seg = segs[segIdx];
		const text = blocks.get(seg.t)?.content;
		if (!text) return false;
		const inner = at - base;
		if (inner === 0) {
			// Left edge of the covering segment.
			const record = blocks.get(seg.holder)?.entries[seg.seqIndex]?.payload as
				| SliceRecord
				| undefined;
			const insertAt = seg.i0;
			// Re-anchor the covering record to claim the new atoms: even a
			// begin-sentinel start does not guarantee ownership — a rival
			// record ending exactly at `insertAt` covers the prepended atoms
			// too and wins the contest whenever its key beats this record's
			// (it already beat it on the neighbouring atoms). The rewrite
			// bumps the generation so the record wins the edge atoms
			// deterministically — a neighbouring record's end anchor also
			// covers them, and at equal generation the fresh item stamp
			// would lose to a higher-client concurrent record.
			const n = typeof payload === 'string' ? payload.length : 1;
			if (typeof payload === 'string') text.insert(insertAt, payload, marks);
			else text.insert(insertAt, [payload]);
			if (record) {
				const holderSlices = blocks.get(seg.holder)?.slicesNode;
				if (holderSlices) {
					// Re-assert the record's ACTUAL coverage — never its
					// original `{s,e}` range. The record may own several
					// disjoint segs: a rival record can win a hole inside its
					// claimed range (concurrent splits, contested partitions).
					// Rewriting one record `{insertAt, record.e}` under the
					// bumped generation re-claims — and steals — those lost
					// atoms (defect A: early's rewritten {3,E} re-claimed the
					// atoms late had won, emptying late's display). Emit one
					// record per covered seg instead: the typed-into seg
					// extends left over the new atoms; segs after the insert
					// point shift by `n`; earlier segs re-anchor unchanged.
					const g = (own.maxG.get(seg.t) ?? 0) + 1;
					const rewritten: SliceRecord[] = [];
					for (const s of segs) {
						if (s.holder !== seg.holder || s.seqIndex !== seg.seqIndex) continue;
						if (s === seg) {
							// The typed-into seg: its new start binds the first
							// inserted atom so a neighbour's boundary anchor
							// cannot peel the edge back; its end follows the
							// seg's atoms, shifted by `n`.
							rewritten.push({
								t: s.t,
								s: anchorAt(doc, text, insertAt),
								e: anchorAt(doc, text, s.i1 + n),
								g
							});
						} else if (s.i0 >= insertAt) {
							// Later coverage of the same record — the atoms
							// moved right by `n`; re-anchor on them.
							rewritten.push({
								t: s.t,
								s: anchorAt(doc, text, s.i0 + n),
								e: anchorAt(doc, text, s.i1 + n),
								g
							});
						} else {
							// Coverage entirely before the insert point —
							// indices unchanged; re-anchor on the same atoms.
							rewritten.push({
								t: s.t,
								s: anchorAt(doc, text, s.i0),
								e: anchorAt(doc, text, s.i1),
								g
							});
						}
					}
					holderSlices.delete(seg.seqIndex, 1);
					holderSlices.insert(seg.seqIndex, rewritten);
				}
			}
			return true;
		}
		const insertAt = seg.i0 + inner;
		const n = typeof payload === 'string' ? payload.length : 1;
		if (typeof payload === 'string') text.insert(insertAt, payload, marks);
		else text.insert(insertAt, [payload]);
		if (inner === seg.i1 - seg.i0) {
			// Right edge of the LAST displayed segment (append at the end of
			// the display). The covering record's end may stop exactly here
			// while a rival's claim covers the append point — a bare insert
			// lets the rival claim the typed atoms and display them under
			// ITS block (gate-F1 seed-20: typing at the end of a partially
			// claimed block prepended the text to the rival's display).
			// When the post-insert winner does not route to `b`, claim the
			// new atoms on b's own list — appended last so they emit at the
			// display end, where the user typed them.
			if (rec.slicesNode && !claimRoutesToB(doc, blocks, own, b, seg.t, text, insertAt)) {
				const claim: SliceRecord = {
					t: seg.t,
					s: anchorAt(doc, text, insertAt),
					e: anchorAt(doc, text, insertAt + n),
					g: (own.maxG.get(seg.t) ?? 0) + 1
				};
				rec.slicesNode.insert(rec.slicesNode.length, [claim]);
			}
		}
		return true;
	};

	/**
	 * Delete `length` displayed atoms starting at `offset` — resolves each
	 * owned segment's backing-text span and deletes in that backing text.
	 *
	 * Backing coordinates are resolved ONCE from the pre-delete snapshot,
	 * every span is validated BEFORE any mutation runs, and each backing
	 * text's spans execute RIGHT-TO-LEFT (descending `i0`). Positional
	 * deletes evaluate against the live item list — tombstoned atoms stop
	 * counting immediately — so deleting an earlier span shifts every atom
	 * after it left and a later span of the SAME text addressed by stale
	 * coordinates would hit atoms that shifted into its recorded range
	 * (rival-owned content) or run off the end and throw
	 * `Exceeded content range` mid-loop — and a throw inside `transact`
	 * does not roll back the deletes already applied (gate-F2 F2-B1:
	 * convergent partial-delete corruption). Deleting right-to-left keeps
	 * every recorded coordinate live until its own turn: a landed delete
	 * can only shift atoms AFTER the remaining spans.
	 *
	 * Atomic-safety: spans of one text are pairwise disjoint (ownership
	 * intervals are disjoint), so after the two validation passes — every
	 * span in range AND non-overlapping — no `text.delete` can throw:
	 * each span's atoms are still at their recorded positions when its
	 * turn comes. A failed check returns BEFORE the first mutation, so a
	 * refused delete can never strand half-applied.
	 */
	const deleteRange = (
		doc: EngineDoc,
		blocks: Map<BlockId, TextBlockRec>,
		own: Ownership,
		b: BlockId,
		offset: number,
		length: number
	): boolean => {
		void doc;
		const segs = flatten(b, blocks, own);
		const total = ownedLength(segs);
		const at = Math.max(0, Math.min(offset, total));
		const end = Math.min(total, at + Math.max(0, length));
		if (end <= at) return true;
		type Span = { text: EngineNode; i0: number; len: number };
		const byText = new Map<TextId, Span[]>();
		let base = 0;
		for (const seg of segs) {
			const len = seg.i1 - seg.i0;
			const lo = Math.max(at, base);
			const hi = Math.min(end, base + len);
			if (lo < hi) {
				const text = blocks.get(seg.t)?.content;
				const i0 = seg.i0 + (lo - base);
				const spanLen = hi - lo;
				// Validation pass 1 — every span resolvable and in range
				// against the pre-delete live length.
				if (!text || i0 < 0 || i0 + spanLen > text.length) return false;
				let spans = byText.get(seg.t);
				if (spans === undefined) byText.set(seg.t, (spans = []));
				spans.push({ text, i0, len: spanLen });
			}
			base += len;
			if (base >= end) break;
		}
		// Validation pass 2 — each text's spans in descending order must be
		// pairwise disjoint. The interval contract guarantees it; the check
		// turns a would-be silent coordinate corruption into a clean refusal
		// (still before any mutation).
		const ordered: Span[] = [];
		for (const spans of byText.values()) {
			spans.sort((x, y) => y.i0 - x.i0);
			for (let k = 1; k < spans.length; k++) {
				if (spans[k].i0 + spans[k].len > spans[k - 1].i0) return false;
			}
			ordered.push(...spans);
		}
		for (const s of ordered) s.text.delete(s.i0, s.len);
		return true;
	};

	/** Format `length` displayed atoms starting at `offset`. */
	const formatRangeIn = (
		doc: EngineDoc,
		blocks: Map<BlockId, TextBlockRec>,
		own: Ownership,
		b: BlockId,
		offset: number,
		length: number,
		formats: Record<string, unknown>
	): boolean => {
		void doc;
		// Clone caller formats ONCE — `text.format` stores them by reference
		// (gate-2 finding 11; covers setMark's `{[name]: value}` payloads too).
		// `sanitizeWireJson` also normalizes lone surrogates in mark names and
		// string values to U+FFFD — the wire's UTF-8 encode would otherwise
		// deliver a different format payload to every receiving replica (F2-M1).
		formats = sanitizeWireJson(formats);
		const segs = flatten(b, blocks, own);
		const total = ownedLength(segs);
		const at = Math.max(0, Math.min(offset, total));
		const end = Math.min(total, at + Math.max(0, length));
		if (end <= at) return false;
		let base = 0;
		for (const seg of segs) {
			const len = seg.i1 - seg.i0;
			const lo = Math.max(at, base);
			const hi = Math.min(end, base + len);
			if (lo < hi) {
				const text = blocks.get(seg.t)?.content;
				if (!text) return false;
				text.format(seg.i0 + (lo - base), hi - lo, formats);
			}
			base += len;
			if (base >= end) break;
		}
		return true;
	};

	/**
	 * Materialize `segs` (all owned by `b`) into anchored slice records — used
	 * for tail coverage that must be re-expressed on the sibling's list.
	 * Emitting per-seg (never the covering record's full range) guarantees the
	 * new records claim exactly the atoms `b` owned: contested atoms lost to
	 * other records are not re-stolen by the fresh stamps.
	 */
	const materializeSegs = (
		doc: EngineDoc,
		blocks: Map<BlockId, TextBlockRec>,
		own: Ownership,
		segs: OwnedSeg[]
	): SliceRecord[] => {
		const out: SliceRecord[] = [];
		for (const seg of segs) {
			const text = blocks.get(seg.t)?.content;
			if (!text) continue;
			out.push({
				t: seg.t,
				s: anchorAt(doc, text, seg.i0),
				e: anchorAt(doc, text, seg.i1),
				g: (own.maxG.get(seg.t) ?? 0) + 1
			});
		}
		return out;
	};

	/**
	 * Split `b`'s slice list at displayed `offset`. The list is partitioned at
	 * ENTRY granularity — claims are never silently flattened:
	 *
	 * - entries whose contributed atoms lie entirely before `offset` stay on
	 *   `b`'s list VERBATIM (original items — same stamps, zero churn);
	 * - entries entirely after move to the sibling — slice records are
	 *   materialized per owned segment (exact atoms, same anchors), merge
	 *   claims transfer wholesale (`{m:X}` on the sibling's list makes X's
	 *   owner the sibling);
	 * - a slice record CUT by the seam is materialized into head/tail parts;
	 * - a merge claim CUT by the seam stays on the head (the claimed block
	 *   remains hidden under `b`); the tail atoms it contributed are
	 *   materialized as records on the sibling — they win their range because
	 *   `g = maxG + 1` outranks the claimed list's own records (which route to
	 *   `b` through the retained claim) at any claim depth.
	 *
	 * Entries contributing zero atoms (fully contested away) side with the
	 * seam position: at/before it → head, after → tail.
	 */
	const splitSlices = (
		doc: EngineDoc,
		blocks: Map<BlockId, TextBlockRec>,
		own: Ownership,
		b: BlockId,
		offset: number
	): { tail: SlicePayload[] } | null => {
		const rec = blocks.get(b);
		if (!rec || !rec.slicesNode) return null;
		const segs = flatten(b, blocks, own);
		const total = ownedLength(segs);
		const at = Math.max(0, Math.min(offset, total));
		// Group the display segs by the top-level list entry they entered
		// through (via). Segs are emitted in list order, so each entry's
		// contribution occupies one contiguous display span.
		const byEntry = new Map<SliceEntry, OwnedSeg[]>();
		for (const seg of segs) {
			const arr = byEntry.get(seg.via) ?? [];
			arr.push(seg);
			byEntry.set(seg.via, arr);
		}
		// Plan: per-entry action.
		type Action =
			| { kind: 'keep' } // stays on b's list untouched
			| { kind: 'move'; entry: SliceEntry } // re-expressed on sibling
			| { kind: 'cutRecord'; entry: SliceEntry; headRecs: SliceRecord[]; tailRecs: SliceRecord[] }
			| { kind: 'cutClaim'; entry: SliceEntry; tailRecs: SliceRecord[] };
		const actions: Action[] = [];
		const tail: SlicePayload[] = [];
		let cursor = 0;
		for (const entry of rec.entries) {
			const contrib = byEntry.get(entry) ?? [];
			const count = contrib.reduce((n, s) => n + (s.i1 - s.i0), 0);
			const start = cursor;
			const end = cursor + count;
			cursor = end;
			if (end <= at) {
				actions.push({ kind: 'keep' });
				continue;
			}
			if (start >= at) {
				// Entirely in the tail. Claims transfer verbatim — {m:X} on
				// the sibling makes X's owner the sibling and keeps the live
				// claim intact. Records materialize to exactly the atoms they
				// won: re-writing the full original range under a fresh stamp
				// could steal back atoms a competing record currently owns.
				// A record that won nothing is simply dropped — the original
				// item is tombstoned (undo-restorable) and keeping it verbatim
				// would re-assert its full range under a fresh stamp.
				actions.push({ kind: 'move', entry });
				if (isSliceRecord(entry.payload)) {
					tail.push(...materializeSegs(doc, blocks, own, contrib));
				} else {
					tail.push(entry.payload);
				}
				continue;
			}
			// The seam cuts inside this entry's contributed span.
			if (isSliceRecord(entry.payload)) {
				const headSegs: OwnedSeg[] = [];
				const tailSegs: OwnedSeg[] = [];
				let c = start;
				for (const seg of contrib) {
					const len = seg.i1 - seg.i0;
					const lo = Math.max(0, at - c);
					const hi = Math.min(len, at - c);
					if (lo > 0) headSegs.push({ ...seg, i1: seg.i0 + lo });
					if (hi < len) tailSegs.push({ ...seg, i0: seg.i0 + hi });
					c += len;
				}
				const headRecs = materializeSegs(doc, blocks, own, headSegs);
				const tailRecs = materializeSegs(doc, blocks, own, tailSegs);
				actions.push({ kind: 'cutRecord', entry, headRecs, tailRecs });
				tail.push(...tailRecs);
			} else {
				// Cut merge claim: the claim stays on the head (the claimed
				// block keeps hiding under `b`); only the atoms BEYOND the seam
				// materialize onto the sibling's list.
				const tailSegs: OwnedSeg[] = [];
				let c = start;
				for (const seg of contrib) {
					const len = seg.i1 - seg.i0;
					const hi = Math.min(len, at - c);
					if (hi < len) tailSegs.push({ ...seg, i0: seg.i0 + Math.max(0, hi) });
					c += len;
				}
				const tailRecs = materializeSegs(doc, blocks, own, tailSegs);
				actions.push({ kind: 'cutClaim', entry, tailRecs });
				tail.push(...tailRecs);
			}
		}
		// Apply, in DESCENDING live seqIndex so earlier edits don't shift later
		// targets. 'keep' and 'cutClaim' entries are untouched (the claim item
		// itself stays in place on the head).
		for (let i = actions.length - 1; i >= 0; i--) {
			const a = actions[i];
			if (a.kind === 'keep' || a.kind === 'cutClaim') continue;
			const idx = a.entry.seqIndex;
			if (a.kind === 'move') {
				rec.slicesNode.delete(idx, 1);
			} else {
				// cutRecord: replace the item with its head materialization.
				rec.slicesNode.delete(idx, 1);
				if (a.headRecs.length > 0) rec.slicesNode.insert(idx, a.headRecs);
			}
		}
		return { tail };
	};

	/** Append a merge claim `{m: from}` to `into`'s slices list. */
	const claimInto = (blocks: Map<BlockId, TextBlockRec>, from: BlockId, into: BlockId): boolean => {
		const intoRec = blocks.get(into);
		if (!intoRec?.slicesNode) return false;
		intoRec.slicesNode.insert(intoRec.slicesNode.length, [{ m: from } satisfies MergeClaim]);
		return true;
	};

	return {
		newNode,
		resolveAnchor,
		anchorAt,
		atomAnchorAt,
		readSliceEntries,
		sliceRange,
		computeOwnership,
		flatten,
		ownedLength,
		openRangeCursor,
		itemsOfRange,
		contentItemsOf,
		blockTextOf,
		insertIntoText,
		deleteRange,
		formatRangeIn,
		splitSlices,
		claimInto,
		undoRepairClaims
	};
};

export type TextEngine = ReturnType<typeof bindText>;
