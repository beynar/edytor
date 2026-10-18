/**
 * THE fold: one pass over a transaction's changed `(type, parentSub)` pairs
 * into the index, once at commit and, for read-your-writes, over the
 * pending part of every transaction whose commit fold has not run.
 */
import { readData } from '../../data.js';
import { Y } from '../../engine.js';
import type { EngineNode } from '../../engine-api.js';
import { LIVE_WRITERS, baseIdOf, incarnationId } from '../../incarnations.js';
import type { BlockId } from '../../placement/model.js';
import { ownerOfNode, slotOwner } from '../../placement/resolve.js';
import { isBlockSlot, isDataSlot, isRecord, unitOf, type SeqItem } from '../../placement/slots.js';
import { CONTENT, CONTENT_NODE, NONCE, hasDeleteMark, isNodeLike } from '../../schema.js';
import {
	type IdSetLike,
	type StoreStruct,
	changedUnder,
	clientsOf,
	engineOps,
	itemOf,
	queuedTransactions,
	sequenceLength,
	structAt,
	walkIdSet
} from '../../structs.js';
import { DEAD, isRowMark } from '../model.js';
import {
	type LiveRow,
	type RowItem,
	gapOfItem,
	headOf,
	rowLength,
	segmentOfGap,
	shiftGap
} from '../rows.js';
import type { ContentRun } from '../runs.js';
import type { IndexCache } from './cache.js';
import type { IndexClaims } from './claims.js';
import type { IndexPlacement } from './placement.js';
import type { IndexRecords } from './records.js';
import {
	CONTENT_ATTR,
	DATA_SEQ_FACET,
	EMPTY_RUNS,
	ENTRY_FACET,
	SEQ_FACET,
	type Facet,
	facetOf,
	checksOf,
	indexChecks,
	sameShape,
	typeAttr
} from './shared.js';
import type { FoldCtx, IndexState, TextEdit, TextEdits, Tx } from './state.js';
import type { IndexStreams } from './streams.js';
import type { IndexLayout } from './layout.js';

/** The fold of one doc's index, over every part it folds into. */
export const indexFold = (
	ix: IndexState &
		IndexClaims &
		IndexStreams &
		IndexLayout &
		IndexPlacement &
		IndexRecords &
		IndexCache
) => {
	const {
		doc,
		registry,
		dataRoot,
		blocks,
		shells,
		textConsumers,
		ownerSeeds,
		rows,
		reclaim,
		placementSeeds,
		stateSeeds,
		incarnations,
		cache,
		dirty,
		foldStats,
		frames,
		candidates,
		ownerOf,
		invalidateBlock,
		streamOf,
		streamsIn,
		setRow,
		scanRow,
		refreshDelims,
		placeHome,
		applyReclaims,
		noteKind,
		homeFor,
		putSlot,
		edgeParent,
		kept,
		updateBlockRec,
		ensureRec,
		syncIncarnations,
		computeRuns,
		tableFacts
	} = ix;
	const ops = engineOps(Y);

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
	/** The struct holding id `client:clock` (unsplit), `null` when the store holds none. */
	const structOf = (client: number, clock: number): StoreStruct | null =>
		structAt(Y, clientsOf(doc).get(client) ?? [], clock);
	/** What a fold changed in one sequence (fork patch YP22): the blocks whose slot, record or mover it touched, and its data slots. */
	type SeqChange = { blocks: Set<BlockId>; data: boolean };
	/**
	 * The edits the id sets `ins`/`del`, the hold log `log` and the move log
	 * `moves` (what the fold has not folded yet) hold: per text, its edits
	 * (a log entry is a unit a hold record hid or showed, fork patch YP20:
	 * `client, clock, ±len`, in order); per sequence, what changed in it
	 * (`seq`): the slots written and removed, the records written and
	 * removed and the units whose mover changed name the blocks to re-place.
	 * Reading the sequences writes the slot map (the slots written and
	 * removed, `putSlot`) and lists the ids whose home to read again
	 * (`rehome`).
	 */
	const makeEditIndex = (
		ins: IdSetLike | undefined,
		del: IdSetLike | undefined,
		log: readonly number[] = [],
		moves: readonly number[] = []
	) => {
		let seqs: Map<EngineNode, SeqChange> | undefined;
		const rehome = new Set<BlockId>();
		const seqOf = (node: EngineNode): SeqChange => {
			let e = seqs!.get(node);
			if (e === undefined) seqs!.set(node, (e = { blocks: new Set(), data: false }));
			return e;
		};
		/** Note unit `c:k` (`value`) of the sequence of `node`: a block slot names its block, a data slot its data. */
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
		const visitSeq = (s: StoreStruct, from: number, to: number, inserted: boolean | null): void => {
			const parent = s.parent as EngineNode;
			if (s.parentSub !== null || !isNodeLike(parent) || parent.name === CONTENT_NODE) return;
			const e = seqOf(parent);
			const owner = ownerOfNode(registry, kept, parent);
			const it = s as SeqItem;
			if (it.content === undefined) return;
			if (isRecord(it)) {
				const ids = it.content.ids!;
				for (let i = 0; i < ids.length; i += 3)
					for (let j = 0; j < ids[i + 2]!; j++) {
						const u = unitOf(doc, { c: ids[i]!, k: ids[i + 1]! + j });
						if (u !== null) noteUnit(e, owner, u.value, ids[i]!, ids[i + 1]! + j, null);
					}
			} else if (it.content.arr !== undefined)
				for (let k = from; k < to; k++)
					noteUnit(e, owner, it.content.arr[k - s.id.clock], s.id.client, k, inserted);
		};
		const buildSeqs = (): Map<EngineNode, SeqChange> => {
			if (seqs !== undefined) return seqs;
			seqs = new Map();
			if (ins === undefined || del === undefined) return seqs;
			walkIdSet(Y, doc, ins, (s, from, to) => visitSeq(s, from, to, true));
			walkIdSet(Y, doc, del, (s, from, to) => visitSeq(s, from, to, false));
			for (let i = 0; i < moves.length; i += 3) {
				const s = structOf(moves[i]!, moves[i + 1]!);
				if (s === null) continue;
				visitSeq(s, moves[i + 1]!, moves[i + 1]! + moves[i + 2]!, null);
				// Where the unit shows now: that sequence changed too.
				const mover = (s as SeqItem).mover;
				if (mover) seqOf(mover.parent as EngineNode);
			}
			return seqs;
		};
		let built: Map<EngineNode, TextEdits> | null | undefined;
		const build = (): Map<EngineNode, TextEdits> | null => {
			if (built !== undefined) return built;
			if (ins === undefined || del === undefined) return (built = null);
			const out = new Map<EngineNode, TextEdits>();
			const edit = (s: StoreStruct, from: number, to: number, deleted: boolean): void => {
				const parent = s.parent as EngineNode;
				if (s.parentSub !== null || !isNodeLike(parent)) return;
				let e = out.get(parent);
				if (e === undefined) out.set(parent, (e = { edits: [], scan: false, opaque: false }));
				// A format marker moves no unit; its effect reaches past the edit.
				if (s.countable !== true) return void (e.opaque = true);
				if (holdsBoundary(s, from, to)) return void (e.scan = true);
				e.edits.push({ item: s as RowItem, len: to - from, del: deleted });
			};
			const visit = (idSet: IdSetLike, deleted: boolean): boolean =>
				walkIdSet(Y, doc, idSet, (s, from, to) => {
					// Written and removed (or held) within the fold: nothing moved.
					if (!(deleted ? ins.has(s.id.client, from) : s.deleted)) edit(s, from, to, deleted);
				});
			// In order, after the inserts and before the deletes (each gap then
			// holds what an edit takes); a unit written within the fold shows or
			// not as its insert says.
			const held = (): boolean => {
				for (let i = 0; i < log.length; i += 3) {
					const s = structOf(log[i], log[i + 1]);
					if (s === null) return false;
					const n = log[i + 2];
					if (!ins.has(log[i], log[i + 1])) edit(s, log[i + 1], log[i + 1] + Math.abs(n), n < 0);
				}
				return true;
			};
			built = visit(ins, false) && held() && visit(del, true) ? out : null;
			return built;
		};
		return {
			/** `node`'s edits (`null`: unknown — rescan, every consumer recomputes). */
			text: (node: EngineNode): TextEdits | null => {
				const map = build();
				return map === null ? null : (map.get(node) ?? NO_EDITS);
			},
			/** What changed in `node`'s sequence (`undefined`: nothing). */
			seq: (node: EngineNode): SeqChange | undefined => buildSeqs().get(node),
			/** The sequences the fold changed. */
			seqNodes: (): Iterable<EngineNode> => buildSeqs().keys(),
			/** The ids whose home to read again (their slots changed). */
			rehome
		};
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
		const parentBefore = parentOf(id);
		if (typeof parentBefore === 'string') ctx.parents.add(parentBefore);
		if (kinds.has('entry') || kinds.has('structure')) {
			const [claimsBefore, typeBefore] = [blocks.get(id)?.claims, blocks.get(id)?.type];
			updateBlockRec(id);
			// A retype that lands with a structure facet is still a retype.
			if (typeBefore !== undefined && blocks.get(id)?.type !== typeBefore) ix.retyped = true;
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
			if (kinds.has('seq') && rec && editsOf.seq(rec.node)?.data) kinds.add('meta');
			if (kinds.has('meta') && rec) {
				const was = rec.type;
				const facts = tableFacts(id, rec.data);
				rec.type = typeAttr(rec.node);
				rec.data = readData(rec.node);
				if (rec.type !== was) {
					ix.retyped = true;
					noteKind(id);
				}
				// A table's columns or a cell's column re-place the table's cells (`table.columns`).
				if (tableFacts(id, rec.data) !== facts) stateSeeds.add(id);
				// A retype that changes the kind's display shape re-parents
				// (or re-kinds) its children.
				if (ix.roles !== null && !sameShape(ix.roles, was, rec.type)) stateSeeds.add(id);
			}
		}
		const parentAfter = parentOf(id);
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
					if (gap < 0 || !shiftGap(row!, gap, e.del ? -e.len : e.len)) {
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
				if (same) [next.cuts, next.head] = [row.cuts, row.head];
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
	const settle = (affected: Iterable<BlockId>, ctx: FoldCtx | null): void => {
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
				let facets = touched.get(id);
				if (facets === undefined) touched.set(id, (facets = new Set()));
				facets.add(facet);
				if (facet !== CONTENT) continue;
				// A sequence edit of the block's own text, or a change inside one of its atoms.
				let list = edits.get(id);
				if (list === undefined) edits.set(id, (list = []));
				list.push(seq ? editsOf.text(type as EngineNode) : null);
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
		for (const node of editsOf.seqNodes()) {
			const ch = editsOf.seq(node)!;
			ix.seqEpoch++;
			for (const b of ch.blocks) placementSeeds.add(b);
			if (ch.blocks.size > 0 || ch.data) derived = true;
			const owner = ownerOfNode(registry, kept, node);
			if (typeof owner === 'string') {
				let facets = touched.get(owner);
				if (facets === undefined) touched.set(owner, (facets = new Set()));
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
			settle(ctx.table ? shells : [...touched.keys(), ...ctx.parents, ...editedStreams(ctx)], ctx);
		for (const b of ctx.invalidated) dirty.add(b);
		if (indexChecks.on) checksOf(ix).check();
		if (derived) ix.version++;
		if (ix.reporting) {
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

	/** Each transaction's folded part: copies of its id sets, the hold and move logs' folded lengths, and the watermark. */
	const cursors = new WeakMap<
		Tx,
		{ ins: IdSetLike; del: IdSetLike; holds: number; moves: number; mark: number }
	>();
	/** The transactions whose commit fold ran. */
	const committed = new WeakSet<Tx>();
	const lengthOf = (set: IdSetLike): number => {
		let n = 0;
		set.clients.forEach((ranges) => {
			for (const r of ranges.getIds()) n += r.len;
		});
		return n;
	};
	/** How much a transaction wrote so far: its id sets' lengths and its hold and move logs'. */
	const watermark = (tr: Tx): number =>
		lengthOf(tr.insertSet!) +
		lengthOf(tr.deleteSet!) +
		(tr.holds?.length ?? 0) +
		(tr.moves?.length ?? 0);

	/**
	 * Fold the pending part of `tr` — the structs its insert/delete sets
	 * gained since the last fold — before a read inside it (read-your-
	 * writes; `transaction.changed` does not grow on a second edit to an
	 * already-changed type).
	 */
	const syncPending = (tr: Tx | null | undefined): boolean => {
		if (tr?.insertSet === undefined || tr.deleteSet === undefined) return false;
		let cursor = cursors.get(tr);
		if (cursor === undefined)
			cursors.set(
				tr,
				(cursor = { ins: ops.idSet(), del: ops.idSet(), holds: 0, moves: 0, mark: 0 })
			);
		const mark = watermark(tr);
		if (mark === cursor.mark) return false;
		const ins = ops.diff(tr.insertSet, cursor.ins);
		const del = ops.diff(tr.deleteSet, cursor.del);
		const log = (tr.holds ?? []).slice(cursor.holds);
		const moves = (tr.moves ?? []).slice(cursor.moves);
		ops.insertInto(cursor.ins, ins);
		ops.insertInto(cursor.del, del);
		cursor.holds += log.length;
		cursor.moves += moves.length;
		cursor.mark = mark;
		for (const f of frames) f.wrote = true;
		const changed = new Map<EngineNode, Set<string | null>>();
		const note = (s: StoreStruct): void => {
			foldStats.structs++;
			if (!isNodeLike(s.parent)) return;
			let subs = changed.get(s.parent);
			if (subs === undefined) changed.set(s.parent, (subs = new Set()));
			subs.add(s.parentSub);
		};
		walkIdSet(Y, doc, ins, note);
		walkIdSet(Y, doc, del, note);
		for (const l of [log, moves])
			for (let i = 0; i < l.length; i += 3) {
				const s = structOf(l[i]!, l[i + 1]!);
				if (s === null) continue;
				note(s);
				// A unit a record moved: where it shows now changed too (a held unit has no mover).
				const mover = (s as SeqItem).mover;
				if (mover) note(mover as unknown as StoreStruct);
			}
		fold(changed, makeEditIndex(ins, del, log, moves));
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
			(tr) =>
				!committed.has(tr) &&
				tr.insertSet !== undefined &&
				tr.deleteSet !== undefined &&
				watermark(tr) !== (cursors.get(tr)?.mark ?? 0)
		);

	/**
	 * The commit of a transaction that changed the registry or a node under
	 * it: fold `transaction.changed` once (the report publishes from `update`).
	 */
	const onCommit = (tr: Tx): void => {
		if (!changedUnder(tr as { changed: Map<unknown, unknown> }, [registry])) return;
		let [ins, del] = [tr.insertSet, tr.deleteSet];
		// The writes a read folded already moved the rows: only the rest
		// are edits now (the facets fold again, idempotent).
		const cursor = cursors.get(tr);
		if (cursor !== undefined && ins !== undefined && del !== undefined) {
			ins = ops.diff(ins, cursor.ins);
			del = ops.diff(del, cursor.del);
		}
		const log = (tr.holds ?? []).slice(cursor?.holds ?? 0);
		const moves = (tr.moves ?? []).slice(cursor?.moves ?? 0);
		cursors.delete(tr);
		committed.add(tr);
		fold(tr.changed ?? new Map(), makeEditIndex(ins, del, log, moves));
	};

	return {
		runs,
		settle,
		syncPending,
		openTx,
		syncAll,
		unfolded,
		onCommit,
		committed
	};
};

export type IndexFold = ReturnType<typeof indexFold>;
