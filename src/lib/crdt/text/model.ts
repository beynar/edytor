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
 * - A merge writes one CLAIM ITEM `{m}` (one countable unit, never
 *   displayed) at the end of the gap at the end of the holder's stream (fork
 *   patch YP21: among the items of one origin it sorts after content and
 *   boundaries, so YATA decides which piece of a concurrent split keeps it).
 *   A block's claims are the claim items of its stream, in text order.
 * - `display(b)` = `stream(b)`, then `display(m)` for each claim `{m}` of `b`
 *   whose max-stamp live claimer is `b`. Owner resolution over claims
 *   (`claimGraph`: max-stamp claim, cycles, claims held by deleted blocks are
 *   inert) is unchanged.
 *
 * Every position therefore lies in exactly one stream: the block that displays
 * it is a pure function of replicated items and is never repaired. Typing at a
 * stream's start inserts after its boundary, at its end before the next one;
 * the per-stream delete never removes a boundary or a claim; every read skips
 * them.
 *
 * Anchors are `{b, a}`: `b` the home block of the backing text, `a` an
 * engine relative position (`i` the bound item, `a` the side: `< 0` left). A
 * left-affine caret at a split-born block's start binds its boundary item.
 *
 * The item guards are `text/items.ts`, the range reads `text/ranges.ts` and
 * the stream table `text/streams.ts` (re-exported here); this module declares
 * the text model's types and its reads and writes, each a function edytor's
 * modules import (the public binding's `text` lists them, `bindText`). The
 * from-scratch ownership (`computeOwnership`) is the oracle the index is
 * checked against: only the public binding and the tests reach it.
 */
import type { EngineApi, EngineDoc, EngineNode } from '../engine-api.js';
import { Y } from '../engine.js';
import {
	asYDoc,
	asYNode,
	attrItems,
	engineOps,
	newNode as makeNode,
	rangeCursorOf,
	storeOf,
	type IdSetOf
} from '../structs.js';
import { CONTENT, CONTENT_NODE, ID, NONCE, SCHEMA, TEXT_DELETES_ROOT } from '../schema.js';
import { DEV } from 'esm-env';
import { hash32, hash53 } from '../rand.js';
import { fitMarks, writeMarks } from './marks.js';
import { nodeStart } from './items.js';
import { readRange } from './ranges.js';
import {
	claimsIn,
	delimiters,
	displayOf,
	locate,
	ownedLength,
	pieces,
	placeText,
	rangesOf,
	scanText
} from './streams.js';

export { isBoundary, isClaimItem, isRowMark, nodeStart } from './items.js';
export { canonKey, deepFreeze, inlineItemOf, protectItems, readRange } from './ranges.js';
export {
	byId,
	claimsIn,
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

/**
 * A claim item's payload: "the display of the block whose stream holds me
 * continues with block `m`'s" (`merge.claim.anchor`: YATA places it, so a
 * split its writer did not see leaves it in the piece that ends the
 * holder's region).
 */
export type MergeClaim = { m: BlockId };

/** Deterministic claim stamp = engine item id (client-major order). */
export type Stamp = { c: number; k: number };
export const cmpStamp = (a: Stamp, b: Stamp): number => a.c - b.c || a.k - b.k;

/**
 * One live merge claim: its stamp is its claim item's id; an implicit
 * claim, which no item stores (`id.same.concurrent`), stamps below every
 * item (`stamp.c < 0`).
 */
export type Claim = { m: BlockId; stamp: Stamp };

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
	/** Its merge claims: its implicit ones, then the claim items of its stream, in text order. */
	claims: Claim[];
	/** Its implicit claims (`id.same.concurrent`), which no item stores. */
	implicit?: Claim[];
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

/**
 * A unit a row tracks at live index `at` of its text (`key`: its item id): a
 * live boundary, or a live claim item (`m`, with its stamp), which never
 * delimits.
 */
export type Bound = { at: number; key: string } & (
	| (Boundary & { m?: undefined })
	| { m: BlockId; stamp: Stamp; s?: undefined; n?: undefined }
);
/** One scanned backing text: its live boundaries and claim items in order, and its live length. */
export type TextRow = {
	home: BlockId;
	text: EngineNode;
	bounds: Bound[];
	len: number;
	key: string;
};
/** One stream: `[start, end)` of `home`'s text, minus the inert boundaries and claim items at `inert`. */
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
};

const ops = engineOps(Y);
/** Construct a detached v14 node, viewed through the structural interface. */
export const newNode = (name: string): EngineNode => makeNode(Y, name);

/** Anchor → live index in `text`, or `null` when its item is not integrated here. */
export const resolveAnchor = (doc: EngineDoc, text: EngineNode, anchor: Anchor): number | null => {
	const item = text._item as { id?: unknown; content?: { type?: unknown } } | null;
	// A text end: the text's own length, while the text is held (not collected).
	if (anchor.i === null)
		return !item?.id || item.content?.type === text ? (anchor.a < 0 ? 0 : text.length) : null;
	if (!item?.id) return null;
	return Y.indexOfId(asYDoc(doc), Y.createID(anchor.i.c, anchor.i.k), anchor.a)?.index ?? null;
};

/**
 * Live index → anchor bound on the `assoc` side: `assoc < 0` binds the unit
 * before `index` (an insert at `index` lands right of it; `i: null` at the
 * text start), `assoc >= 0` the unit at `index` (`i: null` at the text end).
 */
export const anchorAt = (text: EngineNode, index: number, assoc: number): Anchor => {
	const id = Y.idAtIndex(asYNode(text), index, assoc);
	return { i: id ? { c: id.client, k: id.clock } : null, a: assoc < 0 ? -1 : 0 };
};

/** A bounded read cursor on `text` (live-content space). */
export const openRangeCursor = (text: EngineNode): RangeCursor =>
	rangeCursorOf<RangeCursor>(Y, text);

export const itemsOfRange = (text: EngineNode, i0: number, i1: number): RangeItem[] =>
	readRange(openRangeCursor(text), i0, i1);

/** The items of `segs`, one cursor per backing text. */
export const readSegs = (segs: readonly Seg[], stats?: RangeReadStats): RangeItem[] => {
	const out: RangeItem[] = [];
	const cursors = new Map<EngineNode, RangeCursor>();
	for (const seg of segs) {
		let cur = cursors.get(seg.text);
		if (cur === undefined) cursors.set(seg.text, (cur = openRangeCursor(seg.text)));
		readRange(cur, seg.i0, seg.i1, stats, out);
	}
	return out;
};

/**
 * A from-scratch ownership context over `given` (every text scanned; the
 * index's oracle): each block's claims are its implicit ones, then the claim
 * items of its stream.
 */
export const computeOwnership = (_doc: EngineDoc, given: ReadonlyMap<BlockId, TextBlockRec>) => {
	const rows: TextRow[] = [];
	for (const rec of given.values()) if (rec.content) rows.push(scanText(rec.id, rec.content));
	const delim = delimiters(given, rows);
	const streams = new Map<BlockId, Stream>();
	const inText = new Map<BlockId, Stream[]>();
	const rowOf = new Map<EngineNode, TextRow>();
	for (const row of rows) {
		const list = placeText(row, delim);
		inText.set(row.home, list);
		rowOf.set(row.text, row);
		for (const s of list) streams.set(s.block, s);
	}
	const blocks = new Map<BlockId, TextBlockRec>();
	for (const [id, rec] of given) {
		const s = streams.get(id);
		const items = s === undefined ? [] : claimsIn(rowOf.get(s.text)!, s);
		blocks.set(id, { ...rec, claims: [...(rec.implicit ?? []), ...items] });
	}
	const { owners, top } = claimGraph(blocks);
	const ownerOf = (b: BlockId): Owner => owners.get(b) ?? DEAD;
	const own: Ownership = {
		ownerOf,
		hidden: (b) => ownerOf(b) !== b,
		top: (m) => top.get(m),
		streamOf: (b) => streams.get(b),
		streamsIn: (home) => inText.get(home) ?? [],
		streamAt: (home, i) => (inText.get(home) ?? []).find((x) => x.start <= i && i <= x.end),
		display: (b) => displayOf(b, blocks, own)
	};
	return own;
};

/** `b`'s display pieces (`[]` when hidden or streamless and claimless). */
export const flatten = (b: BlockId, blocks: unknown, own: Ownership): Seg[] => {
	void blocks;
	return own.display(b) ?? [];
};

export const contentItemsOf = (b: BlockId, blocks: unknown, own: Ownership): RangeItem[] =>
	readSegs(flatten(b, blocks, own));

export const blockTextOf = (b: BlockId, blocks: unknown, own: Ownership): string =>
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
export const insertIntoText = (
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
	if (typeof payload !== 'string') return text.insertInGap(hit.idx, [payload]);
	text.insertInGap(hit.idx, payload);
	const at = openRangeCursor(text).read(hit.idx, hit.idx + payload.length);
	const have = at.find((p) => !p.deleted && p.len > 0)?.formats;
	fitMarks(doc, text, hit.idx, payload.length, have, marks);
};

/**
 * The per-stream delete: each range lies inside one stream's pieces, so no
 * boundary is ever removed. The text is held by this writer's record (fork
 * patch YP20, root `textdel`, in the history's scope): an undo deletes the
 * record and the text shows again where it was, unless another writer's
 * record holds it. Text the open undo step inserted is removed instead, so
 * that step's undo still changes nothing.
 */
export const deleteRange = (
	doc: EngineDoc,
	blocks: unknown,
	own: Ownership,
	b: BlockId,
	offset: number,
	length: number
): void => {
	const records = doc.get(TEXT_DELETES_ROOT);
	const fresh = openInserts(doc);
	for (const r of rangesOf(flatten(b, blocks, own), offset, offset + length))
		r.text.delete(r.a, r.b - r.a, records, fresh);
};

export const formatRangeIn = (
	doc: EngineDoc,
	blocks: unknown,
	own: Ownership,
	b: BlockId,
	offset: number,
	length: number,
	formats: Record<string, unknown>
): void => {
	for (const r of rangesOf(flatten(b, blocks, own), offset, offset + length))
		writeMarks(doc, r.text, r.a, r.b - r.a, formats);
};

/**
 * Delete the content of streams `streams` (the room's purge of a
 * block deleted past the horizon): every piece, so no boundary goes and
 * each stream still delimits, writing no delete mark.
 * Streams of one text are deleted from its end, so the indices the
 * caller read stay valid.
 */
export const purgeStreams = (streams: readonly Stream[]): void => {
	const ordered = [...streams].sort((a, b) => b.start - a.start);
	for (const s of ordered) {
		const parts = pieces(s).filter(([a, b]) => b > a);
		for (let i = parts.length - 1; i >= 0; i--) {
			const [a, b] = parts[i];
			s.text.delete(a, b - a);
		}
	}
};

/** The inline atom `inlineId` in `b`'s display: its text, engine index and node. */
export const findAtom = (own: Ownership, b: BlockId, inlineId: string) => {
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

/** A backing text's writes at the end of a gap (fork patch YP7). */
type GapText = EngineNode & { insertAtGapEnd(i: number, c: unknown[]): void };

/**
 * Split `b`'s display at `offset` for the new block `newId` (incarnation
 * `n`): one boundary through fork patch YP7 at the end of the gap. The
 * claims that follow the split point — every claim of the stream's own
 * block, then each holder's claims after the one that led down — are
 * written again, in that order, at the end of the new block's stream, and
 * their items deleted (an implicit claim is written on the new block, whose
 * claim outranks it). No text is copied.
 */
export const splitAt = (
	doc: EngineDoc,
	blocks: ReadonlyMap<BlockId, TextBlockRec>,
	own: Ownership,
	b: BlockId,
	offset: number,
	newId: BlockId,
	n: number
): void => {
	const segs = flatten(b, blocks, own);
	const hit = locate(segs, Math.max(0, Math.min(offset, ownedLength(segs))));
	if (hit === null) throw new Error(`splitAt: "${b}" has no stream`);
	const { seg, idx } = hit;
	const moved = [...blocks.get(seg.block)!.claims];
	for (let i = seg.path.length - 1; i >= 0; i--)
		moved.push(...blocks.get(seg.path[i].holder)!.claims.slice(seg.path[i].entry + 1));
	const text = seg.text as GapText;
	// The new block's stream ends where the source's did, one boundary later.
	const end = own.streamOf(seg.block)!.end + 1;
	text.insertAtGapEnd(idx, [{ s: newId, n } satisfies Boundary]);
	if (moved.length === 0) return;
	text.insertAtGapEnd(
		end,
		moved.map((c) => ({ m: c.m }) satisfies MergeClaim)
	);
	deleteClaims(doc, moved);
};

/**
 * Merge `from` into `into`: one claim item `{m: from}` at the end of the gap
 * at the end of `into`'s stream (fork patch YP7; YP21 sorts it after the
 * content and boundaries a concurrent writer puts at its origin, so a split
 * the merge's writer did not see leaves it in the piece that ends `into`'s
 * region: `merge.claim.anchor`). `into` has a stream: the caller gives a
 * streamless block its own text first.
 */
export const claimInto = (own: Pick<Ownership, 'streamOf'>, from: BlockId, into: BlockId): void => {
	const s = own.streamOf(into)!;
	(s.text as GapText).insertAtGapEnd(s.end, [{ m: from } satisfies MergeClaim]);
};

/** Delete the items of `claims` (an implicit claim has none). */
export const deleteClaims = (doc: EngineDoc, claims: readonly Claim[]): void => {
	const store = storeOf(doc);
	for (const { stamp } of claims) {
		if (stamp.c < 0 || store.getItem({ client: stamp.c, clock: stamp.k }).deleted) continue;
		const at = Y.indexOfId(asYDoc(doc), Y.createID(stamp.c, stamp.k))!;
		(at.type as unknown as EngineNode).delete(at.index, 1);
	}
};

/**
 * Give streamless block `rec` its own text and re-mint its nonce, so a late
 * copy of its old boundary is inert. Both writes carry a writer id
 * derived from the block's node and its dead incarnation, so replicas that
 * type into the block concurrently write the SAME items and both typings
 * land in one text (the seed writer's mechanism). Returns the nonce
 * change (the caller moves the block's attribution record with it).
 */
export const ownText = (doc: EngineDoc, rec: TextBlockRec): { from: unknown; to: number } => {
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

/**
 * The text engine as one object (the public binding's `text`): the reads
 * and writes above. Edytor's own modules import them directly.
 */
export const bindText = (_Y: EngineApi) => ({
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
});

/**
 * The items this replica wrote with a derived own-text writer (local only): a
 * history step never captures them, so undoing the first typing removes the
 * typing and keeps the text every replica shares.
 */
export const ownTextIds = new WeakMap<EngineDoc, IdSetOf>();

/**
 * Each history's open step on a doc (`doc/history.ts` registers them): what
 * the step still capturing inserted, `null` when none is open.
 */
export const openSteps = new WeakMap<EngineDoc, Set<() => IdSetOf | null>>();

/**
 * What this writer inserted in the open undo steps of `doc` (`null`: none):
 * a history capturing a peer's frames (the room's validation) opens steps of
 * that peer's writes, never fresh here.
 */
const openInserts = (doc: EngineDoc): IdSetOf | null => {
	let fresh: IdSetOf | null = null;
	for (const open of openSteps.get(doc) ?? []) {
		const ranges = open()?.clients.get(doc.clientID);
		if (ranges === undefined) continue;
		fresh ??= ops.idSet();
		for (const r of ranges.getIds()) fresh.add(doc.clientID, r.clock, r.len);
	}
	return fresh;
};

export type TextEngine = ReturnType<typeof bindText>;
