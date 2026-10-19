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
 *   the record names the units; a shown one, not settled, is pending. A
 *   block deletion is the same id list naming the block's node.
 * - Nothing else is suggested: a move, a merge, a retype, a data change or
 *   a format is refused (written directly on its author's own pending
 *   block).
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
import { removeUnit } from '../placement/slots.js';
import {
	isRowMark,
	newNode,
	openRangeCursor,
	ownIdsOf,
	proposing,
	writeAs,
	writersOf
} from '../text/model.js';
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
import { effectOf, NOOP, refused } from './plan.js';
import type { DocAnchor, OpResult, Plan, PlanStep, Prepared } from './types.js';
import type { DocBase, DocReads } from './reads.js';

/** One change of a suggestion, as a reviewer sees it. */
export type SuggestedChange = {
	/** The suggestion it is part of (its record's id). */
	readonly suggestion: string;
	/**
	 * `insert`: a run of text it inserts; `delete`: a run it proposes to
	 * delete; `block`: a block it inserts, its text with it; `split`: the
	 * block its split makes; `remove`: a block it proposes to delete.
	 */
	readonly kind: 'insert' | 'delete' | 'block' | 'split' | 'remove';
	/** The block it is in or about. */
	readonly block: BlockId;
	/** Its run, in the block's display offsets (a block's: the whole block). */
	readonly offset: number;
	readonly length: number;
	readonly text: string;
	/** The units a decision names, as the engine names them (`client, clock, len` triples). @internal */
	readonly ids: readonly number[];
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

type Rec = SuggestionRecord & {
	node: EngineNode;
	start: number;
	settled: IdSetOf;
	proposed: IdSetOf;
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
/** A block's pending changes. */
type Pending = SuggestedChange[];
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** What a suggestion refuses, unless on its author's own pending block (`sugg.refused`). */
const REFUSE = ['mergeBlocks', 'setBlockType', 'patchData', 'formatRange'];
/**
 * What a decision does with a change of each kind, accepted and rejected:
 * `1` settles its ids (it stays), `2` holds them (its text goes), `3`
 * deletes its block, `4` holds its writer's text and joins its block to the
 * one it was split from.
 */
const DECIDE: Record<SuggestedChange['kind'], readonly [number, number]> = {
	insert: [1, 2],
	delete: [2, 1],
	block: [1, 3],
	split: [1, 4],
	remove: [3, 1]
};

/** The list `map` keeps at `key` (made empty when absent). */
const listOf = <K, V>(map: Map<K, V[]>, key: K): V[] => map.get(key) ?? map.set(key, []).get(key)!;

/** Append unit `client:clock` to the id triples `ids`, extending the last one when it continues it. */
const push = (ids: number[], client: number, clock: number) => {
	const n = ids.length;
	if (ids[n - 3] === client && ids[n - 2]! + ids[n - 1]! === clock) ids[n - 1] = ids[n - 1]! + 1;
	else ids.push(client, clock, 1);
};

export type SuggestContext = DocBase &
	DocReads & {
		write: <R>(fn: () => R) => R;
		anchorAt: (id: BlockId, offset: number, affinity?: 'left' | 'right') => DocAnchor | null;
		resolveAnchor: (anchor: DocAnchor) => { blockId: BlockId; offset: number } | null;
		/** Write in one transaction and one attribution frame (the funnel's). */
		framed: (fn: () => void) => boolean;
		apply: (p: Prepared) => OpResult;
		/** Run document operation `op` (`apply(prepare[op](…args))`). */
		run: (op: string, args: unknown[]) => OpResult;
	};

/** The document's shared suggestions (`facade.suggest`). */
export const docSuggest = (c: SuggestContext) => {
	const { Y, doc, runsView, view, write } = c;
	const ops = engineOps(Y);
	const { idSet } = ops;
	const root = (): EngineNode => doc.get(SUGGEST_ROOT);
	const actorOf = (client: number): string | undefined => {
		const bound = doc.get(ATTRIBUTION_ROOT).getAttr(`c/${client}`);
		return typeof bound === 'string' ? bound : undefined;
	};
	const as = <R>(client: number, fn: () => R): R => writeAs(doc, client, fn);

	// ── the records ─────────────────────────────────────────────────────

	type Table = {
		recs: Rec[];
		byWriter: Map<number, Rec[]>;
		/** The records holding a proposal. */
		proposing: Rec[];
	};
	/** Bumped by every change of the records (a commit, or a write of this part). */
	let version = 0;
	let table: { v: number; t: Table } | null = null;

	const records = (): Table => {
		if (table?.v === version) return table.t;
		const t: Table = { recs: [], byWriter: new Map(), proposing: [] };
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
				settled: idSet(),
				proposed: idSet()
			};
			for (let it = firstItem<Item>(node); it !== null; it = it.right) {
				const ids = it.content.ids;
				if (!it.deleted && ids)
					for (let i = 0; i < ids.length; i += 3)
						(it.id.client === writer ? rec.proposed : rec.settled).add(
							ids[i]!,
							ids[i + 1]!,
							ids[i + 2]!
						);
			}
			if (rec.proposed.clients.size) t.proposing.push(rec);
			t.recs.push(rec);
			listOf(t.byWriter, writer).push(rec);
		}
		for (const recs of t.byWriter.values()) recs.sort((a, b) => a.start - b.start);
		t.recs.sort((a, b) => a.at - b.at || a.start - b.start);
		table = { v: version, t };
		return t;
	};

	/**
	 * The record whose clocks hold `client:clock` (its writer's latest opened
	 * before it), when it is pending there (not settled).
	 */
	const pendingIn = (client: number, clock: number): Rec | undefined => {
		const rec = records()
			.byWriter.get(client)
			?.findLast((r) => r.start <= clock);
		return rec && !rec.settled.has(client, clock) ? rec : undefined;
	};
	/** The records proposing to delete unit `client:clock` (not settled there). */
	const proposersOf = (client: number, clock: number) =>
		records().proposing.filter(
			(r) => r.proposed.has(client, clock) && !r.settled.has(client, clock)
		);
	/** The id of block `b`'s node: what its creation and a proposal of its deletion name. */
	const bornOf = (b: BlockId | undefined) => {
		const node = b === undefined ? null : blockNodeOf(doc, b);
		return node && itemOf<Item>(node)!.id;
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
	 * stream before `b`'s in its text (`null`: none
	 * is shown; `undefined`: `b` was not split).
	 */
	const sourceOf = (b: BlockId) => {
		const { own } = view();
		const s = own.streamOf(b);
		if (s === undefined || s.home === b) return undefined;
		const streams = own.streamsIn(s.home);
		for (let i = streams.findIndex((x) => x.block === b) - 1; i >= 0; i--) {
			const owner = own.ownerOf(streams[i]!.block);
			if (typeof owner === 'string' && c.live(owner)) return owner;
		}
		return null;
	};

	/** `b`'s pending changes, read from the state now (`null`: none). */
	const compute = (b: BlockId): Pending | null => {
		const units = unitsOf(b);
		const born = bornOf(b);
		// A split whose source is gone is no longer one: its writer's text is an insertion.
		const split = sourceOf(b);
		const maker = born && split !== null ? pendingIn(born.client, born.clock) : undefined;
		const out: SuggestedChange[] = [];
		const runs = new Map<string, Mutable<SuggestedChange> & { ids: number[] }>();
		/** Its maker's units: shown as the block's change, in one piece. */
		const made: number[] = [];
		const add = (rec: Rec, kind: 'insert' | 'delete', u: Unit) => {
			const run = runs.get(kind + rec.id);
			if (run && run.offset + run.length === u.offset) {
				run.length++;
				run.text += u.char;
				return push(run.ids, u.client, u.clock);
			}
			if (run) out.push(run);
			runs.set(kind + rec.id, {
				suggestion: rec.id,
				kind,
				block: b,
				offset: u.offset,
				length: 1,
				text: u.char,
				ids: [u.client, u.clock, 1]
			});
		};
		for (const u of units) {
			const rec = pendingIn(u.client, u.clock);
			if (rec && rec === maker) push(made, u.client, u.clock);
			else if (rec) add(rec, 'insert', u);
			for (const r of proposersOf(u.client, u.clock)) add(r, 'delete', u);
		}
		out.push(...runs.values());
		out.sort((x, y) => x.offset - y.offset);
		const whole = (rec: Rec, kind: SuggestedChange['kind'], ids: number[]) => ({
			suggestion: rec.id,
			kind,
			block: b,
			offset: 0,
			length: units.length,
			text: units.map((u) => u.char).join(''),
			ids: [born!.client, born!.clock, 1, ...ids]
		});
		if (maker) out.unshift(whole(maker, split ? 'split' : 'block', made));
		// A record whose id list names the block's node proposes deleting the block.
		for (const r of born ? proposersOf(born.client, born.clock) : [])
			out.push(whole(r, 'remove', []));
		return out.length ? out : null;
	};

	/** Every block the records' writers and proposals are in (a proposal naming a block's node included). */
	const candidates = (): Set<BlockId> => {
		const t = records();
		const out = new Set<BlockId>();
		const texts = new Set<EngineNode>();
		const clients = clientsOf(doc) as unknown as Map<number, Item[]>;
		/** Note where the structs of `client` from `from` to `to` (exclusive) are. */
		const each = (client: number, from: number, to: number) => {
			const structs = clients.get(client) ?? [];
			// Past what this replica holds: nothing.
			if (from >= storeOf(doc).getClock(client)) return;
			for (
				let k = Y.findIndexSS(structs as never[], from);
				k < structs.length && structs[k]!.id.clock < to;
				k++
			) {
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

	/** The pending changes per block, read again after any write. */
	let memo: { v: string; map: Map<BlockId, Pending> } | null = null;
	const pending = (): Map<BlockId, Pending> => {
		const v = `${version}.${runsView.version()}`;
		if (memo?.v === v) return memo.map;
		const map = new Map<BlockId, Pending>();
		for (const b of records().recs.length ? candidates() : []) {
			const p = c.live(b) ? compute(b) : null;
			if (p) map.set(b, p);
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
			ownIdsOf(doc).add(w, from, storeOf(doc).getClock(w) - from);
			version++;
			return id;
		});

	const recOf = (id: string): Rec => records().recs.find((r) => r.id === id)!;

	/** Two writers of one author (the same writer, or bound to the same actor). */
	const sameAuthor = (a: number, b: number) =>
		a === b || (!!actorOf(a) && actorOf(a) === actorOf(b));
	/** `client:clock` is a pending insertion of `w`'s author: its edits are direct. */
	const ownPending = (client: number, clock: number, w: number) =>
		!!pendingIn(client, clock) && sameAuthor(client, w);
	/** Block `b` is a pending insertion of `w`'s author. */
	const ownBlock = (b: BlockId | undefined, w: number) => {
		const id = bornOf(b);
		return !!id && ownPending(id.client, id.clock, w);
	};

	/** Append id list `ids` (YP31) to record `rec`'s list, as the current client. */
	const entry = (rec: Rec, ids: number[]) => {
		rec.node.hold(ids);
		version++;
	};

	/**
	 * The block each step of plan `p` is about: a merge's, the block it
	 * merges away; a retype of a child a block deletion of `p` promotes, the
	 * deleted block (it follows that deletion: written with it, or read again
	 * when the deletion is accepted).
	 */
	const about = (p: Plan) => {
		const removed = new Set(p.writes.flatMap((s) => (s.op === 'deleteBlock' ? s.removes : [])));
		return (s: PlanStep): BlockId | undefined => {
			const up = s.op === 'setBlockType' ? c.positionOf(s.id)?.parent : null;
			return up && removed.has(up) ? up : 'from' in s ? s.from : 'id' in s ? s.id : undefined;
		};
	};

	/**
	 * Write plan `p` as suggestion `id` (a new one of writer `w` when `null`
	 * or gone: the view's suggesting mode), by the suggestion's writer, in one frame:
	 * insertions are written; a text delete proposes the units that are not
	 * its author's pending ones (those go), the engine hiding them until the
	 * plan ends so its later steps read the offsets they were prepared with
	 * (fork patch YP32: an insertion at a proposed deletion lands after it);
	 * a block delete proposes the blocks it removes by their nodes (its
	 * author's own go). A plan that moves blocks, or merges, retypes,
	 * changes data or formats what is not its author's own pending block, is
	 * refused, nothing written (`sugg.refused`). Answers the result, the
	 * suggestion and where the plan's caret is now, the proposed text shown.
	 */
	const apply = (
		id: string | null,
		p: Prepared,
		w = recOf(id!).writer
	): { result: OpResult; id?: string; at?: { block: BlockId; offset: number } } => {
		if (!('writes' in p)) return { result: p };
		const at = about(p);
		const [writes, blocks]: [PlanStep[], number[]] = [[], []];
		for (const s of p.writes)
			if (s.op === 'moveBlocks') return { result: refused('suggesting') };
			else if (ownBlock(at(s), w) || (!REFUSE.includes(s.op) && s.op !== 'deleteBlock'))
				writes.push(s);
			else if (s.op === 'deleteBlock')
				for (const r of s.removes) {
					const { client, clock } = bornOf(r)!;
					blocks.push(client, clock, 1);
				}
			// A promoted child's retype follows its deletion: read again when it is accepted.
			else if (s.op !== 'setBlockType' || at(s) === s.id) return { result: refused('suggesting') };
		const rec = (id !== null && recOf(id)) || recOf(open({ writer: w }));
		return write(() =>
			doc.transact((tr: unknown) =>
				as(w, () => {
					let result = NOOP;
					let anchor: DocAnchor | null;
					proposing.set(doc, {
						into: rec.node,
						sort: (client, clock) =>
							ownPending(client, clock, w)
								? 1
								: rec.proposed.has(client, clock) && !rec.settled.has(client, clock)
									? 3
									: 2
					});
					try {
						if (writes.length)
							result = c.apply({
								...p,
								writes,
								effect: effectOf(writes),
								version: runsView.version()
							} as Plan);
						anchor = p.at ? c.anchorAt(p.at.block, p.at.offset, 'right') : null;
					} finally {
						proposing.delete(doc);
						ops.unhide(tr);
					}
					if (blocks.length) {
						entry(rec, blocks);
						result = { status: 'applied', ids: p.ids };
					}
					version++;
					const caret = anchor && c.resolveAnchor(anchor);
					return {
						result,
						id: rec.id,
						...(caret && { at: { block: caret.blockId, offset: caret.offset } })
					};
				})
			)
		);
	};

	/**
	 * Remove blocks `ids` for real: their home slots and registry entries,
	 * so their content is collected (a live answer's last chunk, which its
	 * writer rewrites whole and no history step holds).
	 */
	const erase = (ids: readonly BlockId[]) =>
		write(() =>
			doc.transact(() => {
				for (const id of ids) {
					const home = view().blocks.get(id)?.home;
					if (home) removeUnit(doc, home);
					registryOf(doc).deleteAttr(id);
				}
			})
		);

	/** Write decision part `part` (an id list) by the current client: settled in its record, or held. */
	const hold = ({ into, ids }: { into: string | null; ids: number[] }): void =>
		void (into === null
			? c.framed(() => doc.get(TEXT_DELETES_ROOT).hold(ids))
			: write(() => entry(recOf(into), ids)));

	/**
	 * What accepting (`accept`) or rejecting `changes` writes, in the order
	 * it runs ({@link DECIDE}): the id lists first (what stays settled in its
	 * record, the text that goes held by the decider), then the merges, then
	 * the block deletes, each reading its arguments when it runs.
	 */
	const decide = (changes: readonly SuggestedChange[], accept: boolean): DecisionPart[] => {
		const lists = new Map<string | null, number[]>();
		const [merges, deletes]: DecisionPart[][] = [[], []];
		for (const { kind, block: b, suggestion, ids } of changes) {
			const act = DECIDE[kind][accept ? 0 : 1];
			if (act === 3) deletes.push({ op: 'deleteBlock', calls: () => (c.live(b) ? [[b]] : []) });
			else listOf(lists, act === 1 ? suggestion : null).push(...(act === 4 ? ids.slice(3) : ids));
			if (act === 4)
				merges.push({
					op: 'mergeBlocks',
					calls: () => {
						const into = sourceOf(b);
						return into && c.live(b) ? [[b, into]] : [];
					}
				});
		}
		return [...[...lists].map(([into, ids]) => ({ into, ids })), ...merges, ...deletes];
	};

	/**
	 * Write decision `parts` by client `w` (the current one by default; its
	 * author's rejection, by a writer of theirs), in one transaction: the id
	 * lists, then each operation through `exec` (the bare document's own
	 * operation by default; a view passes its dispatched one).
	 */
	const run = (
		parts: readonly DecisionPart[],
		exec: (op: string, args: unknown[]) => unknown = c.run,
		w = doc.clientID
	) =>
		write(() =>
			doc.transact(() =>
				as(w, () => {
					for (const part of parts)
						if ('op' in part) for (const args of part.calls()) exec(part.op, args);
						else hold(part);
				})
			)
		);

	/** Every pending change, in document order. */
	const changes = (): SuggestedChange[] => {
		const map = pending();
		return [...map.keys()].sort(c.compare).flatMap((b) => map.get(b)!);
	};

	return {
		/** A fresh writer this replica writes suggestions under. */
		writer,
		open,
		apply,
		erase,
		decide,
		run,
		/** The suggestions the document holds, oldest first. */
		records: (): SuggestionRecord[] => records().recs,
		/** Whether the document holds any suggestion record. */
		any: (): boolean => !root().attrKeys().next().done,
		/** Every pending change, in document order. */
		changes,
		/** The pending changes of block `b` (`[]`: none). */
		at: (b: BlockId): readonly SuggestedChange[] => pending().get(b) ?? [],
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
