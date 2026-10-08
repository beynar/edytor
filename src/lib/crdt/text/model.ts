/**
 * Text ownership — streams delimited by boundary items.
 *
 * Every block created fresh owns a *backing text* (`content` node) whose items
 * are never moved or copied. A split inserts one BOUNDARY ITEM `{s, n}` (one
 * countable unit, never displayed: "block `s`, incarnation `n`, starts right
 * after me") at the end of the gap at the split point (engine primitive, fork patch YP7),
 * so a text holds the streams of every block split off it:
 *
 * - `stream(b)` starts right after `b`'s live boundary whose `n` equals `b`'s
 *   record nonce (the lowest item id if several match); failing that, at
 *   index 0 of `b`'s own text; failing that, `b` is streamless (empty).
 * - It ends at the next delimiting boundary of the same text, or at the text
 *   end. A boundary whose nonce matches no record is inert: skipped by reads,
 *   never a delimiter.
 * - `display(b)` = `stream(b)`, then `display(m)` for each merge claim `{m}`
 *   on `b`'s `claims` list whose max-stamp live claimer is `b`. Owner
 *   resolution over claims (`claimGraph`: max-stamp claim, cycles, claims held
 *   by deleted blocks are inert) is unchanged.
 *
 * Every position therefore lies in exactly one stream: the block that displays
 * it is a pure function of replicated items and is never repaired. Typing at a
 * stream's start inserts after its boundary, at its end before the next one;
 * the per-stream delete never removes a boundary; every read skips them.
 *
 * Anchors are `{b, a}`: `b` the home block of the backing text, `a` an
 * engine relative position (`i` the bound item, `a` the side: `< 0` left). A
 * left-affine caret at a split-born block's start binds its boundary item.
 *
 * The item guards are `text/items.ts`, the range reads `text/ranges.ts` and
 * the stream table `text/streams.ts` (re-exported here); this module declares
 * the text model's types and binds its reads and writes to an engine.
 */
import type { EngineApi, EngineDoc, EngineNode } from '../engine-api.js';
import {
	asYDoc,
	asYNode,
	attrItems,
	engineOps,
	newNode as makeNode,
	rangeCursorOf,
	storeOf,
	withoutRenderer,
	type IdSetOf
} from '../structs.js';
import { CONTENT, CONTENT_NODE, ID, NONCE, SCHEMA } from '../schema.js';
import { DEV } from 'esm-env';
import { hash32, hash53 } from '../rand.js';
import { bindDeletes, type Span } from './deletes.js';
import { fitMarks, writeMarks } from './marks.js';
import { nodeStart } from './items.js';
import { readRange } from './ranges.js';
import {
	delimiters,
	displayOf,
	locate,
	ownedLength,
	pieces,
	placeText,
	rangesOf,
	scanText
} from './streams.js';

export { isBoundary, nodeStart } from './items.js';
export { canonKey, deepFreeze, inlineItemOf, protectItems, readRange } from './ranges.js';
export {
	byId,
	delimiters,
	displayOf,
	locate,
	ownedLength,
	pieces,
	placeText,
	scanText
} from './streams.js';

export type BlockId = string;

/** A serialized relative position inside a backing text (`i: null`: a text end). */
export type Anchor = { i: { c: number; k: number } | null; a: number };

/** An engine item id as a claim payload stores it. */
export type ItemRef = { c: number; k: number };
const isItemRef = (v: unknown): v is ItemRef =>
	v != null &&
	typeof v === 'object' &&
	Number.isInteger((v as ItemRef).c) &&
	Number.isInteger((v as ItemRef).k);

/**
 * Merge-claim payload: "this block's display continues with block `m`'s".
 * `a` and `r` (since 0.1.0-next.26, `merge.claim.anchor`) anchor it to the
 * end of the holder's stream as the claim's writer saw it: `a` the last
 * unit of that stream (its opening boundary when empty; absent at the start
 * of an own text) and `r` the item right after it (the next stream's
 * boundary; `null` at the text's end). A split the writer did not see moves
 * the claim to the piece that ends the region between them.
 */
export type MergeClaim = { m: BlockId; a?: ItemRef; r?: ItemRef | null };
export const isMergeClaim = (v: unknown): v is MergeClaim =>
	v != null && typeof v === 'object' && typeof (v as MergeClaim).m === 'string';

/** Deterministic claim stamp = engine item id (client-major order). */
export type Stamp = { c: number; k: number };
export const cmpStamp = (a: Stamp, b: Stamp): number => a.c - b.c || a.k - b.k;

/**
 * One live merge claim: `seqIndex` is its live index in the list that
 * stores it — its holder's, or `holder`'s when its anchor moved it to
 * another block (`merge.claim.anchor`); `-1` for an implicit claim, which
 * no list stores (`id.same.concurrent`). `a`/`r`: its anchor (see
 * {@link MergeClaim}).
 */
export type Claim = {
	m: BlockId;
	stamp: Stamp;
	seqIndex: number;
	a?: ItemRef;
	r?: ItemRef | null;
	holder?: BlockId;
};

/** Boundary-item payload in a backing text. */
export type Boundary = { s: BlockId; n: unknown };

/** Structural item for sequence walks (`node._start`). */
export type SeqItem = {
	id: { client: number; clock: number };
	length: number;
	deleted: boolean;
	countable?: boolean;
	right: SeqItem | null;
	content: { getContent(): unknown[]; str?: string; arr?: unknown[]; type?: EngineNode };
};

/** The live merge claims of a `claims` list, with their stamps. */
export const readClaims = (node: EngineNode | undefined): Claim[] => {
	const out: Claim[] = [];
	let seqIndex = 0;
	for (let it = node ? nodeStart(node) : null; it !== null; it = it.right) {
		if (it.deleted || it.countable === false) continue;
		const arr = it.content.getContent();
		for (let j = 0; j < it.length; j++) {
			const p = arr[j];
			if (isMergeClaim(p)) {
				const claim: Claim = { m: p.m, stamp: { c: it.id.client, k: it.id.clock + j }, seqIndex };
				if (isItemRef(p.a)) {
					claim.a = p.a;
					claim.r = isItemRef(p.r) ? p.r : null;
				}
				out.push(claim);
			}
			seqIndex++;
		}
	}
	return out;
};

/** One emitted range-read element — the `ContentItem` shape. */
export type RangeItem =
	| { kind: 'text'; text: string; marks?: Record<string, unknown> }
	| { kind: 'inline'; id: string; type: string; data?: Record<string, unknown> };

/** One element of the vendored `Y.RangeCursor` piece stream (see `RangeCursor.js`). */
export type RangePiece = {
	/** The piece's content object — BORROWED, never mutated. */
	content: { getContent?(): unknown[]; str?: string; key?: string; value?: unknown };
	id: { client: number; clock: number };
	index: number;
	offset: number;
	/** Rendered length (`0` for format markers). */
	len: number;
	deleted: boolean;
	attrs: unknown[] | null;
	/** Folded mark state — SHARED across same-state pieces; read-only. */
	formats: Record<string, unknown> | undefined;
};

/** The vendored bounded read cursor over one backing text. */
export type RangeCursor = {
	read(i0: number, i1: number, stats?: RangeReadStats): RangePiece[];
};

/** Per-read instrumentation: sequence items stepped over / format markers seen. */
export type RangeReadStats = { items: number; markers: number };

// ── records and the claim graph ──────────────────────────────────────

/** The block-record facts text ownership needs. */
export type TextBlockRec = {
	id: BlockId;
	node: EngineNode;
	deleted: boolean;
	/** The incarnation nonce `n`. */
	n: unknown;
	/** The block's own backing text, when it has one. */
	content: EngineNode | undefined;
	/** The `claims` list node (write handle). */
	claimsNode: EngineNode | undefined;
	/**
	 * Its effective merge claims (`merge.claim.anchor`): its list's claims
	 * that stay with it, in list order, then those other holders' anchors
	 * moved to it (each with its `holder`), by stamp.
	 */
	claims: Claim[];
	/** Its list's live claims, in list order (absent: `claims` is the list). */
	listClaims?: Claim[];
};

/** The internal "no display owner" verdict — a symbol, never a block id. */
export const DEAD: unique symbol = Symbol('edytor.crdt.dead');
export type Owner = BlockId | typeof DEAD;

/**
 * The claim graph: `owners` — the block that displays each block (deleted →
 * `DEAD`; no claim → itself; else the max-stamp live claimer's owner; a
 * cycle resolves to the claimer of its max-stamp edge) — and `top`, each
 * claimed block's max-stamp live claimer. Claims held by deleted blocks are
 * inert (a concurrent merge into a deleted block is voided).
 */
export const claimGraph = (blocks: ReadonlyMap<BlockId, TextBlockRec>) => {
	const top = new Map<BlockId, { claimer: BlockId; stamp: Stamp }>();
	for (const [holder, rec] of blocks) {
		if (rec.deleted) continue;
		for (const c of rec.claims) {
			const best = top.get(c.m);
			if (best === undefined || cmpStamp(c.stamp, best.stamp) > 0)
				top.set(c.m, { claimer: holder, stamp: c.stamp });
		}
	}
	const owners = new Map<BlockId, Owner>();
	const ownerOf = (b: BlockId): Owner => {
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
				let best = top.get(path[at])!;
				for (const member of path.slice(at)) {
					const t = top.get(member)!;
					if (cmpStamp(t.stamp, best.stamp) > 0) best = t;
				}
				result = best.claimer;
				break;
			}
			const t = top.get(cur);
			if (t === undefined) {
				result = cur;
				break;
			}
			path.push(cur);
			cur = t.claimer;
		}
		owners.set(cur, result);
		for (const p of path) owners.set(p, result);
		return result;
	};
	for (const id of blocks.keys()) ownerOf(id);
	return { owners, top: new Map([...top].map(([m, t]) => [m, t.claimer])) };
};

/** `owner(b)` for every block (see {@link claimGraph}). */
export const computeOwners = (blocks: ReadonlyMap<BlockId, TextBlockRec>): Map<BlockId, Owner> =>
	claimGraph(blocks).owners;

// ── the stream table ─────────────────────────────────────────────────

/** A live boundary at live index `at` of its text; `key` is its item id. */
export type Bound = Boundary & { at: number; key: string };
/** One scanned backing text: its live boundaries in order and its live length. */
export type TextRow = {
	home: BlockId;
	text: EngineNode;
	bounds: Bound[];
	len: number;
	key: string;
};
/** One stream: `[start, end)` of `home`'s text, minus the inert boundaries at `inert`. */
export type Stream = {
	block: BlockId;
	home: BlockId;
	text: EngineNode;
	start: number;
	end: number;
	inert: number[];
};

/** A displayed piece: `[i0, i1)` of `text` (home `t`) holds content only; `block` owns its stream. */
export type Seg = {
	t: BlockId;
	text: EngineNode;
	block: BlockId;
	i0: number;
	i1: number;
	/** The claims walked to reach `block` (holder, index in its claims). */
	path: { holder: BlockId; entry: number }[];
};

/** The ownership context: the claim graph plus the stream table. */
export type Ownership = {
	ownerOf: (b: BlockId) => Owner;
	hidden: (b: BlockId) => boolean;
	/** The claimed block's max-stamp live claimer. */
	top: (m: BlockId) => BlockId | undefined;
	streamOf: (b: BlockId) => Stream | undefined;
	/** The streams of `home`'s text, in text order. */
	streamsIn: (home: BlockId) => readonly Stream[];
	/** The stream of `home`'s text whose `[start, end]` holds live index `i` (the first, at a seam). */
	streamAt: (home: BlockId, i: number) => Stream | undefined;
	/** `display(b)` as boundary-free pieces in reading order; `null` when hidden or dead. */
	display: (b: BlockId) => Seg[] | null;
	/** `b`'s effective claims (`merge.claim.anchor`), when the context computed them. */
	claimsOf?: (b: BlockId) => readonly Claim[];
};

/** Every write addresses live-content space: a renderer on a backing text is a read concern. */
const plain = <T>(text: EngineNode, f: () => T): T => withoutRenderer(text, f);

export const bindText = (Y: EngineApi) => {
	const D = bindDeletes(Y);
	const newNode = (name: string): EngineNode => makeNode(Y, name);
	const ops = engineOps(Y);

	/** Anchor → live index in `text`, or `null` when its item is not integrated here. */
	const resolveAnchor = (doc: EngineDoc, text: EngineNode, anchor: Anchor): number | null => {
		const itemId = (text._item as { id?: { client: number; clock: number } } | null)?.id;
		if (!itemId) return anchor.i === null ? (anchor.a < 0 ? 0 : text.length) : null;
		const abs = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromJSON({
				type: { client: itemId.client, clock: itemId.clock },
				item: anchor.i === null ? null : { client: anchor.i.c, clock: anchor.i.k },
				assoc: anchor.a
			}),
			asYDoc(doc),
			false
		);
		return abs === null ? null : abs.index;
	};

	/**
	 * Live index → anchor bound on the `assoc` side: `assoc < 0` binds the unit
	 * before `index` (an insert at `index` lands right of it; `i: null` at the
	 * text start), `assoc >= 0` the unit at `index` (`i: null` at the text end).
	 */
	const anchorAt = (text: EngineNode, index: number, assoc: number): Anchor => {
		const json = Y.relativePositionToJSON(
			Y.createRelativePositionFromTypeIndex(asYNode(text), index, assoc)
		) as { item?: { client: number; clock: number } };
		return {
			i: json.item ? { c: json.item.client, k: json.item.clock } : null,
			a: assoc < 0 ? -1 : 0
		};
	};

	/** A renderer-free bounded read cursor on `text` (live-content space). */
	const openRangeCursor = (text: EngineNode): RangeCursor => rangeCursorOf<RangeCursor>(Y, text);

	const itemsOfRange = (text: EngineNode, i0: number, i1: number): RangeItem[] =>
		readRange(openRangeCursor(text), i0, i1);

	/** The items of `segs`, one cursor per backing text. */
	const readSegs = (segs: readonly Seg[], stats?: RangeReadStats): RangeItem[] => {
		const out: RangeItem[] = [];
		const cursors = new Map<EngineNode, RangeCursor>();
		for (const seg of segs) {
			let cur = cursors.get(seg.text);
			if (cur === undefined) cursors.set(seg.text, (cur = openRangeCursor(seg.text)));
			readRange(cur, seg.i0, seg.i1, stats, out);
		}
		return out;
	};

	/** A from-scratch ownership context over `blocks` (every text scanned). */
	/**
	 * The effective claims of every block, from scratch (`merge.claim.anchor`;
	 * the index keeps them incrementally, `text/runs.ts`): an anchored claim
	 * goes to the block of the segment just before its `r` (the text's last
	 * segment when `r` is null) in the row of its holder's stream, when that
	 * segment is the holder's or a later one.
	 */
	const effectiveClaims = (
		doc: EngineDoc,
		blocks: ReadonlyMap<BlockId, TextBlockRec>,
		rows: ReadonlyMap<EngineNode, TextRow>,
		delim: ReadonlyMap<BlockId, string>,
		streams: ReadonlyMap<BlockId, Stream>
	): Map<BlockId, Claim[]> => {
		/** Live index of unit `ref` (assoc 0) in `text`, or `null` when it is not `text`'s. */
		const indexIn = (text: EngineNode, ref: ItemRef): number | null => {
			const itemId = (text._item as { id?: { client: number; clock: number } } | null)?.id;
			if (!itemId) return null;
			const abs = Y.createAbsolutePositionFromRelativePosition(
				Y.createRelativePositionFromJSON({
					type: { client: itemId.client, clock: itemId.clock },
					item: { client: ref.c, clock: ref.k },
					assoc: 0
				}),
				asYDoc(doc),
				false
			) as { type: unknown; index: number } | null;
			return abs === null || abs.type !== text ? null : abs.index;
		};
		const targetOf = (holder: BlockId, c: Claim): BlockId => {
			if (c.a === undefined) return holder;
			const s = streams.get(holder);
			const row = s && rows.get(s.text);
			if (row === undefined || indexIn(row.text, c.a) === null) return holder;
			const cuts: number[] = [];
			row.bounds.forEach((b, j) => {
				if (delim.get(b.s) === b.key) cuts.push(j);
			});
			const head = delim.has(row.home) ? null : row.home;
			// The gap before `r`: a live boundary's own index, else the boundaries before it.
			let gap = row.bounds.length;
			if (c.r != null) {
				const key = `${c.r.c}:${c.r.k}`;
				const at = row.bounds.findIndex((b) => b.key === key);
				if (at >= 0) gap = at;
				else {
					const p = indexIn(row.text, c.r);
					if (p === null) return holder;
					gap = row.bounds.filter((b) => b.at < p).length;
				}
			}
			const segment = (g: number) => cuts.filter((j) => j < g).length;
			const k = segment(gap);
			// The holder's own segment: the one its stream starts in.
			const k0 = segment(row.bounds.filter((b) => b.at < s!.start).length);
			if (k < k0) return holder;
			return (k === 0 ? head : row.bounds[cuts[k - 1]].s) ?? holder;
		};
		const own = new Map<BlockId, Claim[]>();
		const moved = new Map<BlockId, Claim[]>();
		for (const [h, rec] of blocks) {
			const stays: Claim[] = [];
			for (const c of rec.listClaims ?? rec.claims) {
				const t = targetOf(h, c);
				if (t === h) stays.push(c);
				else {
					let into = moved.get(t);
					if (into === undefined) moved.set(t, (into = []));
					into.push({ ...c, holder: h });
				}
			}
			own.set(h, stays);
		}
		for (const [t, list] of moved) {
			if (!own.has(t)) continue;
			list.sort((x, y) => cmpStamp(x.stamp, y.stamp));
			own.set(t, [...own.get(t)!, ...list]);
		}
		return own;
	};

	const computeOwnership = (doc: EngineDoc, given: ReadonlyMap<BlockId, TextBlockRec>) => {
		const rows: TextRow[] = [];
		for (const rec of given.values()) if (rec.content) rows.push(scanText(rec.id, rec.content));
		const delim = delimiters(given, rows);
		const streams = new Map<BlockId, Stream>();
		const inText = new Map<BlockId, Stream[]>();
		for (const row of rows) {
			const list = placeText(row, delim);
			inText.set(row.home, list);
			for (const s of list) streams.set(s.block, s);
		}
		// The records with their effective claims (`merge.claim.anchor`).
		const effective = effectiveClaims(
			doc,
			given,
			new Map(rows.map((row) => [row.text, row])),
			delim,
			streams
		);
		const blocks = new Map<BlockId, TextBlockRec>();
		for (const [id, rec] of given)
			blocks.set(id, {
				...rec,
				listClaims: rec.listClaims ?? rec.claims,
				claims: effective.get(id) ?? rec.claims
			});
		const { owners, top } = claimGraph(blocks);
		const ownerOf = (b: BlockId): Owner => owners.get(b) ?? DEAD;
		const own: Ownership = {
			ownerOf,
			hidden: (b) => ownerOf(b) !== b,
			top: (m) => top.get(m),
			streamOf: (b) => streams.get(b),
			streamsIn: (home) => inText.get(home) ?? [],
			streamAt: (home, i) => (inText.get(home) ?? []).find((x) => x.start <= i && i <= x.end),
			display: (b) => displayOf(b, blocks, own),
			claimsOf: (b) => blocks.get(b)?.claims ?? []
		};
		return own;
	};

	/** `b`'s display pieces (`[]` when hidden or streamless and claimless). */
	const flatten = (b: BlockId, blocks: unknown, own: Ownership): Seg[] => {
		void blocks;
		return own.display(b) ?? [];
	};

	const contentItemsOf = (b: BlockId, blocks: unknown, own: Ownership): RangeItem[] =>
		readSegs(flatten(b, blocks, own));

	const blockTextOf = (b: BlockId, blocks: unknown, own: Ownership): string =>
		contentItemsOf(b, blocks, own)
			.map((i) => (i.kind === 'text' ? i.text : ''))
			.join('');

	// ── writes (inside doc.transact; the plan clamped offsets) ────────

	/**
	 * Insert at a display offset, beside the boundary the engine walk and the
	 * left side choose. The display must be non-empty: a streamless block gets
	 * its own text first ({@link ownText}). The content goes in its gap
	 * (`insertInGap`, fork patch YP13: after the marks attached to the text before it,
	 * before those attached to the text after it); text then shows exactly
	 * `marks` (an operation for each mark its gap gave it otherwise).
	 */
	const insertIntoText = (
		doc: EngineDoc,
		blocks: unknown,
		own: Ownership,
		b: BlockId,
		offset: number,
		payload: string | EngineNode,
		marks?: Record<string, unknown>
	): void => {
		const segs = flatten(b, blocks, own);
		const hit = locate(segs, Math.max(0, Math.min(offset, ownedLength(segs))));
		if (hit === null) throw new Error(`insertIntoText: "${b}" has no stream`);
		const text = hit.seg.text as EngineNode & {
			insertInGap(index: number, content: string | unknown[]): void;
		};
		plain(text, () => {
			if (typeof payload !== 'string') return text.insertInGap(hit.idx, [payload]);
			text.insertInGap(hit.idx, payload);
			const at = openRangeCursor(text).read(hit.idx, hit.idx + payload.length);
			const have = at.find((p) => !p.deleted && p.len > 0)?.formats;
			fitMarks(doc, text, hit.idx, payload.length, have, marks);
		});
	};

	/** The per-stream delete: each range lies inside one stream's pieces, so no boundary is ever removed. */
	const deleteRange = (
		doc: EngineDoc,
		blocks: unknown,
		own: Ownership,
		b: BlockId,
		offset: number,
		length: number
	): void => {
		const spans: Span[] = [];
		for (const r of rangesOf(flatten(b, blocks, own), offset, offset + length)) {
			for (const p of openRangeCursor(r.text).read(r.a, r.b))
				if (!p.deleted && p.len > 0 && (p.content.str !== undefined || 'type' in p.content))
					spans.push({ c: p.id.client, k: p.id.clock, n: p.len });
			plain(r.text, () => r.text.delete(r.a, r.b - r.a));
		}
		D.markDeleted(doc, spans);
	};

	const formatRangeIn = (
		doc: EngineDoc,
		blocks: unknown,
		own: Ownership,
		b: BlockId,
		offset: number,
		length: number,
		formats: Record<string, unknown>
	): void => {
		for (const r of rangesOf(flatten(b, blocks, own), offset, offset + length))
			plain(r.text, () => writeMarks(doc, r.text, r.a, r.b - r.a, formats));
	};

	/**
	 * Delete the content of streams `streams` (the room's purge of a
	 * block deleted past the horizon): every piece, so no boundary goes and
	 * each stream still delimits, renderer-free, writing no delete mark.
	 * Streams of one text are deleted from its end, so the indices the
	 * caller read stay valid.
	 */
	const purgeStreams = (streams: readonly Stream[]): void => {
		const ordered = [...streams].sort((a, b) => b.start - a.start);
		for (const s of ordered) {
			const parts = pieces(s).filter(([a, b]) => b > a);
			for (let i = parts.length - 1; i >= 0; i--) {
				const [a, b] = parts[i];
				plain(s.text, () => s.text.delete(a, b - a));
			}
		}
	};

	/** The inline atom `inlineId` in `b`'s display: its text, engine index and node. */
	const findAtom = (own: Ownership, b: BlockId, inlineId: string) => {
		for (const s of own.display(b) ?? []) {
			let at = 0;
			for (let it = nodeStart(s.text); it !== null && at < s.i1; it = it.right) {
				if (it.deleted || it.countable === false) continue;
				const node = it.content.type;
				if (node !== undefined && at >= s.i0 && node.getAttr(ID) === inlineId)
					return { text: s.text, at, node };
				at += it.length;
			}
		}
		return null;
	};

	/**
	 * Split `b`'s display at `offset` for the new block `newId` (incarnation
	 * `n`): one boundary through fork patch YP7 at the end of the gap, and the claims that
	 * follow the split point — every claim of the stream's own block, then each
	 * holder's claims after the one that led down — returned for re-insertion
	 * on the new block and deleted from their holders. No text is copied.
	 */
	const splitAt = (
		blocks: ReadonlyMap<BlockId, TextBlockRec>,
		own: Ownership,
		b: BlockId,
		offset: number,
		newId: BlockId,
		n: number
	): MergeClaim[] => {
		const segs = flatten(b, blocks, own);
		const hit = locate(segs, Math.max(0, Math.min(offset, ownedLength(segs))));
		if (hit === null) throw new Error(`splitAt: "${b}" has no stream`);
		const { seg, idx } = hit;
		const moved: { holder: BlockId; claim: Claim }[] = [];
		// A claim another block stores (its anchor moved it here) is deleted from that list.
		const after = (holder: BlockId, from: number) =>
			blocks
				.get(holder)!
				.claims.slice(from)
				.forEach((c) => moved.push({ holder: c.holder ?? holder, claim: c }));
		after(seg.block, 0);
		for (let i = seg.path.length - 1; i >= 0; i--) after(seg.path[i].holder, seg.path[i].entry + 1);
		const text = seg.text as EngineNode & { insertAtGapEnd(i: number, c: unknown[]): void };
		plain(text, () => text.insertAtGapEnd(idx, [{ s: newId, n } satisfies Boundary]));
		const byHolder = new Map<BlockId, number[]>();
		// An implicit claim (a losing incarnation) has no list entry: it is
		// only written, explicitly, on the new block, whose claim outranks it.
		for (const { holder, claim } of moved)
			if (claim.seqIndex >= 0)
				byHolder.set(holder, [...(byHolder.get(holder) ?? []), claim.seqIndex]);
		for (const [holder, idxs] of byHolder) {
			const list = blocks.get(holder)!.claimsNode!;
			for (const i of idxs.sort((x, y) => y - x)) list.delete(i, 1);
		}
		// Re-inserted with their anchors: the region they end is the new block's now.
		return moved.map(({ claim: c }) =>
			c.a === undefined ? { m: c.m } : { m: c.m, a: c.a, r: c.r ?? null }
		);
	};

	/**
	 * Append a merge claim `{m: from}` to `into`'s claims list, anchored to
	 * the end of `into`'s stream (`merge.claim.anchor`): its last unit (its
	 * opening boundary when empty; none at an own text's start) and the item
	 * after it.
	 */
	const claimInto = (
		blocks: ReadonlyMap<BlockId, TextBlockRec>,
		own: Pick<Ownership, 'streamOf'>,
		from: BlockId,
		into: BlockId
	): void => {
		const list = blocks.get(into)!.claimsNode!;
		const claim: MergeClaim = { m: from };
		const s = own.streamOf(into);
		if (s !== undefined) {
			const a = anchorAt(s.text, s.end, -1).i;
			if (a !== null) {
				claim.a = a;
				claim.r = anchorAt(s.text, s.end, 0).i;
			}
		}
		list.insert(list.length, [claim]);
	};

	/**
	 * Give streamless block `rec` its own text and re-mint its nonce, so a late
	 * copy of its old boundary is inert. Both writes carry a writer id
	 * derived from the block's node and its dead incarnation, so replicas that
	 * type into the block concurrently write the SAME items and both typings
	 * land in one text (the seed writer's mechanism). Returns the nonce
	 * change (the caller moves the block's attribution record with it).
	 */
	const ownText = (doc: EngineDoc, rec: TextBlockRec): { from: unknown; to: number } => {
		const map = attrItems(rec.node);
		const idOf = (x: unknown) => {
			const it = (x as { id?: { client: number; clock: number } } | null | undefined)?.id;
			return it === undefined ? '-' : `${it.client}:${it.clock}`;
		};
		const seed = [
			`own/${SCHEMA.name}@${SCHEMA.version}`,
			rec.id,
			String(rec.n),
			idOf(rec.node._item),
			idOf(map.get(NONCE)),
			idOf(map.get(CONTENT))
		].join('|');
		const writer = hash53(seed) || 1;
		const to = hash32(`${seed}|n`);
		const store = storeOf(doc);
		// The derivation is fresh per incarnation: a writer that already wrote
		// here is another block's (a hash collision, the known residual class).
		if (DEV && store.getClock(writer) !== 0)
			console.warn(`[edytor] own-text writer ${writer} of block ${rec.id} collides`);
		const local = doc.clientID;
		doc.clientID = writer;
		try {
			rec.node.setAttr(CONTENT, newNode(CONTENT_NODE));
			rec.node.setAttr(NONCE, to);
		} finally {
			doc.clientID = local;
		}
		const ids = ownTextIds.get(doc) ?? ops.idSet();
		ownTextIds.set(doc, ids);
		const clock = store.getClock(writer);
		ids.add(writer, clock - 2, 2);
		return { from: rec.n, to };
	};

	return {
		newNode,
		resolveAnchor,
		anchorAt,
		openRangeCursor,
		itemsOfRange,
		readSegs,
		computeOwnership,
		flatten,
		ownedLength,
		contentItemsOf,
		blockTextOf,
		insertIntoText,
		deleteRange,
		formatRangeIn,
		purgeStreams,
		findAtom,
		splitAt,
		claimInto,
		ownText
	};
};

/**
 * The items this replica wrote with a derived own-text writer (local only): a
 * history step never captures them, so undoing the first typing removes the
 * typing and keeps the text every replica shares.
 */
export const ownTextIds = new WeakMap<EngineDoc, IdSetOf>();

export type TextEngine = ReturnType<typeof bindText>;
