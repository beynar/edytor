/**
 * Text ownership (R2, plan §2.1) — streams delimited by boundary items.
 *
 * Every block created fresh owns a *backing text* (`content` node) whose items
 * are never moved or copied. A split inserts one BOUNDARY ITEM `{s, n}` (one
 * countable unit, never displayed: "block `s`, incarnation `n`, starts right
 * after me") at the end of the gap at the split point (engine primitive P7),
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
 * Anchors (R4) are `{b, a}`: `b` the home block of the backing text, `a` an
 * engine relative position (`i` the bound item, `a` the side: `< 0` left). A
 * left-affine caret at a split-born block's start binds its boundary item.
 */
import type { EngineApi, EngineDoc, EngineNode, YDoc, YNode } from '../engine-api.js';
import { CONTENT, CONTENT_NODE, DATA, ID, NONCE, SCHEMA, TYPE } from '../schema.js';
import { DEV } from 'esm-env';
import { hash32, hash53 } from '../rand.js';
import { bindDeletes, type Span } from './deletes.js';

export type BlockId = string;

/** A serialized relative position inside a backing text (`i: null`: a text end). */
export type Anchor = { i: { c: number; k: number } | null; a: number };

/** Merge-claim payload: "this block's display continues with block `m`'s". */
export type MergeClaim = { m: BlockId };
export const isMergeClaim = (v: unknown): v is MergeClaim =>
	v != null && typeof v === 'object' && typeof (v as MergeClaim).m === 'string';

/** Deterministic claim stamp = engine item id (client-major order). */
export type Stamp = { c: number; k: number };
export const cmpStamp = (a: Stamp, b: Stamp): number => a.c - b.c || a.k - b.k;

/** One live merge claim of a `claims` list; `seqIndex` is its live index there. */
export type Claim = { m: BlockId; stamp: Stamp; seqIndex: number };

/** Boundary-item payload in a backing text. */
export type Boundary = { s: BlockId; n: unknown };
export const isBoundary = (v: unknown): v is Boundary =>
	v != null && typeof v === 'object' && typeof (v as Boundary).s === 'string' && 'n' in v;

/** Structural item for sequence walks (`node._start`). */
export type SeqItem = {
	id: { client: number; clock: number };
	length: number;
	deleted: boolean;
	countable?: boolean;
	right: SeqItem | null;
	content: { getContent(): unknown[]; str?: string; arr?: unknown[]; type?: EngineNode };
};

export const nodeStart = (node: EngineNode): SeqItem | null =>
	(node as unknown as { _start?: SeqItem | null })._start ?? null;

/** The live merge claims of a `claims` list, with their stamps. */
export const readClaims = (node: EngineNode | undefined): Claim[] => {
	const out: Claim[] = [];
	let seqIndex = 0;
	for (let it = node ? nodeStart(node) : null; it !== null; it = it.right) {
		if (it.deleted || it.countable === false) continue;
		const arr = it.content.getContent();
		for (let j = 0; j < it.length; j++) {
			const p = arr[j];
			if (isMergeClaim(p))
				out.push({ m: p.m, stamp: { c: it.id.client, k: it.id.clock + j }, seqIndex });
			seqIndex++;
		}
	}
	return out;
};

// ── bounded formatted range reads ────────────────────────────────────
//
// Reads go through the vendored `Y.RangeCursor` (P5): it walks the live item
// list with the same `readItemPieces` dispatch `toDelta` consumes and seeds
// itself from the engine's search-marker checkpoints, so a read costs the
// checkpoint gap plus the range. Emitted `marks` ALIAS the cursor's format
// state: consumers treat them as read-only (the index interns them).

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

const marksEqual = (
	a: Record<string, unknown> | undefined,
	b: Record<string, unknown> | undefined
): boolean => a === b || (a !== undefined && b !== undefined && canonKey(a) === canonKey(b));

/** Recursively freeze a JSON payload (the interners' canonical copies). */
export const deepFreeze = <T>(v: T): T => {
	if (v !== null && typeof v === 'object') {
		for (const k of Object.keys(v as Record<string, unknown>))
			deepFreeze((v as Record<string, unknown>)[k]);
		Object.freeze(v);
	}
	return v;
};

/**
 * Publication boundary for range-read items (R4): a text item's `marks` can
 * alias the cursor's format state and an inline item's `data` IS the
 * replicated attr object, so each payload is swapped for `intern`'s frozen
 * canonical copy before it leaves the document layer.
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

/** One inline-atom element → its `ContentItem` shape. */
export const inlineItemOf = (entry: unknown): RangeItem => {
	const node = entry as EngineNode;
	const data = node.getAttr(DATA);
	return {
		kind: 'inline',
		id: node.getAttr(ID) as string,
		type: node.getAttr(TYPE) as string,
		...(data === undefined ? {} : { data: data as Record<string, unknown> })
	};
};

/**
 * Read `[i0, i1)` through the cursor: text pieces as UTF-16 slices under their
 * folded marks (adjacent equal marks merge), inline atoms one item each.
 * Boundary items are skipped — the one read predicate R2 needs.
 */
export const readRange = (
	cur: RangeCursor,
	i0: number,
	i1: number,
	stats?: RangeReadStats,
	items: RangeItem[] = []
): RangeItem[] => {
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
				items.push({ kind: 'text', text: slice, ...(marks === undefined ? {} : { marks }) });
			}
		} else if (typeof c.getContent === 'function') {
			const arr = c.getContent();
			for (let k = piece.offset; k < piece.offset + piece.len; k++) {
				if (!isBoundary(arr[k])) items.push(inlineItemOf(arr[k]));
			}
		}
	}
	return items;
};

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
	/** Its live merge claims, in list order. */
	claims: Claim[];
};

/** The internal "no display owner" verdict — a symbol, never a block id. */
export const DEAD: unique symbol = Symbol('edytor.crdt.dead');
export type Owner = BlockId | typeof DEAD;

/**
 * The claim graph: `owners` — the block that displays each block (deleted →
 * `DEAD`; no claim → itself; else the max-stamp live claimer's owner; a
 * cycle resolves to the claimer of its max-stamp edge) — and `top`, each
 * claimed block's max-stamp live claimer. Claims held by deleted blocks are
 * inert (a concurrent merge into a deleted block is voided, ST02b).
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

/** Scan `text` (live space, renderer-free) for its boundary items. */
export const scanText = (home: BlockId, text: EngineNode): TextRow => {
	const bounds: Bound[] = [];
	let at = 0;
	for (let it = nodeStart(text); it !== null; it = it.right) {
		if (it.deleted || it.countable === false) continue;
		const arr = it.content.arr;
		if (arr !== undefined) {
			for (let j = 0; j < it.length; j++) {
				const v = arr[j];
				if (isBoundary(v))
					bounds.push({ s: v.s, n: v.n, at: at + j, key: `${it.id.client}:${it.id.clock + j}` });
			}
		}
		at += it.length;
	}
	return { home, text, bounds, len: at, key: bounds.map((b) => b.key).join(',') };
};

const byId = (a: string, b: string): number => {
	const [ac, ak] = a.split(':').map(Number);
	const [bc, bk] = b.split(':').map(Number);
	return ac - bc || ak - bk;
};

/** Each block's delimiting boundary: the lowest-id live boundary whose nonce matches its record. */
export const delimiters = (
	blocks: ReadonlyMap<BlockId, Pick<TextBlockRec, 'n'>>,
	rows: Iterable<TextRow>
): Map<BlockId, string> => {
	const out = new Map<BlockId, string>();
	for (const row of rows) {
		for (const b of row.bounds) {
			if (blocks.get(b.s)?.n !== b.n) continue;
			const cur = out.get(b.s);
			if (cur === undefined || byId(b.key, cur) < 0) out.set(b.s, b.key);
		}
	}
	return out;
};

/** The streams of one text, in text order: the home's head (unless delimited elsewhere), then one per delimiting boundary. */
export const placeText = (row: TextRow, delim: ReadonlyMap<BlockId, string>): Stream[] => {
	const cuts = row.bounds.filter((b) => delim.get(b.s) === b.key);
	const heads: { block: BlockId | null; start: number }[] = [
		{ block: delim.has(row.home) ? null : row.home, start: 0 },
		...cuts.map((b) => ({ block: b.s, start: b.at + 1 }))
	];
	const out: Stream[] = [];
	heads.forEach((h, i) => {
		const end = i + 1 < heads.length ? heads[i + 1].start - 1 : row.len;
		if (h.block === null) return;
		const inert = row.bounds.filter((b) => b.at >= h.start && b.at < end).map((b) => b.at);
		out.push({ block: h.block, home: row.home, text: row.text, start: h.start, end, inert });
	});
	return out;
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
	/** `display(b)` as boundary-free pieces in reading order; `null` when hidden or dead. */
	display: (b: BlockId) => Seg[] | null;
};

/** A stream's content pieces: the range minus its inert boundaries (at least one piece). */
export const pieces = (s: Stream): [number, number][] => {
	const out: [number, number][] = [];
	let a = s.start;
	for (const x of [...s.inert, s.end]) {
		if (x > a || out.length === 0) out.push([a, x]);
		a = x + 1;
	}
	return out;
};

/**
 * `display(b)`: `b`'s stream, then each effective claim's display, in claim
 * order. `track(x, home)` reports every walked block and the home of its
 * stream (the index's dependency capture). `null` when `b` is hidden, unless
 * `hidden` asks for the pieces a hidden block would show (an anchor minted in
 * a merged-away or deleted block binds its items all the same).
 */
export const displayOf = (
	b: BlockId,
	blocks: ReadonlyMap<BlockId, TextBlockRec>,
	own: Pick<Ownership, 'ownerOf' | 'top' | 'streamOf'>,
	track?: (x: BlockId, home: BlockId | undefined) => void,
	hidden = false
): Seg[] | null => {
	if (!hidden && own.ownerOf(b) !== b) return null;
	const out: Seg[] = [];
	const seen = new Set<BlockId>();
	const walk = (x: BlockId, path: Seg['path']): void => {
		seen.add(x);
		const s = own.streamOf(x);
		track?.(x, s?.home);
		if (s !== undefined) {
			for (const [i0, i1] of pieces(s))
				out.push({ t: s.home, text: s.text, block: x, i0, i1, path });
		}
		blocks.get(x)?.claims.forEach((c, entry) => {
			const r = blocks.get(c.m);
			if (r === undefined || r.deleted || seen.has(c.m) || own.top(c.m) !== x) return;
			walk(c.m, [...path, { holder: x, entry }]);
		});
	};
	walk(b, []);
	return out;
};

export const ownedLength = (segs: readonly Seg[]): number =>
	segs.reduce((n, s) => n + s.i1 - s.i0, 0);

/**
 * Display offset → piece + engine index. `left` (typing: left wins at a seam)
 * takes the first piece whose end reaches `k`; `right` the piece holding the
 * unit at `k` (the last piece at the display end). `null` for an empty display.
 */
export const locate = (segs: readonly Seg[], k: number, side: 'left' | 'right' = 'left') => {
	let acc = 0;
	for (let i = 0; i < segs.length; i++) {
		const len = segs[i].i1 - segs[i].i0;
		const last = i === segs.length - 1;
		if (side === 'left' ? k <= acc + len : k < acc + len || (last && k === acc + len)) {
			return { seg: segs[i], idx: segs[i].i0 + Math.max(0, k - acc) };
		}
		acc += len;
	}
	return null;
};

/** `[k0, k1)` of a display as engine ranges, rightmost first (indices stay valid while writing). */
const rangesOf = (segs: readonly Seg[], k0: number, k1: number) => {
	const out: { text: EngineNode; a: number; b: number }[] = [];
	let acc = 0;
	for (const s of segs) {
		const len = s.i1 - s.i0;
		const lo = Math.max(k0, acc);
		const hi = Math.min(k1, acc + len);
		if (hi > lo) out.push({ text: s.text, a: s.i0 + lo - acc, b: s.i0 + hi - acc });
		acc += len;
	}
	return out.sort((x, y) => y.a - x.a);
};

/** Every write addresses live-content space: a renderer on a backing text is a read concern. */
const plain = <T>(text: EngineNode, f: () => T): T => {
	const t = text as unknown as { _renderer: unknown };
	const r = t._renderer;
	t._renderer = null;
	try {
		return f();
	} finally {
		t._renderer = r;
	}
};

export const bindText = (Y: EngineApi) => {
	const D = bindDeletes(Y);
	const newNode = (name: string): EngineNode => new Y.Node(name) as unknown as EngineNode;

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
			doc as unknown as YDoc,
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
			Y.createRelativePositionFromTypeIndex(text as unknown as YNode, index, assoc)
		) as { item?: { client: number; clock: number } };
		return {
			i: json.item ? { c: json.item.client, k: json.item.clock } : null,
			a: assoc < 0 ? -1 : 0
		};
	};

	/** A renderer-free bounded read cursor on `text` (live-content space). */
	const openRangeCursor = (text: EngineNode): RangeCursor =>
		new Y.RangeCursor(text as unknown as YNode, null) as unknown as RangeCursor;

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
	const computeOwnership = (doc: EngineDoc, blocks: ReadonlyMap<BlockId, TextBlockRec>) => {
		void doc;
		const rows: TextRow[] = [];
		for (const rec of blocks.values()) if (rec.content) rows.push(scanText(rec.id, rec.content));
		const delim = delimiters(blocks, rows);
		const streams = new Map<BlockId, Stream>();
		const inText = new Map<BlockId, Stream[]>();
		for (const row of rows) {
			const list = placeText(row, delim);
			inText.set(row.home, list);
			for (const s of list) streams.set(s.block, s);
		}
		const { owners, top } = claimGraph(blocks);
		const ownerOf = (b: BlockId): Owner => owners.get(b) ?? DEAD;
		const own: Ownership = {
			ownerOf,
			hidden: (b) => ownerOf(b) !== b,
			top: (m) => top.get(m),
			streamOf: (b) => streams.get(b),
			streamsIn: (home) => inText.get(home) ?? [],
			display: (b) => displayOf(b, blocks, own)
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
	 * its own text first ({@link ownText}).
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
		void doc;
		const segs = flatten(b, blocks, own);
		const hit = locate(segs, Math.max(0, Math.min(offset, ownedLength(segs))));
		if (hit === null) throw new Error(`insertIntoText: "${b}" has no stream`);
		const { text } = hit.seg;
		plain(text, () =>
			typeof payload === 'string'
				? text.insert(hit.idx, payload, marks)
				: text.insert(hit.idx, [payload])
		);
	};

	/** The per-stream delete: each range lies inside one stream's pieces, so no boundary is ever removed (A-1). */
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
		void doc;
		for (const r of rangesOf(flatten(b, blocks, own), offset, offset + length))
			plain(r.text, () => r.text.format(r.a, r.b - r.a, formats));
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
	 * `n`): one boundary through P7 at the end of the gap, and the claims that
	 * follow the split point — every claim of the stream's own block, then each
	 * holder's claims after the one that led down — returned for re-insertion
	 * on the new block and deleted from their holders (D-21). No text is copied.
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
		const moved: { holder: BlockId; seqIndex: number; m: BlockId }[] = [];
		const after = (holder: BlockId, from: number) =>
			blocks
				.get(holder)!
				.claims.slice(from)
				.forEach((c) => moved.push({ holder, seqIndex: c.seqIndex, m: c.m }));
		after(seg.block, 0);
		for (let i = seg.path.length - 1; i >= 0; i--) after(seg.path[i].holder, seg.path[i].entry + 1);
		const text = seg.text as EngineNode & { insertAtGapEnd(i: number, c: unknown[]): void };
		plain(text, () => text.insertAtGapEnd(idx, [{ s: newId, n } satisfies Boundary]));
		const byHolder = new Map<BlockId, number[]>();
		for (const c of moved) byHolder.set(c.holder, [...(byHolder.get(c.holder) ?? []), c.seqIndex]);
		for (const [holder, idxs] of byHolder) {
			const list = blocks.get(holder)!.claimsNode!;
			for (const i of idxs.sort((x, y) => y - x)) list.delete(i, 1);
		}
		return moved.map((c) => ({ m: c.m }));
	};

	/** Append a merge claim `{m: from}` to `into`'s claims list. */
	const claimInto = (
		blocks: ReadonlyMap<BlockId, TextBlockRec>,
		from: BlockId,
		into: BlockId
	): void => {
		const list = blocks.get(into)!.claimsNode!;
		list.insert(list.length, [{ m: from } satisfies MergeClaim]);
	};

	/**
	 * Give streamless block `rec` its own text and re-mint its nonce, so a late
	 * copy of its old boundary is inert (F9). Both writes carry a writer id
	 * derived from the block's node and its dead incarnation, so replicas that
	 * type into the block concurrently write the SAME items and both typings
	 * land in one text (the seed writer's mechanism, R13). Returns the nonce
	 * change (the caller moves the block's attribution record with it).
	 */
	const ownText = (doc: EngineDoc, rec: TextBlockRec): { from: unknown; to: number } => {
		const map = (rec.node as unknown as { _map: Map<string, unknown> })._map;
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
		const store = (doc as unknown as { store: { getClock(c: number): number } }).store;
		// The derivation is fresh per incarnation: a writer that already wrote
		// here is another block's (a hash collision — R13's residual class).
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
		const ids = ownTextIds.get(doc) ?? Y.createIdSet();
		ownTextIds.set(doc, ids);
		const clock = store.getClock(writer);
		(ids as unknown as { add(c: number, k: number, l: number): void }).add(writer, clock - 2, 2);
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
export const ownTextIds = new WeakMap<EngineDoc, unknown>();

export type TextEngine = ReturnType<typeof bindText>;
