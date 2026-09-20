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
 * - `owner(b)` — the block that displays `b`'s slice list: `del` → 'dead';
 *   otherwise follow the max-stamp merge claim on `b`'s list; unclaimed → `b`
 *   itself. Cycles (concurrent `A→B` / `B→A` merges) resolve to the claimer
 *   of the max-stamp claim edge inside the cycle.
 * - `hidden(b)` ⟺ `owner(b) !== b` — merged-away blocks have no display.
 * - Atom `i` of text `t` is displayed by the live slice record covering it
 *   with the best key `(g, stamp)` — generation first (a later split's
 *   materialized records outrank the coverage they replace, through any
 *   claim depth), then the claim item's `(client, clock)` stamp for truly
 *   concurrent overlaps. The candidate block is `owner(holderOf(record))`,
 *   so a merged block's records route to its owner automatically.
 *
 * Engine notes: slice entries are `ContentAny` objects; their item id
 * `(client, clock + offset-in-item)` is the claim stamp. Anchors use the
 * vendored relative-position machinery with `followUndoneDeletions = false`
 * for replica-independent resolution.
 */
import type {
	EngineApi,
	EngineDoc,
	EngineItemRef,
	EngineNode,
	YDoc,
	YNode
} from '../engine-api.js';
import { cloneJson } from '../../utils/json.js';

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
	/** Item covering this entry (internal — for stamp offsetting). */
	item: EngineItemRef;
};

/** Structural item for sequence walks (`node._start`). */
export type SeqItem = {
	id: { client: number; clock: number };
	length: number;
	deleted: boolean;
	right: SeqItem | null;
	content: { getContent(): unknown[]; isCountable?(): boolean };
};

const nodeStart = (node: EngineNode): SeqItem | null =>
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
					seqIndex,
					item: { id: { client: it.id.client, clock: it.id.clock + j } }
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

export const DEAD = 'dead' as const;
export type Owner = BlockId | typeof DEAD;

/**
 * `owner(b)` — the block that displays `b`'s slice list.
 *
 * - unknown / `del`-flagged → 'dead'
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
 * Bound context the ownership engine works over — one pass over the registry.
 * `atomOwner.get(t)[i]` = the block displaying atom `i` of text `t`
 * (`undefined` = dead/unclaimed). `atomClaim.get(t)[i]` = the winning slice
 * RECORD for that atom — ownership is per-record, not per-holder, so two
 * overlapping records routing to the same block cannot double-emit an atom
 * (concurrent splits at overlapping anchors produce exactly such records).
 */
export type Ownership = {
	ownerOf: (b: BlockId) => Owner;
	hidden: (b: BlockId) => boolean;
	/** Per-text atom→owner map. Texts only appear when a record covers them. */
	atomOwner: Map<TextId, (BlockId | undefined)[]>;
	/** Per-text atom→winning-record map (parallel to `atomOwner`). */
	atomClaim: Map<TextId, (SliceEntry | undefined)[]>;
	/** Resolved (anchor → index) view used to build `atomOwner` — reused by
	 *  flatten so ops never resolve the same anchor twice. */
	resolvedRange: (entry: SliceEntry, text: EngineNode) => [number, number] | null;
	/** Highest generation `g` of any record covering each text — rewrites
	 *  write `maxG + 1` to deterministically win their range. */
	maxG: Map<TextId, number>;
};

export const bindText = (Y: EngineApi) => {
	const newNode = (name: string): EngineNode => new Y.Node(name) as unknown as EngineNode;

	/** Anchor JSON → engine RelativePosition → live index. */
	const resolveAnchor = (doc: EngineDoc, text: EngineNode, anchor: Anchor): number | null => {
		const itemId = (text._item as { id?: { client: number; clock: number } } | null)?.id;
		if (!itemId) return anchor.i === null ? (anchor.a < 0 ? 0 : text.length) : null;
		const rpos = Y.createRelativePositionFromJSON({
			type: { client: itemId.client, clock: itemId.clock },
			item: anchor.i === null ? null : { client: anchor.i.c, clock: anchor.i.k },
			assoc: anchor.a
		});
		const abs = Y.createAbsolutePositionFromRelativePosition(rpos, doc as unknown as YDoc, false);
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
	 * Build the ownership context over a collected block map.
	 * Pure — reads replicated state only; safe to call mid-transaction.
	 */
	const computeOwnership = (doc: EngineDoc, blocks: Map<BlockId, TextBlockRec>): Ownership => {
		const owners = computeOwners(blocks);
		const ownerOf = (b: BlockId): Owner => owners.get(b) ?? DEAD;
		const hidden = (b: BlockId): boolean => ownerOf(b) !== b;

		// Resolved ranges cache: entry identity → [i0, i1) | null.
		const rangeCache = new Map<SliceEntry, [number, number] | null>();
		const resolvedRange = (entry: SliceEntry, text: EngineNode): [number, number] | null => {
			if (rangeCache.has(entry)) return rangeCache.get(entry)!;
			const rec = entry.payload as SliceRecord;
			const i0 = resolveAnchor(doc, text, rec.s);
			const i1 = resolveAnchor(doc, text, rec.e);
			const r = i0 === null || i1 === null ? null : ([Math.min(i0, i1), Math.max(i0, i1)] as const);
			const v = r === null ? null : ([r[0], r[1]] as [number, number]);
			rangeCache.set(entry, v);
			return v;
		};

		// Per-text per-atom winner: the live covering record with the best key
		// (generation, start, stamp):
		//  - generation: records written by a later split/rewrite carry a
		//    strictly larger `g` than every record that covered the text
		//    before them, so causal partitions beat any pre-existing coverage
		//    (in particular a claimed list's own records can never re-swallow
		//    atoms a sibling now owns — this is what makes
		//    split-of-claimed-content deterministic at any claim depth).
		//  - start: the record's resolved left edge. At equal generation the
		//    innermost claim wins — concurrent splits at different anchors then
		//    produce the seam-preserving nested partition (split at 3 + split
		//    at 8 ⇒ [0,3)|[3,8)|[8,E)) rather than winner-take-all.
		//  - stamp: the claim item's (client, clock) — arbitrary but
		//    deterministic order for genuinely concurrent overlaps with equal
		//    generation AND equal left edge (same-anchor concurrent splits).
		// Tracked as the winning RECORD (atomClaim) so two overlapping records
		// routing to the same owner still emit each atom exactly once.
		// `maxG` records the highest generation seen covering each text —
		// materializing records bump it to win their own range.
		type Key = { g: number; s0: number; st: Stamp };
		const better = (a: Key, b: Key | undefined): boolean =>
			b === undefined ||
			a.g - b.g > 0 ||
			(a.g === b.g && (a.s0 - b.s0 > 0 || (a.s0 === b.s0 && cmpStamp(a.st, b.st) > 0)));
		const atomOwner = new Map<TextId, (BlockId | undefined)[]>();
		const atomClaim = new Map<TextId, (SliceEntry | undefined)[]>();
		const bestKey = new Map<TextId, Key[]>();
		const maxG = new Map<TextId, number>();
		for (const [holderId, rec] of blocks) {
			const candBlock = ownerOf(holderId);
			for (const e of rec.entries) {
				if (!isSliceRecord(e.payload)) continue;
				const t = e.payload.t;
				const g = e.payload.g ?? 0;
				if (g > (maxG.get(t) ?? 0)) maxG.set(t, g);
				if (candBlock === DEAD) continue; // dead holders can't claim
				const textRec = blocks.get(t);
				if (!textRec || !textRec.content) continue;
				const range = resolvedRange(e, textRec.content);
				if (range === null) continue;
				const [i0, i1] = range;
				const key: Key = { g, s0: i0, st: e.stamp };
				const arr = atomOwner.get(t) ?? [];
				const claims = atomClaim.get(t) ?? [];
				const keys = bestKey.get(t) ?? [];
				for (let i = i0; i < i1 && i < textRec.content.length; i++) {
					if (better(key, keys[i])) {
						keys[i] = key;
						arr[i] = candBlock;
						claims[i] = e;
					}
				}
				if (arr.length > 0) {
					atomOwner.set(t, arr);
					atomClaim.set(t, claims);
					bestKey.set(t, keys);
				}
			}
		}
		return { ownerOf, hidden, atomOwner, atomClaim, resolvedRange, maxG };
	};

	/**
	 * Flatten `b`'s displayed content into ordered owned segments.
	 * Merge claims recurse into the claimed list (cycle-safe); only atoms whose
	 * computed owner is exactly `b` are emitted — an ineffective claim (one
	 * that lost the list contest) silently contributes nothing.
	 */
	const flatten = (b: BlockId, blocks: Map<BlockId, TextBlockRec>, own: Ownership): OwnedSeg[] => {
		const segs: OwnedSeg[] = [];
		const emitRecord = (entry: SliceEntry, holder: BlockId, via: SliceEntry) => {
			const rec = entry.payload as SliceRecord;
			const textRec = blocks.get(rec.t);
			if (!textRec || !textRec.content) return;
			const range = own.resolvedRange(entry, textRec.content);
			if (range === null) return;
			const owners = own.atomOwner.get(rec.t);
			const claims = own.atomClaim.get(rec.t);
			let i = range[0];
			while (i < range[1]) {
				// Emit only atoms this RECORD wins — a losing overlapping
				// record contributes nothing even when it routes to the same
				// owner (otherwise concurrent splits would double-display the
				// overlap).
				if (owners?.[i] === b && claims?.[i] === entry) {
					const start = i;
					while (i < range[1] && owners?.[i] === b && claims?.[i] === entry) i++;
					segs.push({ t: rec.t, i0: start, i1: i, holder, seqIndex: entry.seqIndex, via });
				} else {
					i++;
				}
			}
		};
		const walk = (listId: BlockId, seen: Set<BlockId>, via: SliceEntry | null) => {
			if (seen.has(listId)) return;
			seen.add(listId);
			const rec = blocks.get(listId);
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
	 * Read atoms `[i0, i1)` of `text` into ContentItems (text runs grouped by
	 * identical marks; inline atoms as `{kind:'inline'}`).
	 *
	 * Reads the engine-maintained `.delta` cache. Two contract guards:
	 * - DETACHED nodes: a pre-integration `.delta` read materializes an
	 *   EMPTY cache that is never back-filled (poisoned until `clearCache`)
	 *   — return `[]` without touching it (U05 contract test).
	 * - `retain` ops: a healthy state delta contains only inserts, but a
	 *   defensively-consumed cache (or a renderer-attributed delta) may
	 *   carry retains — they still occupy positions, so advance `pos`.
	 */
	const itemsOfRange = (
		text: EngineNode,
		i0: number,
		i1: number
	): { kind: 'text'; text: string; marks?: Record<string, unknown> }[] | never[] => {
		if ((text as { doc?: unknown }).doc == null) return [];
		const items: { kind: 'text'; text: string; marks?: Record<string, unknown> }[] | unknown[] = [];
		let pos = 0;
		// `toDelta()` re-renders the current item sequence on every call —
		// mid-transaction safe: uncommitted inserts/deletes are already
		// reflected. The maintained `.delta` cache only refreshes at
		// transaction cleanup, so reads between two ops of one transaction
		// would observe stale content (U08 app-runtime requirement: op code
		// must observe its own earlier writes, like v13 `Y.Text`). The cost
		// is a fresh render per call instead of a cached read.
		const deltaJSON = (text.toDelta().toJSON() as { children?: unknown[] }) ?? { children: [] };
		for (const op of deltaJSON.children ?? []) {
			const o = op as {
				type?: string;
				insert?: unknown;
				format?: Record<string, unknown>;
				retain?: number;
			};
			if (o.type === 'retain') {
				pos += typeof o.retain === 'number' ? o.retain : 0;
				continue;
			}
			if (o.type !== 'insert') continue;
			if (typeof o.insert === 'string') {
				const start = pos;
				pos += o.insert.length;
				const lo = Math.max(i0, start);
				const hi = Math.min(i1, pos);
				if (lo < hi) {
					const last = items[items.length - 1] as
						| { kind: 'text'; text: string; marks?: Record<string, unknown> }
						| undefined;
					const marks = o.format;
					const slice = o.insert.slice(lo - start, hi - start);
					if (
						last &&
						last.kind === 'text' &&
						JSON.stringify(last.marks ?? null) === JSON.stringify(marks ?? null)
					) {
						last.text += slice;
					} else {
						// JSON-payload contract: no `marks: undefined` key — the
						// dev-time cloneJson guard flags undefined-valued keys.
						items.push({
							kind: 'text',
							text: slice,
							...(marks === undefined ? {} : { marks })
						});
					}
				}
			} else if (Array.isArray(o.insert)) {
				for (const entry of o.insert) {
					const idx = pos;
					pos += 1;
					if (idx < i0 || idx >= i1) continue;
					// Fresh `toDelta()` renders keep inline atoms as live YNode
					// children — read their attrs via `getAttr`. The maintained
					// `.delta` cache serialized them as `{attrs:{k:{value}}}`
					// JSON instead (unwrap the op-wrapped values either way).
					let id: unknown;
					let type: unknown;
					let data: unknown;
					if (entry != null && typeof (entry as { getAttr?: unknown }).getAttr === 'function') {
						const node = entry as EngineNode;
						id = node.getAttr('id');
						type = node.getAttr('type');
						data = node.getAttr('data');
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
					(items as unknown[]).push({
						kind: 'inline',
						id: id as string,
						type: type as string,
						...(data === undefined ? {} : { data: data as Record<string, unknown> })
					});
				}
			}
		}
		return items as { kind: 'text'; text: string; marks?: Record<string, unknown> }[];
	};

	/** The block's canonical `ContentItem[]` (text runs + inline atoms). */
	const contentItemsOf = (
		b: BlockId,
		blocks: Map<BlockId, TextBlockRec>,
		own: Ownership
	): unknown[] => {
		const out: unknown[] = [];
		for (const seg of flatten(b, blocks, own)) {
			const text = blocks.get(seg.t)?.content;
			if (!text) continue;
			for (const it of itemsOfRange(text, seg.i0, seg.i1)) out.push(it);
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
		if (marks !== undefined) marks = cloneJson(marks);
		const rec = blocks.get(b);
		if (!rec) return false;
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
			// anchor is pinned at the current text end. Skip it entirely when an
			// existing record on this list already covers the end-of-text insert
			// point (e.g. the canonical empty block's whole-range {B,E} slice
			// auto-extends) — a second covering record would double-display the
			// inserted atoms.
			const ownText = rec.content;
			if (!ownText || !rec.slicesNode) return false;
			const tLen = ownText.length;
			const alreadyCovered = rec.entries.some((e) => {
				if (!isSliceRecord(e.payload)) return false;
				const p = e.payload;
				if (p.t !== b || p.e.a !== 0 || p.e.i !== null) return false;
				const r = own.resolvedRange(e, ownText);
				return r !== null && r[0] <= tLen;
			});
			if (!alreadyCovered) {
				const revive: SliceRecord = {
					t: b,
					s: anchorAt(doc, ownText, tLen),
					e: { i: null, a: 0 },
					// Bump the generation so the appended atoms — which an
					// end-sentinel record on another block's list may already
					// cover — display under this block deterministically.
					g: (own.maxG.get(b) ?? 0) + 1
				};
				rec.slicesNode.insert(rec.slicesNode.length, [revive]);
			}
			if (typeof payload === 'string') ownText.insert(tLen, payload, marks);
			else ownText.insert(tLen, [payload]);
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
			const isB = record && record.s.i === null && record.s.a < 0;
			const insertAt = seg.i0;
			if (isB) {
				if (typeof payload === 'string') text.insert(insertAt, payload, marks);
				else text.insert(insertAt, [payload]);
				return true;
			}
			// Item-anchored start: insert then re-anchor the record to cover the
			// new atoms. The rewrite bumps the generation so the record wins
			// the edge atoms deterministically — a neighbouring record's end
			// anchor also covers them, and at equal generation the fresh item
			// stamp would lose to a higher-client concurrent record.
			const n = typeof payload === 'string' ? payload.length : 1;
			if (typeof payload === 'string') text.insert(insertAt, payload, marks);
			else text.insert(insertAt, [payload]);
			if (record) {
				const holderSlices = blocks.get(seg.holder)?.slicesNode;
				if (holderSlices) {
					holderSlices.delete(seg.seqIndex, 1);
					holderSlices.insert(seg.seqIndex, [
						{
							t: seg.t,
							s: anchorAt(doc, text, insertAt),
							e: record.e,
							g: (own.maxG.get(seg.t) ?? 0) + 1
						} satisfies SliceRecord
					]);
				}
			}
			return true;
		}
		const insertAt = seg.i0 + inner;
		if (typeof payload === 'string') text.insert(insertAt, payload, marks);
		else text.insert(insertAt, [payload]);
		return true;
	};

	/**
	 * Delete `length` displayed atoms starting at `offset` — resolves each
	 * owned segment's backing-text span and deletes in that backing text.
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
		let base = 0;
		for (const seg of segs) {
			const len = seg.i1 - seg.i0;
			const lo = Math.max(at, base);
			const hi = Math.min(end, base + len);
			if (lo < hi) {
				const text = blocks.get(seg.t)?.content;
				if (!text) return false;
				text.delete(seg.i0 + (lo - base), hi - lo);
			}
			base += len;
			if (base >= end) break;
		}
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
		formats = cloneJson(formats);
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
	): { head: SlicePayload[]; tail: SlicePayload[] } | null => {
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
		const head: SlicePayload[] = [];
		let cursor = 0;
		for (const entry of rec.entries) {
			const contrib = byEntry.get(entry) ?? [];
			const count = contrib.reduce((n, s) => n + (s.i1 - s.i0), 0);
			const start = cursor;
			const end = cursor + count;
			cursor = end;
			if (end <= at) {
				actions.push({ kind: 'keep' });
				head.push(entry.payload);
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
				head.push(...headRecs);
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
				head.push(entry.payload);
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
		return { head, tail };
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
		computeOwnership,
		flatten,
		ownedLength,
		itemsOfRange,
		contentItemsOf,
		blockTextOf,
		insertIntoText,
		deleteRange,
		formatRangeIn,
		splitSlices,
		claimInto
	};
};

export type TextEngine = ReturnType<typeof bindText>;
