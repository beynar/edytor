/**
 * Shared suggestions (`docs/archive/shared-suggestions/design.md`, the
 * `sugg.*` rows of `docs/editor-delete-contract.md`): a suggestion lives in
 * the document, so every replica, the room and a reload see it.
 *
 * - A suggestion is a record node under the root `suggest`, written by its
 *   **writer**: a client id minted for a suggesting session, bound to its
 *   author with its first write like any replica. The record's own item
 *   opens the writer's clocks it owns, up to the writer's next record; its
 *   creation is in no history step, so no undo or redo moves them.
 * - **An insertion** is the writer's own text and blocks: a shown unit or
 *   block of the writer, in the record's clocks, not settled, is pending.
 * - **A deletion** writes nothing to the text: the writer's id list (fork
 *   patch YP31, a hold record that holds nothing inside a nested node) in
 *   the record names the units; a shown one, not settled, is pending.
 * - **An operation** (a block delete, a merge, a retype, a data change, a
 *   format) is the plan step's operation and its arguments (`argsOf`), run
 *   again by the reviewer on accept.
 * - **A decision** writes only what changes, one engine call over the
 *   change's ids (`YNode#hold`): the text that goes is the reviewer's hold
 *   (fork patch YP20, the root records list), the text that stays a settled
 *   id list written by the reviewer into the record (its client is the
 *   decider).
 *
 * What is pending is a function of the replicated state (items, records,
 * settled ranges), so replicas converge in any delivery order. It is read
 * again after any write, from the blocks the records' writers and
 * proposals are in: a document with no suggestion pays nothing.
 */
import type { EngineNode } from '../engine-api.js';
import {
	ATTRIBUTION_ROOT,
	CONTENT_NODE,
	isNodeLike,
	SUGGEST_ROOT,
	TEXT_DELETES_ROOT
} from '../schema.js';
import { blockNodeOf, registryOf, type BlockId } from '../placement/model.js';
import { isRowMark, newNode, openRangeCursor, ownTextIds, writersOf } from '../text/model.js';
import { canonKey } from '../text/ranges.js';
import {
	changedUnder,
	clientsOf,
	engineOps,
	firstItem,
	itemOf,
	storeOf,
	type IdSetOf
} from '../structs.js';
import { nonceOf } from '../rand.js';
import { id as mint } from '../../utils.js';
import type { JSONBlock, JSONDoc, JSONInlineBlock, JSONText } from '../../utils/json.js';
import { argsOf, effectOf, NOOP, refused } from './plan.js';
import type { DocAnchor, OpResult, Plan, PlanStep, Prepared } from './types.js';
import type { DocBase, DocReads } from './reads.js';

/** `[client, clock, length]`: the units a decision names. */
export type IdRange = [client: number, clock: number, length: number];

/** An operation a suggestion proposes, run again by the reviewer on accept. */
export type SuggestedOp = {
	op: 'deleteBlock' | 'mergeBlocks' | 'setBlockType' | 'patchData' | 'formatRange';
	/** Its arguments (`formatRange`: `[block, from, to, marks]`, its range as two anchors). */
	args: unknown[];
};

/** One change of a suggestion, as a reviewer sees it. */
export type SuggestedChange = {
	/** The suggestion it is part of (its record's id). */
	readonly suggestion: string;
	/**
	 * `insert`: a run of text it inserts; `delete`: a run it proposes to
	 * delete; `block`: a block it inserts, its text with it; `split`: the
	 * block its split makes; `op`: an operation it proposes.
	 */
	readonly kind: 'insert' | 'delete' | 'block' | 'split' | 'op';
	/** The block it is in or about (`null`: the document's data). */
	readonly block: BlockId | null;
	/** Its run, in the block's display offsets (a block's: the whole block). */
	readonly offset: number;
	readonly length: number;
	readonly text: string;
	/** For `op`: the operation and its arguments. */
	readonly op?: SuggestedOp;
	/** The units (or the entry) a decision names. @internal */
	readonly ids: readonly IdRange[];
};

/** A suggestion the document holds. */
export type SuggestionRecord = {
	readonly id: string;
	/** Its author (its writer's actor), `undefined` until the binding arrives. */
	readonly by: string | undefined;
	/** The agent that wrote it for its author (`'ai'`), when one did. */
	readonly via: string | undefined;
	readonly label: string | undefined;
	/** When it was opened (ms since the epoch). */
	readonly at: number;
	/** Its writer. @internal */
	readonly writer: number;
};

/**
 * One part of a decision: an id list written into suggestion `into`'s
 * record (settled: it stays) or, `into` null, the decider's hold of the
 * text that goes (fork patch YP20, the root records list): one engine
 * call either way (`YNode#hold`); or a document operation's calls (their
 * arguments read when it runs).
 */
export type DecisionPart =
	| { into: string | null; ids: number[] }
	| { op: string; calls: () => unknown[][] };

type Op = SuggestedOp & { k: number };
type Rec = SuggestionRecord & {
	node: EngineNode;
	start: number;
	end: number;
	settled: IdSetOf;
	proposed: IdSetOf;
	ops: Op[];
};
type Item = {
	id: { client: number; clock: number };
	deleted: boolean;
	length: number;
	right: Item | null;
	parent: unknown;
	parentSub: string | null;
	content: { ids?: number[]; getContent(): unknown[] };
};
/** A shown unit of a block: its id, display offset and character (`￼` for an atom). */
type Unit = { client: number; clock: number; offset: number; char: string };
/** A block's pending changes, and the units the document without suggestions leaves out. */
type Pending = { changes: SuggestedChange[]; inserted: number[] };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const OPS = ['deleteBlock', 'mergeBlocks', 'setBlockType', 'patchData', 'formatRange'];
/** The order a decision runs its operations in: the id lists first, structure last. */
const RANK: Record<string, number> = { mergeBlocks: 2, deleteBlock: 3 };

/** The list `map` keeps at `key` (made empty when absent). */
const listOf = <K, V>(map: Map<K, V[]>, key: K): V[] => map.get(key) ?? map.set(key, []).get(key)!;

/** Append unit `client:clock` to `runs`, joining the last range when it continues it (`next`: shown right after it). */
const push = (runs: IdRange[], client: number, clock: number, next = true) => {
	const last = runs[runs.length - 1];
	if (next && last && last[0] === client && last[1] + last[2] === clock) last[2]++;
	else runs.push([client, clock, 1]);
};

/** `content` without the units at the (sorted) display `offsets`, equal neighbours joined. */
const without = (content: (JSONText | JSONInlineBlock)[], offsets: readonly number[]) => {
	const out: (JSONText | JSONInlineBlock)[] = [];
	let [at, k] = [0, 0];
	for (const part of content) {
		let text = '';
		for (const char of 'text' in part ? part.text : '￼')
			for (let j = 0; j < char.length; j++)
				if (offsets[k] === at++) k++;
				else text += char[j];
		const last = out[out.length - 1];
		if (!text) continue;
		if (!('text' in part)) out.push(part);
		else if (last && 'text' in last && canonKey(last.marks) === canonKey(part.marks))
			out[out.length - 1] = { ...last, text: last.text + text };
		else out.push({ ...part, text });
	}
	return out;
};

export type SuggestContext = DocBase &
	DocReads & {
		write: <R>(fn: () => R) => R;
		/** Write in one transaction and one attribution frame (the funnel's). */
		framed: (fn: () => void) => boolean;
		apply: (p: Prepared) => OpResult;
		anchorAt: (id: BlockId, offset: number, affinity?: 'left' | 'right') => DocAnchor | null;
		resolveAnchor: (anchor: DocAnchor) => { blockId: BlockId; offset: number } | null;
		/** Run document operation `op` (`apply(prepare[op](…args))`). */
		run: (op: string, args: unknown[]) => OpResult;
	};

/** The document's shared suggestions (`facade.suggest`). */
export const docSuggest = (c: SuggestContext) => {
	const { Y, doc, runsView, view, write } = c;
	const idSet = engineOps(Y).idSet;
	const root = (): EngineNode => doc.get(SUGGEST_ROOT);
	const actorOf = (client: number): string | undefined => {
		const bound = doc.get(ATTRIBUTION_ROOT).getAttr(`c/${client}`);
		return typeof bound === 'string' ? bound : undefined;
	};
	/** Run `fn` writing as `client` (the derived-writer technique of seeds and `ownText`). */
	const as = <R>(client: number, fn: () => R): R => {
		const local = doc.clientID;
		doc.clientID = client;
		try {
			return fn();
		} finally {
			doc.clientID = local;
		}
	};

	// ── the records ─────────────────────────────────────────────────────

	type Table = {
		recs: Rec[];
		byWriter: Map<number, Rec[]>;
		/** The records holding a proposal. */
		proposing: Rec[];
		/** The unsettled operation proposals, by the block they are about (`null`: the document's data). */
		opsOf: Map<BlockId | null, { rec: Rec; op: Op }[]>;
	};
	/** Bumped by every change of the records (a commit, or a write of this part). */
	let version = 0;
	let table: { v: number; t: Table } | null = null;

	const records = (): Table => {
		if (table?.v === version) return table.t;
		const t: Table = { recs: [], byWriter: new Map(), proposing: [], opsOf: new Map() };
		const r = root();
		for (const id of r.attrKeys()) {
			const node = r.getAttr(id) as EngineNode;
			const item = isNodeLike(node) ? itemOf<Item>(node) : null;
			if (!item) continue;
			const writer = item.id.client;
			const attr = (key: string) => {
				const v = node.getAttr(key);
				return typeof v === 'string' ? v : undefined;
			};
			const rec: Rec = {
				id,
				node,
				writer,
				get by() {
					return actorOf(writer);
				},
				via: attr('via'),
				label: attr('lbl'),
				at: Number(node.getAttr('at')) || 0,
				start: item.id.clock,
				end: Infinity,
				settled: idSet(),
				proposed: idSet(),
				ops: []
			};
			for (let it = firstItem<Item>(node); it !== null; it = it.right) {
				const own = it.id.client === writer;
				const ids = it.content.ids;
				if (it.deleted) continue;
				if (ids)
					for (let i = 0; i < ids.length; i += 3)
						(own ? rec.proposed : rec.settled).add(ids[i]!, ids[i + 1]!, ids[i + 2]!);
				else if (own)
					it.content.getContent().forEach((v, j) => {
						const o = v as SuggestedOp;
						if (OPS.includes(o?.op)) rec.ops.push({ ...o, k: it!.id.clock + j });
					});
			}
			if (rec.proposed.clients.size) t.proposing.push(rec);
			for (const op of rec.ops) {
				const target = op.args[0] as BlockId | null | { block: BlockId };
				if (!rec.settled.has(writer, op.k))
					listOf(t.opsOf, typeof target === 'object' && target ? target.block : target).push({
						rec,
						op
					});
			}
			t.recs.push(rec);
			listOf(t.byWriter, writer).push(rec);
		}
		for (const recs of t.byWriter.values()) {
			recs.sort((a, b) => a.start - b.start);
			recs.forEach((rec, i) => (rec.end = recs[i + 1]?.start ?? Infinity));
		}
		t.recs.sort((a, b) => a.at - b.at || a.start - b.start);
		table = { v: version, t };
		return t;
	};

	/** The record whose clocks hold `client:clock`, when it is pending there (not settled). */
	const pendingIn = (client: number, clock: number): Rec | undefined => {
		const rec = records()
			.byWriter.get(client)
			?.findLast((r) => r.start <= clock);
		return rec && clock < rec.end && !rec.settled.has(client, clock) ? rec : undefined;
	};

	// ── what is pending ─────────────────────────────────────────────────

	/** The work done (`sugg.scale`): blocks read, units walked. */
	const debug = { computes: 0, units: 0 };

	/** The shown units of `b`, in display order (row marks skipped, as the reads skip them). */
	const unitsOf = (b: BlockId): Unit[] => {
		const out: Unit[] = [];
		debug.computes++;
		for (const seg of view().own.display(b) ?? [])
			for (const piece of openRangeCursor(seg.text).read(seg.i0, seg.i1)) {
				const { str } = piece.content;
				const arr = str === undefined ? piece.content.getContent?.() : null;
				for (let j = 0; !piece.deleted && j < piece.len; j++)
					if (!arr || !isRowMark(arr[piece.offset + j]))
						out.push({
							client: piece.id.client,
							clock: piece.id.clock + j,
							offset: out.length,
							char: str?.[piece.offset + j] ?? '￼'
						});
			}
		debug.units += out.length;
		return out;
	};

	/**
	 * The block a split-born `b` was split from: the one showing the nearest
	 * stream before `b`'s in its text, past those `skip` names (`null`: none
	 * is shown; `undefined`: `b` was not split).
	 */
	const sourceOf = (b: BlockId, skip?: (owner: BlockId) => boolean) => {
		const { own } = view();
		const s = own.streamOf(b);
		if (s === undefined || s.home === b) return undefined;
		const streams = own.streamsIn(s.home);
		for (let i = streams.findIndex((x) => x.block === b) - 1; i >= 0; i--) {
			const owner = own.ownerOf(streams[i]!.block);
			if (typeof owner === 'string' && c.live(owner) && !skip?.(owner)) return owner;
		}
		return null;
	};

	/** An operation proposal of `rec` about block `b`, as a change. */
	const opChange = (rec: Rec, op: Op, b: BlockId | null): SuggestedChange => {
		const [from, to] =
			op.op === 'formatRange'
				? [op.args[1], op.args[2]].map((a) => c.resolveAnchor(a as DocAnchor))
				: [];
		const range = !!b && from?.blockId === b && to?.blockId === b;
		return {
			suggestion: rec.id,
			kind: 'op',
			block: b,
			offset: range ? from.offset : 0,
			length: range ? to.offset - from.offset : 0,
			text: '',
			op: { op: op.op, args: op.args },
			ids: [[rec.writer, op.k, 1]]
		};
	};

	/** `b`'s pending changes, read from the state now (`null`: none). */
	const compute = (b: BlockId): Pending | null => {
		const t = records();
		const units = unitsOf(b);
		const node = blockNodeOf(doc, b);
		const born = node && itemOf<Item>(node)!.id;
		// A split whose source is gone is no longer one: its writer's text is an insertion.
		const split = sourceOf(b);
		const maker = born && split !== null ? pendingIn(born.client, born.clock) : undefined;
		const changes: SuggestedChange[] = [];
		const inserted: number[] = [];
		const made: IdRange[] = maker ? [[born!.client, born!.clock, 1]] : [];
		const open = new Map<string, Mutable<SuggestedChange> & { ids: IdRange[] }>();
		const touch = (rec: Rec, kind: 'insert' | 'delete', u: Unit) => {
			const run = open.get(kind + rec.id);
			if (run && run.offset + run.length === u.offset) {
				run.length++;
				run.text += u.char;
				return push(run.ids, u.client, u.clock);
			}
			if (run) changes.push(run);
			open.set(kind + rec.id, {
				suggestion: rec.id,
				kind,
				block: b,
				offset: u.offset,
				length: 1,
				text: u.char,
				ids: [[u.client, u.clock, 1]]
			});
		};
		let last = -2;
		for (const u of units) {
			const rec = pendingIn(u.client, u.clock);
			if (rec && rec === maker) {
				// A range of the block's own writer is shown in one piece.
				push(made, u.client, u.clock, last === u.offset - 1);
				last = u.offset;
			} else if (rec) touch(rec, 'insert', u);
			if (rec) inserted.push(u.offset);
			for (const r of t.proposing)
				if (r.proposed.has(u.client, u.clock) && !r.settled.has(u.client, u.clock))
					touch(r, 'delete', u);
		}
		changes.push(...open.values());
		changes.sort((x, y) => x.offset - y.offset);
		if (maker)
			changes.unshift({
				suggestion: maker.id,
				kind: split ? 'split' : 'block',
				block: b,
				offset: 0,
				length: units.length,
				text: units.map((u) => u.char).join(''),
				ids: made
			});
		for (const { rec, op } of t.opsOf.get(b) ?? []) changes.push(opChange(rec, op, b));
		return changes.length ? { changes, inserted } : null;
	};

	/** Every block the records' writers and proposals are in, and those their operations are about. */
	const candidates = (): Set<BlockId | null> => {
		const t = records();
		const out = new Set<BlockId | null>(t.opsOf.keys());
		const texts = new Set<EngineNode>();
		const clients = clientsOf(doc) as unknown as Map<number, Item[]>;
		/** Note where the structs of `client` from `from` to `to` (exclusive) are. */
		const each = (client: number, from: number, to: number) => {
			const structs = clients.get(client) ?? [];
			let k = structs.length;
			try {
				k = Y.findIndexSS(structs as never[], from);
			} catch {
				// Past what this replica holds.
			}
			for (; k < structs.length && structs[k]!.id.clock < to; k++) {
				const st = structs[k]!;
				const parent = st.parent as EngineNode;
				if (st.deleted || !isNodeLike(parent)) continue;
				if (parent.name === CONTENT_NODE) texts.add(parent);
				else if (st.parentSub && parent === registryOf(doc)) out.add(st.parentSub);
			}
		};
		for (const [writer, recs] of t.byWriter) each(writer, recs[0]!.start, Infinity);
		for (const rec of t.proposing)
			for (const [client, ranges] of rec.proposed.clients)
				for (const { clock, len } of ranges.getIds()) each(client, clock, clock + len);
		const { own } = view();
		for (const text of texts) {
			const home = (text._item?.parent as EngineNode | undefined)?._item?.parentSub;
			for (const b of home ? [home, ...own.streamsIn(home).map((s) => s.block)] : []) {
				const owner = own.ownerOf(b);
				if (typeof owner === 'string') out.add(owner);
			}
		}
		return out;
	};

	/** The pending changes per block, read again after any write (`null`: the document's data). */
	let memo: { v: string; map: Map<BlockId | null, Pending> } | null = null;
	const pending = (): Map<BlockId | null, Pending> => {
		const v = `${version}.${runsView.version()}`;
		if (memo?.v === v) return memo.map;
		const map = new Map<BlockId | null, Pending>();
		const t = records();
		for (const b of t.recs.length ? candidates() : []) {
			const p =
				b === null
					? {
							changes: (t.opsOf.get(null) ?? []).map(({ rec, op }) => opChange(rec, op, null)),
							inserted: []
						}
					: c.live(b)
						? compute(b)
						: null;
			if (p?.changes.length) map.set(b, p);
		}
		memo = { v, map };
		return map;
	};

	const listeners = new Set<() => void>();
	const onCommit = (tr: never) => {
		if (!changedUnder(tr, [root()])) return;
		version++;
		for (const f of listeners) f();
	};
	doc.on('commit', onCommit);

	// ── writes ──────────────────────────────────────────────────────────

	/** A fresh writer this replica writes suggestions under. */
	const writer = (): number => {
		let w = 0;
		while (!w || w === doc.clientID || storeOf(doc).getClock(w))
			w = (nonceOf(doc) | 0x4000000) >>> 0;
		writersOf(doc).add(w);
		return w;
	};

	/**
	 * Open a suggestion written by `writer` (a fresh writer by default): its
	 * record, in no history step. Answers its id.
	 */
	const open = (
		options: { id?: string; writer?: number; via?: string; label?: string; at?: number } = {}
	): string =>
		write(() => {
			const w = options.writer ?? writer();
			const id = options.id ?? mint('s');
			const from = storeOf(doc).getClock(w);
			writersOf(doc).add(w);
			doc.transact(() =>
				as(w, () => {
					root().setAttr(id, newNode('suggestion'));
					const rec = root().getAttr(id) as EngineNode;
					rec.setAttr('at', options.at ?? Date.now());
					if (options.via) rec.setAttr('via', options.via);
					if (options.label) rec.setAttr('lbl', options.label);
				})
			);
			// No history step captures the record's creation: its clocks stay its own.
			if (!ownTextIds.has(doc)) ownTextIds.set(doc, idSet());
			ownTextIds.get(doc)!.add(w, from, storeOf(doc).getClock(w) - from);
			version++;
			return id;
		});

	const recOf = (id: string): Rec => {
		const rec = records().recs.find((r) => r.id === id);
		if (!rec) throw new RangeError(`[edytor] suggestion "${id}" is unknown`);
		return rec;
	};

	/** Two writers of one author (the same writer, or bound to the same actor). */
	const sameAuthor = (a: number, b: number) =>
		a === b || (!!actorOf(a) && actorOf(a) === actorOf(b));
	/** `client:clock` is a pending insertion of `w`'s author: its edits are direct. */
	const ownPending = (client: number, clock: number, w: number) =>
		!!pendingIn(client, clock) && sameAuthor(client, w);
	/** Block `b` is a pending insertion of `w`'s author. */
	const ownBlock = (b: BlockId | undefined, w: number) => {
		const node = b === undefined ? null : blockNodeOf(doc, b);
		const id = node && itemOf<Item>(node)!.id;
		return !!id && ownPending(id.client, id.clock, w);
	};

	/** Append an id list (YP31) or an operation to record `rec`'s list, as the current client. */
	const entry = (rec: Rec, value: number[] | SuggestedOp) => {
		const { node } = rec;
		if (Array.isArray(value)) node.hold(value);
		else node.insert(node.length, [value]);
		version++;
	};

	/**
	 * Write plan `p` as suggestion `id` (the view's suggesting mode), by the
	 * suggestion's writer: insertions are written, a text delete proposes
	 * the units that are not its author's pending ones (those go), any other
	 * step on content that is not its author's pending one is proposed as
	 * the operation it is, and a move is refused. Later steps' offsets,
	 * prepared with the proposed text gone, step over it (an insertion lands
	 * after it). Answers the result and where the plan's caret is now.
	 */
	const apply = (
		id: string,
		p: Prepared
	): { result: OpResult; at?: { block: BlockId; offset: number } } => {
		if (!('writes' in p)) return { result: p };
		if (p.writes.some((s) => s.op === 'moveBlocks')) return { result: refused('suggesting') };
		const rec = recOf(id);
		const w = rec.writer;
		/** The units this plan proposed, per block: present, though the plan counts them gone. */
		const kept = new Map<BlockId, string[]>();
		const key = (u: Unit) => `${u.client}:${u.clock}`;
		/** The units the plan's `[o, o + length)` of `b` names, and its offset `o` now. */
		const range = (b: BlockId, o: number, length: number) => {
			const keep = kept.get(b);
			if (!keep && !length) return { units: [], at: o };
			const units = keep ? unitsOf(b).filter((u) => !keep.includes(key(u))) : unitsOf(b);
			return { units: units.slice(o, o + length), at: units[o]?.offset ?? c.displayLength(b) };
		};
		let wrote = false;
		/** Written steps waiting to be applied together (a paste's lines keep their split's key). */
		const batch: PlanStep[] = [];
		const flush = () => {
			const writes = batch.splice(0);
			if (writes.length)
				wrote =
					c.apply({
						ids: [],
						writes,
						effect: effectOf(writes),
						version: runsView.version()
					} as Plan).status === 'applied' || wrote;
		};
		const propose = (value: number[] | SuggestedOp) => {
			flush();
			entry(rec, value);
			wrote = true;
		};
		const result = write(() =>
			doc.transact(() =>
				as(w, (): OpResult => {
					for (const s of p.writes) {
						const b = 'id' in s ? s.id : undefined;
						if (b !== undefined && kept.has(b)) flush();
						if (s.op === 'insertBlocks') batch.push(s);
						else if (s.op === 'insertText' || s.op === 'insertInline' || s.op === 'splitBlock')
							batch.push({ ...s, offset: range(s.id, s.offset, 0).at });
						else if (s.op === 'deleteText' || s.op === 'removeInline' || s.op === 'formatRange') {
							flush();
							const { units } = range(s.id, s.offset, 'length' in s ? s.length : 1);
							const own = units.filter((u) => ownPending(u.client, u.clock, w));
							if (s.op === 'formatRange') {
								if (own.length === units.length)
									batch.push({ ...s, offset: units[0]?.offset ?? 0 });
								else
									propose({
										op: 'formatRange',
										args: [
											s.id,
											c.anchorAt(s.id, units[0]!.offset, 'right'),
											c.anchorAt(s.id, units[units.length - 1]!.offset + 1, 'left'),
											s.marks
										]
									});
								continue;
							}
							const others = units.filter((u) => !own.includes(u));
							// Units this suggestion already proposes are stepped over, not proposed again.
							const fresh = others.filter(
								(u) => !rec.proposed.has(u.client, u.clock) || rec.settled.has(u.client, u.clock)
							);
							if (fresh.length) propose(fresh.flatMap((u) => [u.client, u.clock, 1]));
							kept.set(s.id, [...(kept.get(s.id) ?? []), ...others.map(key)]);
							// Its author's own pending units go, from the right so the offsets hold.
							for (const u of own.reverse())
								batch.push({ op: 'deleteText', id: s.id, offset: u.offset, length: 1 });
							flush();
						} else if (ownBlock('from' in s ? s.from : b, w)) batch.push(s);
						else propose({ op: s.op, args: argsOf(s, c.childrenIds) } as SuggestedOp);
					}
					flush();
					return wrote ? { status: 'applied', ids: p.ids } : NOOP;
				})
			)
		);
		const caret = p.at && { block: p.at.block, offset: range(p.at.block, p.at.offset, 0).at };
		return { result, ...(caret && { at: caret }) };
	};

	/** Write decision part `part` (an id list) by the current client: settled in its record, or held. */
	const hold = ({ into, ids }: { into: string | null; ids: number[] }): void =>
		void (into === null
			? c.framed(() => doc.get(TEXT_DELETES_ROOT).hold(ids))
			: write(() => entry(recOf(into), ids)));

	/**
	 * What accepting (`accept`) or rejecting `changes` writes, in the order
	 * it runs: the id lists first (what stays settled in its record, the
	 * text that goes held by the decider), then the operations, structure
	 * last, each reading its arguments when it runs.
	 */
	const decide = (changes: readonly SuggestedChange[], accept: boolean): DecisionPart[] => {
		const lists = new Map<string | null, number[]>();
		const ops: DecisionPart[] = [];
		for (const ch of changes) {
			const b = ch.block!;
			const keep = ch.kind === 'op' || (ch.kind === 'delete' ? !accept : accept);
			// A rejected block goes with its operation; a rejected split's writer text is held.
			if (keep || ch.kind !== 'block')
				listOf(lists, keep ? ch.suggestion : null).push(
					...(keep || ch.kind !== 'split' ? ch.ids : ch.ids.slice(1)).flat()
				);
			if (ch.kind === 'op' && accept) {
				const { op, args } = ch.op!;
				ops.push({
					op,
					calls: () => {
						if (op !== 'formatRange') return [args];
						const [from, to] = [args[1], args[2]].map((a) => c.resolveAnchor(a as DocAnchor));
						return from && to?.blockId === from.blockId
							? [[from.blockId, from.offset, to.offset - from.offset, args[3]]]
							: [];
					}
				});
			} else if (!keep && ch.kind === 'block')
				ops.push({ op: 'deleteBlock', calls: () => (c.live(b) ? [[b]] : []) });
			else if (!keep && ch.kind === 'split')
				// The block joins the one it was split from.
				ops.push({
					op: 'mergeBlocks',
					calls: () => {
						const into = sourceOf(b);
						return into && c.live(b) ? [[b, into]] : [];
					}
				});
		}
		const rank = (part: DecisionPart) => ('op' in part ? (RANK[part.op] ?? 1) : 0);
		return [
			...[...lists].map(([into, ids]) => ({ into, ids })),
			...ops.sort((a, b) => rank(a) - rank(b))
		];
	};

	/**
	 * Write decision `parts` by the current client, in one transaction: the
	 * id lists, then each operation through `exec` (the bare document's own
	 * operation by default; a view passes its dispatched one).
	 */
	const run = (
		parts: readonly DecisionPart[],
		exec: (op: string, args: unknown[]) => unknown = c.run
	) =>
		write(() =>
			doc.transact(() => {
				for (const part of parts)
					if ('op' in part) for (const args of part.calls()) exec(part.op, args);
					else hold(part);
			})
		);

	/** Every pending change, in document order (the document's data last). */
	const changes = (): SuggestedChange[] => {
		const map = pending();
		return [...map.keys()]
			.sort((a, b) => (a === null ? 1 : b === null ? -1 : c.compare(a, b)))
			.flatMap((b) => map.get(b)!.changes);
	};

	/**
	 * Withdraw suggestion `id` (its author's), written by `w`, a writer of
	 * its author: its pending text and blocks go as a rejection takes them
	 * (its author's own, so directly) and its author's entries are deleted
	 * (a decider's settled lists stay). Nothing of it stays pending.
	 */
	const withdraw = (id: string, w: number) =>
		write(() =>
			doc.transact(() => {
				const { node, writer } = recOf(id);
				const mine = changes().filter(
					(ch) => ch.suggestion === id && ch.kind !== 'delete' && ch.kind !== 'op'
				);
				as(w, () => {
					run(decide(mine, false));
					for (let it = firstItem<Item>(node), at = 0; it; it = it.right)
						if (it.deleted) continue;
						else if (sameAuthor(it.id.client, writer)) node.delete(at, it.length);
						else at += it.length;
				});
				version++;
			})
		);

	/**
	 * The document without its pending suggestions (`toJSON`'s default):
	 * pending inserted units and blocks left out (a pending block's children
	 * take its place), a split's block joined to the block it was split from
	 * (its text after that block's, in their text's order, its children
	 * after that block's own, as a merge shows them), proposals not applied.
	 */
	const base = (data: JSONDoc['data'] | undefined): JSONDoc => {
		const map = pending();
		const kind = (b: BlockId) => map.get(b)?.changes[0]?.kind;
		const emitted = new Map<BlockId, JSONBlock>();
		const joins = new Map<BlockId, [number, JSONBlock['content'], JSONBlock[]][]>();
		const blocks = (ids: readonly BlockId[]): JSONBlock[] =>
			ids.flatMap((id): JSONBlock[] => {
				const kids = blocks(c.childrenIds(id));
				if (kind(id) === 'block') return kids;
				const own = runsView.contentJSON(id) as (JSONText | JSONInlineBlock)[];
				const content = without(own, map.get(id)?.inserted ?? []);
				const into = kind(id) === 'split' && sourceOf(id, (b) => kind(b) === 'split');
				if (into) {
					const { own: o } = view();
					const at = o.streamsIn(o.streamOf(id)!.home).findIndex((s) => s.block === id);
					listOf(joins, into).push([at, content, kids]);
					return [];
				}
				const json: JSONBlock = {
					type: c.blockTypeOf(id) ?? '',
					id,
					data: (c.blockDataOf(id) ?? {}) as JSONBlock['data']
				};
				if (content.length) json.content = content;
				if (kids.length) json.children = kids;
				emitted.set(id, json);
				return [json];
			});
		const children = blocks(c.childrenIds(null));
		for (const [into, list] of joins) {
			const json = emitted.get(into);
			if (!json) continue;
			list.sort((a, b) => a[0] - b[0]);
			const content = without([...(json.content ?? []), ...list.flatMap((j) => j[1] ?? [])], []);
			const kids = [...(json.children ?? []), ...list.flatMap((j) => j[2])];
			if (content.length) json.content = content;
			if (kids.length) json.children = kids;
		}
		return data ? { data, children } : { children };
	};

	return {
		/** A fresh writer this replica writes suggestions under. */
		writer,
		open,
		apply,
		decide,
		run,
		withdraw,
		/** The suggestions the document holds, oldest first. */
		records: (): SuggestionRecord[] => records().recs,
		/** Whether the document holds any suggestion record. */
		any: (): boolean => !root().attrKeys().next().done,
		/** Every pending change, in document order. */
		changes,
		/** The pending changes of block `b` (`[]`: none). */
		at: (b: BlockId): readonly SuggestedChange[] => pending().get(b)?.changes ?? [],
		base,
		/** Bumped by every change of the records. */
		version: () => version,
		/** Be told of every change of the records. Returns the unsubscribe. */
		onChange: (f: () => void) => {
			listeners.add(f);
			return () => void listeners.delete(f);
		},
		/** @internal The work done (blocks read, units walked): the scaling rows count it. */
		debug,
		dispose: () => {
			doc.off('commit', onCommit);
			listeners.clear();
		}
	};
};

export type DocSuggest = ReturnType<typeof docSuggest>;
