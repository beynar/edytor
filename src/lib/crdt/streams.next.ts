/**
 * D11 SPIKE — stream boundaries (plan §2.1, R2). Temporary, counted, removed at
 * D12 (the switch or the fallback). Nothing in production imports this module;
 * the D11 tests drive it through `src/tests/crdt/harness/ops/stream-ops.ts`.
 *
 * Replicated layout (same registry, placement and delete marks as today):
 * - a block's `content` is its own backing text; a split-born block has none;
 * - a BOUNDARY ITEM `{s, n}` (one countable unit, never displayed) in a
 *   backing text says "block `s`, incarnation `n`, starts right after me";
 * - `slices` holds merge claims `{m}` only (slice records are ignored).
 *
 * `stream(b)` starts after `b`'s live boundary whose `n` equals `b`'s record
 * nonce, else at index 0 of `b`'s own text, else it is empty; it ends at the
 * next live nonce-matching boundary of the same text, or at the text end. A
 * boundary whose nonce does not match is inert: skipped by reads, never a
 * delimiter. `display(b) = stream(b)` then `display(m)` for each claim `{m}`
 * whose max-stamp live claimer is `b`. Everything below is a pure function of
 * replicated items; no write ever repairs ownership.
 */
import type { EngineApi, EngineDoc, EngineNode } from './engine-api.js';
import {
	bindModel,
	childrenIndex,
	candidatesOf,
	displayParentOf,
	documentOrder,
	isLiveIn,
	resolvePlacements,
	type BlockRec,
	type BlockSpec,
	type ContentItem,
	type Destination,
	type InlineSpec,
	type ModelView,
	type ProjectedBlock,
	type ProjectedDoc
} from './placement/model.js';
import {
	canonKey,
	cmpStamp,
	computeOwners,
	DEAD,
	isMergeClaim,
	readSliceEntries,
	type Owner,
	type Ownership,
	type Stamp
} from './text/model.js';
import {
	AT,
	AT_NODE,
	BLOCK_NODE,
	CONTENT,
	CONTENT_NODE,
	DATA,
	DEL_PREFIX,
	hasDeleteMark,
	ID,
	NONCE,
	REGISTRY_KEY,
	SLICES,
	SLICES_NODE,
	TYPE
} from './schema.js';
import { nonceOf, randOf } from './rand.js';
import { cloneJson } from '../utils/json.js';

type BlockId = string;
type Item = {
	id: { client: number; clock: number };
	length: number;
	deleted: boolean;
	countable: boolean;
	right: Item | null;
	content: { str?: string; key?: string; value?: unknown; arr?: unknown[]; type?: EngineNode };
};
type TextNode = EngineNode & {
	_start: Item | null;
	_renderer: unknown;
	insertAtGapEnd(index: number, content: unknown[]): void;
};
export type Boundary = { s: BlockId; n: number };
export const isBoundary = (v: unknown): v is Boundary =>
	v != null && typeof v === 'object' && typeof (v as Boundary).s === 'string' && 'n' in v;

/** A live boundary at engine index `at` of its text; `clock` is its unit's id clock. */
type Bound = Boundary & { at: number; item: Item; clock: number };
/** One stream: `[start, end)` of `text`, minus the inert boundaries at `inert`. */
export type Stream = {
	block: BlockId;
	text: TextNode;
	start: number;
	end: number;
	inert: number[];
};
/** A displayed piece: `[i0, i1)` of `text` holds content only; `block` is its stream. */
export type Seg = { text: TextNode; block: BlockId; i0: number; i1: number; path: ClaimStep[] };
type ClaimStep = { holder: BlockId; entry: number };
type SRec = BlockRec & { n: unknown; claims: { m: BlockId; stamp: Stamp; seqIndex: number }[] };

export type StreamView = Pick<ModelView, 'placements' | 'own'> & {
	blocks: Map<BlockId, SRec>;
	kids: ModelView['kids'];
	order: ModelView['order'];
	/** block → its stream (absent: streamless). */
	streams: Map<BlockId, Stream>;
	/** backing text → its streams in text order, and its home block. */
	texts: Map<TextNode, { home: BlockId; streams: Stream[]; bounds: Bound[]; len: number }>;
	/** claimed block → its max-stamp live claimer. */
	top: Map<BlockId, BlockId>;
};

const isNodeLike = (v: unknown): v is EngineNode =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

/** Every write addresses live-content space: a renderer on a backing text is a read concern. */
const plain = <T>(text: TextNode, f: () => T): T => {
	const r = text._renderer;
	text._renderer = null;
	try {
		return f();
	} finally {
		text._renderer = r;
	}
};

export const bindStreams = (Y: EngineApi) => {
	const M = bindModel(Y);
	const newNode = (name: string): EngineNode => new Y.Node(name) as unknown as EngineNode;

	// ── the view: records, streams, owners, placements ───────────────────

	const view = (doc: EngineDoc): StreamView => {
		const blocks = new Map<BlockId, SRec>();
		doc.get(REGISTRY_KEY).forEachAttr((node, id) => {
			if (!isNodeLike(node)) return;
			const slicesNode = node.getAttr(SLICES);
			const entries = isNodeLike(slicesNode) ? readSliceEntries(slicesNode) : [];
			const content = node.getAttr(CONTENT);
			blocks.set(id, {
				id,
				node,
				type: node.getAttr(TYPE) as string,
				data: node.getAttr(DATA),
				n: node.getAttr(NONCE),
				deleted: hasDeleteMark(node),
				content: isNodeLike(content) ? content : undefined,
				slicesNode: isNodeLike(slicesNode) ? slicesNode : undefined,
				entries,
				claims: entries.flatMap((e) =>
					isMergeClaim(e.payload) ? [{ m: e.payload.m, stamp: e.stamp, seqIndex: e.seqIndex }] : []
				),
				cands: candidatesOf(node)
			});
		});
		// Boundaries: live, and the first nonce-matching one per block delimits.
		const texts: StreamView['texts'] = new Map();
		const delim = new Map<BlockId, Bound>();
		for (const rec of blocks.values()) {
			if (rec.content === undefined) continue;
			const text = rec.content as TextNode;
			const bounds: Bound[] = [];
			let at = 0;
			for (let it = text._start; it !== null; it = it.right) {
				if (it.deleted || !it.countable) continue;
				const arr = it.content.arr;
				if (arr !== undefined) {
					arr.forEach((v, j) => {
						if (!isBoundary(v)) return;
						const b: Bound = { s: v.s, n: v.n, at: at + j, item: it, clock: it.id.clock + j };
						bounds.push(b);
						if (!delim.has(v.s) && blocks.get(v.s)?.n === v.n) delim.set(v.s, b);
					});
				}
				at += it.length;
			}
			texts.set(text, { home: rec.id, streams: [], bounds, len: at });
		}
		const streams = new Map<BlockId, Stream>();
		for (const [text, t] of texts) {
			const cuts = t.bounds.filter((b) => delim.get(b.s) === b);
			const heads: { block: BlockId | null; start: number }[] = [
				{ block: delim.has(t.home) ? null : t.home, start: 0 },
				...cuts.map((b) => ({ block: b.s, start: b.at + 1 }))
			];
			heads.forEach((h, i) => {
				const end = i + 1 < heads.length ? heads[i + 1].start - 1 : t.len;
				if (h.block === null) return;
				const inert = t.bounds
					.filter((b) => delim.get(b.s) !== b && b.at >= h.start && b.at < end)
					.map((b) => b.at);
				const s: Stream = { block: h.block, text, start: h.start, end, inert };
				t.streams.push(s);
				streams.set(h.block, s);
			});
		}
		// Claims: today's owner graph over `{m}` claims (deleted claimers are inert).
		const owners = computeOwners(blocks);
		const ownerOf = (b: BlockId): Owner => owners.get(b) ?? DEAD;
		const own = { ownerOf, hidden: (b: BlockId) => ownerOf(b) !== b } as unknown as Ownership;
		const top = new Map<BlockId, BlockId>();
		const topStamp = new Map<BlockId, Stamp>();
		for (const rec of blocks.values()) {
			if (rec.deleted) continue;
			for (const c of rec.claims) {
				const best = topStamp.get(c.m);
				if (best === undefined || cmpStamp(c.stamp, best) > 0) {
					topStamp.set(c.m, c.stamp);
					top.set(c.m, rec.id);
				}
			}
		}
		const placements = resolvePlacements(blocks, ownerOf);
		const kids = childrenIndex(placements, own);
		return { blocks, own, placements, kids, order: documentOrder(kids), streams, texts, top };
	};

	/** Content pieces of a stream: the range minus its inert boundaries (at least one piece). */
	const pieces = (s: Stream): [number, number][] => {
		const out: [number, number][] = [];
		let a = s.start;
		for (const x of [...s.inert, s.end]) {
			if (x > a || out.length === 0) out.push([a, x]);
			a = x + 1;
		}
		return out.filter(([i0, i1], k) => k === 0 || i1 > i0);
	};

	/** `display(b)` as content pieces in reading order, or null when hidden. */
	const display = (v: StreamView, b: BlockId): Seg[] | null => {
		if (v.own.ownerOf(b) !== b) return null;
		const out: Seg[] = [];
		const seen = new Set<BlockId>();
		const walk = (x: BlockId, path: ClaimStep[]): void => {
			seen.add(x);
			const s = v.streams.get(x);
			if (s !== undefined) {
				for (const [i0, i1] of pieces(s)) out.push({ text: s.text, block: x, i0, i1, path });
			}
			v.blocks.get(x)!.claims.forEach((c, entry) => {
				const r = v.blocks.get(c.m);
				if (r === undefined || r.deleted || seen.has(c.m) || v.top.get(c.m) !== x) return;
				walk(c.m, [...path, { holder: x, entry }]);
			});
		};
		walk(b, []);
		return out;
	};

	const lengthOf = (segs: Seg[]): number => segs.reduce((n, s) => n + s.i1 - s.i0, 0);

	/**
	 * Display offset → piece + engine index. `left` (the default: typing, left
	 * wins at a seam) takes the first piece whose end reaches `k`; `right` the
	 * piece holding the character at `k` (the last piece at the display end).
	 */
	const locate = (segs: Seg[], k: number, side: 'left' | 'right' = 'left') => {
		let acc = 0;
		for (let i = 0; i < segs.length; i++) {
			const len = segs[i].i1 - segs[i].i0;
			const last = i === segs.length - 1;
			if (side === 'left' ? k <= acc + len : k < acc + len || (last && k === acc + len)) {
				return { seg: segs[i], idx: segs[i].i0 + (k - acc) };
			}
			acc += len;
		}
		return null;
	};

	const live = (v: StreamView, id: BlockId): boolean => isLiveIn(v, id);

	// ── reads ───────────────────────────────────────────────────────────

	/** Items of `[i0, i1)` of `text` (formats folded from the text start; boundaries skipped). */
	const readRange = (text: TextNode, i0: number, i1: number, out: ContentItem[]): void => {
		let at = 0;
		let formats: Record<string, unknown> = {};
		for (let it = text._start; it !== null && at < i1; it = it.right) {
			if (it.deleted) continue;
			const c = it.content;
			if (!it.countable) {
				if (typeof c.key === 'string') {
					formats = { ...formats };
					if (c.value == null) delete formats[c.key];
					else formats[c.key] = c.value;
				}
				continue;
			}
			const lo = Math.max(i0, at) - at;
			const hi = Math.min(i1, at + it.length) - at;
			if (hi > lo) {
				if (typeof c.str === 'string') {
					const marks = Object.keys(formats).length > 0 ? formats : undefined;
					const last = out[out.length - 1];
					const text = c.str.slice(lo, hi);
					if (last?.kind === 'text' && canonKey(last.marks) === canonKey(marks)) last.text += text;
					else out.push({ kind: 'text', text, ...(marks && { marks: cloneJson(marks) }) });
				} else if (c.type !== undefined) {
					const n = c.type;
					const data = n.getAttr(DATA) as Record<string, unknown> | undefined;
					out.push({
						kind: 'inline',
						id: n.getAttr(ID) as string,
						type: n.getAttr(TYPE) as string,
						...(data !== undefined && { data: cloneJson(data) })
					});
				}
			}
			at += it.length;
		}
	};

	const itemsOf = (v: StreamView, id: BlockId): ContentItem[] => {
		const out: ContentItem[] = [];
		for (const s of display(v, id) ?? []) readRange(s.text, s.i0, s.i1, out);
		return out;
	};

	const project = (doc: EngineDoc): ProjectedDoc => {
		const v = view(doc);
		const block = (id: BlockId): ProjectedBlock => {
			const rec = v.blocks.get(id)!;
			return {
				id,
				type: rec.type,
				data: rec.data == null ? undefined : (cloneJson(rec.data) as Record<string, unknown>),
				content: itemsOf(v, id),
				children: (v.kids.get(id) ?? []).map((k) => block(k.id))
			};
		};
		return { children: (v.kids.get(null) ?? []).map((k) => block(k.id)) };
	};

	const blockText = (doc: EngineDoc, id: BlockId): string | null => {
		const v = view(doc);
		if (!live(v, id)) return null;
		return itemsOf(v, id)
			.map((i) => (i.kind === 'text' ? i.text : ''))
			.join('');
	};

	const positionOf = (doc: EngineDoc, id: BlockId): Destination | null => {
		const v = view(doc);
		if (!live(v, id)) return null;
		const dp = displayParentOf(v.own, v.placements.get(id)!) as BlockId | null;
		const index = (v.kids.get(dp) ?? []).findIndex((k) => k.id === id);
		return index < 0 ? null : { parent: dp, index };
	};

	// ── structure ops (boolean verdicts, like the model oracle) ──────────

	const kidsOf = (v: StreamView, parent: BlockId | null) => [...(v.kids.get(parent) ?? [])];
	const ranks = (doc: EngineDoc, sibs: { rank: string }[], index: number, count: number) =>
		M.ranksAt(sibs, Math.max(0, Math.min(index, sibs.length)), count, doc.clientID, randOf(doc));

	const insertBlocks = (doc: EngineDoc, dest: Destination, specs: BlockSpec[]): boolean => {
		if (specs.length === 0) return true;
		const v = view(doc);
		if (dest.parent !== null && !live(v, dest.parent)) return false;
		if (M.collides(doc, specs)) return false;
		return doc.transact(() => {
			const r = ranks(doc, kidsOf(v, dest.parent), dest.index, specs.length);
			specs.forEach((sp, i) => M.materializeSpec(doc, sp, dest.parent, r[i]));
			return true;
		});
	};

	/** R3: the deleter's mark on the block and on everything it displays through claims. */
	const deleteBlock = (doc: EngineDoc, id: BlockId): boolean => {
		const v = view(doc);
		if (!live(v, id)) return false;
		return doc.transact(() => {
			for (const [b, rec] of v.blocks) {
				if (v.own.ownerOf(b) === id) rec.node.setAttr(DEL_PREFIX + doc.clientID, true);
			}
			return true;
		});
	};

	const moveBlocks = (doc: EngineDoc, ids: BlockId[], dest: Destination): boolean => {
		const v = view(doc);
		if (ids.length === 0 || ids.some((id) => !live(v, id))) return false;
		if (dest.parent !== null) {
			if (!live(v, dest.parent)) return false;
			if (ids.some((id) => M.isSelfOrDescendant(v.placements, v.own, dest.parent!, id)))
				return false;
		}
		return doc.transact(() => {
			const sibs = kidsOf(v, dest.parent).filter((k) => !ids.includes(k.id));
			const r = ranks(doc, sibs, dest.index, ids.length);
			ids.forEach((id, i) => M.writePlacement(doc, v.blocks.get(id)!.node, dest.parent, r[i]));
			return true;
		});
	};

	/**
	 * Split `id` at display offset `offset` into `newId`: one boundary through P7
	 * at the end of the gap, and the claims that follow the split point moved
	 * (re-inserted on `newId`, deleted from their holders). No text is copied.
	 */
	const splitBlock = (doc: EngineDoc, id: BlockId, offset: number, newId: BlockId): boolean => {
		if (M.blockNodeOf(doc, newId) !== null) return false;
		const v = view(doc);
		const segs = live(v, id) ? display(v, id) : null;
		if (segs === null || offset < 0 || offset > lengthOf(segs)) return false;
		const hit = locate(segs, offset);
		if (hit === null) return false; // streamless and claimless: nothing to split
		const { seg, idx } = hit;
		// Claims after the split point, in display order: all of the stream
		// block's, then each holder's after the step that led down to it.
		const moved: { holder: BlockId; seqIndex: number; m: BlockId }[] = [];
		const after = (holder: BlockId, from: number) =>
			v.blocks
				.get(holder)!
				.claims.slice(from)
				.forEach((c) => moved.push({ holder, seqIndex: c.seqIndex, m: c.m }));
		after(seg.block, 0);
		for (let i = seg.path.length - 1; i >= 0; i--) after(seg.path[i].holder, seg.path[i].entry + 1);
		const pos = positionOf(doc, id)!;
		const n = nonceOf(doc);
		return doc.transact(() => {
			const [rank] = ranks(doc, kidsOf(v, pos.parent), pos.index + 1, 1);
			const children = kidsOf(v, id);
			plain(seg.text, () => seg.text.insertAtGapEnd(idx, [{ s: newId, n }]));
			const src = v.blocks.get(id)!;
			const node = newNode(BLOCK_NODE);
			node.setAttr(ID, newId);
			node.setAttr(NONCE, n);
			node.setAttr(TYPE, src.type);
			if (src.data !== undefined) node.setAttr(DATA, cloneJson(src.data));
			const slices = newNode(SLICES_NODE);
			node.setAttr(SLICES, slices);
			if (moved.length > 0)
				slices.insert(
					0,
					moved.map((c) => ({ m: c.m }))
				);
			const at = newNode(AT_NODE);
			node.setAttr(AT, at);
			at.setAttr(`1.${doc.clientID}`, { p: pos.parent, r: rank });
			M.registryOf(doc).setAttr(newId, node);
			const byHolder = new Map<BlockId, number[]>();
			for (const c of moved)
				byHolder.set(c.holder, [...(byHolder.get(c.holder) ?? []), c.seqIndex]);
			for (const [holder, idxs] of byHolder) {
				const sl = v.blocks.get(holder)!.slicesNode!;
				for (const i of idxs.sort((a, b) => b - a)) sl.delete(i, 1);
			}
			const r = ranks(doc, [], 0, children.length);
			children.forEach((k, i) => M.writePlacement(doc, v.blocks.get(k.id)!.node, newId, r[i]));
			return true;
		});
	};

	const mergeBlocks = (doc: EngineDoc, fromId: BlockId, intoId: BlockId): boolean => {
		if (fromId === intoId) return false;
		const v = view(doc);
		if (!live(v, fromId) || !live(v, intoId)) return false;
		if (M.isSelfOrDescendant(v.placements, v.own, intoId, fromId)) return false;
		const into = v.blocks.get(intoId)!;
		if (into.slicesNode === undefined) return false;
		return doc.transact(() => {
			const intoKids = kidsOf(v, intoId);
			const fromKids = kidsOf(v, fromId);
			into.slicesNode!.insert(into.slicesNode!.length, [{ m: fromId }]);
			const r = ranks(doc, intoKids, intoKids.length, fromKids.length);
			fromKids.forEach((k, i) => M.writePlacement(doc, v.blocks.get(k.id)!.node, intoId, r[i]));
			return true;
		});
	};

	// ── content ops ─────────────────────────────────────────────────────

	/**
	 * Insert at a display offset: beside the boundary the engine walk and the
	 * side choose. A streamless block (its boundary died with its host text)
	 * gets its own text on first typing and re-mints `n`, so a late copy of the
	 * old boundary is inert (F9).
	 */
	const insertAt = (
		doc: EngineDoc,
		id: BlockId,
		offset: number,
		payload: string | EngineNode,
		marks?: Record<string, unknown>
	): boolean => {
		const v = view(doc);
		const segs = live(v, id) ? display(v, id) : null;
		if (segs === null) return false;
		if (payload === '') return true;
		const put = (text: TextNode, idx: number) =>
			plain(text, () =>
				typeof payload === 'string'
					? text.insert(idx, payload, marks ?? {})
					: text.insert(idx, [payload], marks ?? {})
			);
		return doc.transact(() => {
			if (segs.length === 0) {
				const node = v.blocks.get(id)!.node;
				const text = newNode(CONTENT_NODE) as TextNode;
				node.setAttr(NONCE, nonceOf(doc));
				node.setAttr(CONTENT, text);
				put(text, 0);
				return true;
			}
			const hit = locate(segs, Math.max(0, Math.min(offset, lengthOf(segs))))!;
			put(hit.seg.text, hit.idx);
			return true;
		});
	};

	/** `[k0, k1)` of a display as engine ranges, rightmost first per text (so indices stay valid). */
	const rangesOf = (segs: Seg[], k0: number, k1: number) => {
		const out: { text: TextNode; a: number; b: number }[] = [];
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

	const ranged =
		(write: (text: TextNode, a: number, len: number) => void) =>
		(doc: EngineDoc, id: BlockId, offset: number, length: number): boolean => {
			const v = view(doc);
			const segs = live(v, id) ? display(v, id) : null;
			if (segs === null) return false;
			const total = lengthOf(segs);
			const at = Math.max(0, Math.min(offset, total));
			const end = Math.min(total, at + Math.max(0, length));
			if (end <= at) return true;
			return doc.transact(() => {
				// Per-stream: every range lies inside one stream's content pieces,
				// so no content write ever touches a boundary (A-1).
				for (const r of rangesOf(segs, at, end)) plain(r.text, () => write(r.text, r.a, r.b - r.a));
				return true;
			});
		};
	const deleteText = ranged((t, a, len) => t.delete(a, len));
	const format = (
		doc: EngineDoc,
		id: BlockId,
		o: number,
		l: number,
		marks: Record<string, unknown>
	) => ranged((t, a, len) => t.format(a, len, marks))(doc, id, o, l);

	/** The inline atom `inlineId` in `id`'s display: its text and engine index. */
	const findAtom = (v: StreamView, id: BlockId, inlineId: string) => {
		for (const s of display(v, id) ?? []) {
			let at = 0;
			for (let it = s.text._start; it !== null && at < s.i1; it = it.right) {
				if (it.deleted || !it.countable) continue;
				const n = it.content.type;
				if (n !== undefined && at >= s.i0 && n.getAttr(ID) === inlineId) return { s, at, n };
				at += it.length;
			}
		}
		return null;
	};

	// ── anchors: a relative position into a backing text ─────────────────

	/** `{b, a}`: the home text's block id and an engine relative position (left side = assoc −1). */
	const anchorAt = (doc: EngineDoc, id: BlockId, offset: number, side: 'left' | 'right') => {
		const v = view(doc);
		const segs = live(v, id) ? display(v, id) : null;
		const hit = segs === null ? null : locate(segs, offset, side);
		if (hit === null) return null;
		const rel = Y.createRelativePositionFromTypeIndex(
			hit.seg.text as never,
			hit.idx,
			side === 'left' ? -1 : 0
		);
		return { b: v.texts.get(hit.seg.text)!.home, a: Y.relativePositionToJSON(rel) };
	};

	/**
	 * Anchor → `{block, offset}` in the block that displays it now, or null
	 * (not integrated yet, or its stream is not displayed). The stream is the
	 * one whose last delimiting boundary lies strictly before the position.
	 */
	const resolveAnchor = (doc: EngineDoc, anchor: { b: BlockId; a: unknown }) => {
		const abs = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromJSON(anchor.a as never),
			doc as never,
			false
		);
		if (abs === null) return null;
		const v = view(doc);
		const t = v.texts.get(abs.type as unknown as TextNode);
		if (t === undefined) return null;
		const s = [...t.streams].reverse().find((x) => x.start <= abs.index);
		if (s === undefined) return null;
		const block = v.own.ownerOf(s.block);
		if (block === DEAD || !live(v, block)) return null;
		let acc = 0;
		for (const seg of display(v, block) ?? []) {
			if (seg.text === s.text && seg.i0 <= abs.index && abs.index <= seg.i1) {
				return { block, offset: acc + abs.index - seg.i0 };
			}
			acc += seg.i1 - seg.i0;
		}
		return null;
	};

	return {
		view,
		display,
		insertBlocks,
		insertBlock: (doc: EngineDoc, dest: Destination, spec: BlockSpec) =>
			insertBlocks(doc, dest, [spec]),
		deleteBlock,
		moveBlocks,
		moveBlock: (doc: EngineDoc, id: BlockId, dest: Destination) => moveBlocks(doc, [id], dest),
		nestBlock: (doc: EngineDoc, id: BlockId, parent: BlockId) =>
			live(view(doc), parent) &&
			moveBlocks(doc, [id], { parent, index: kidsOf(view(doc), parent).length }),
		unNestBlock: (doc: EngineDoc, id: BlockId) => {
			const pos = positionOf(doc, id);
			const ppos = pos && pos.parent !== null ? positionOf(doc, pos.parent) : null;
			return ppos !== null && moveBlocks(doc, [id], { parent: ppos.parent, index: ppos.index + 1 });
		},
		splitBlock,
		mergeBlocks,
		insertText: (
			doc: EngineDoc,
			id: BlockId,
			offset: number,
			text: string,
			marks?: Record<string, unknown>
		) => insertAt(doc, id, offset, text, marks),
		insertInline: (doc: EngineDoc, id: BlockId, offset: number, atom: InlineSpec) =>
			insertAt(doc, id, offset, M.buildInline(atom)),
		deleteText,
		setMark: (doc: EngineDoc, id: BlockId, o: number, l: number, name: string, value: unknown) =>
			format(doc, id, o, l, { [name]: value }),
		unsetMark: (doc: EngineDoc, id: BlockId, o: number, l: number, name: string) =>
			format(doc, id, o, l, { [name]: null }),
		removeInline: (doc: EngineDoc, id: BlockId, inlineId: string): boolean => {
			const hit = findAtom(view(doc), id, inlineId);
			if (hit === null) return false;
			return doc.transact(() => {
				plain(hit.s.text, () => hit.s.text.delete(hit.at, 1));
				return true;
			});
		},
		setInlineData: (doc: EngineDoc, id: BlockId, inlineId: string, data: unknown): boolean => {
			const hit = findAtom(view(doc), id, inlineId);
			if (hit === null) return false;
			return doc.transact(() => {
				hit.n.setAttr(DATA, cloneJson(data));
				return true;
			});
		},
		items: (doc: EngineDoc, id: BlockId) => itemsOf(view(doc), id),
		project,
		blockText,
		positionOf,
		listBlockIds: (doc: EngineDoc) => [...view(doc).order.ids],
		crdtId: (doc: EngineDoc, id: BlockId): string | null => {
			if (!live(view(doc), id)) return null;
			const item = M.blockNodeOf(doc, id)?._item;
			return item?.id && !item.deleted ? `${item.id.client}:${item.id.clock}` : null;
		},
		resolveBlock: (doc: EngineDoc, id: BlockId) => M.liveNodeOf(doc, id),
		registryOf: M.registryOf,
		anchorAt,
		resolveAnchor
	};
};

export type StreamsSpike = ReturnType<typeof bindStreams>;
