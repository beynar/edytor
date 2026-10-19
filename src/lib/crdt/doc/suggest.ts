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
import { isRowMark, newNode, openRangeCursor, ownTextIds, writersOf } from '../text/model.js';
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
import type { OpResult, Plan, PlanStep, Prepared } from './types.js';
import type { DocBase, DocReads } from './reads.js';

/** `[client, clock, length]`: the units a decision names. */
export type IdRange = [client: number, clock: number, length: number];

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
	/** The units a decision names. @internal */
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

type Rec = SuggestionRecord & {
	node: EngineNode;
	start: number;
	end: number;
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

export type SuggestContext = DocBase &
	DocReads & {
		write: <R>(fn: () => R) => R;
		/** Write in one transaction and one attribution frame (the funnel's). */
		framed: (fn: () => void) => boolean;
		apply: (p: Prepared) => OpResult;
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
				end: Infinity,
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
		const whole = (suggestion: string, kind: 'block' | 'split' | 'remove', ids: IdRange[]) => ({
			suggestion,
			kind,
			block: b,
			offset: 0,
			length: units.length,
			text: units.map((u) => u.char).join(''),
			ids
		});
		let last = -2;
		for (const u of units) {
			const rec = pendingIn(u.client, u.clock);
			if (rec && rec === maker) {
				// A range of the block's own writer is shown in one piece.
				push(made, u.client, u.clock, last === u.offset - 1);
				last = u.offset;
			} else if (rec) touch(rec, 'insert', u);
			for (const r of t.proposing)
				if (r.proposed.has(u.client, u.clock) && !r.settled.has(u.client, u.clock))
					touch(r, 'delete', u);
		}
		changes.push(...open.values());
		changes.sort((x, y) => x.offset - y.offset);
		if (maker) changes.unshift(whole(maker.id, split ? 'split' : 'block', made));
		// A record whose id list names the block's node proposes deleting the block.
		for (const r of born ? t.proposing : [])
			if (r.proposed.has(born!.client, born!.clock) && !r.settled.has(born!.client, born!.clock))
				changes.push(whole(r.id, 'remove', [[born!.client, born!.clock, 1]]));
		return changes.length ? changes : null;
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
	 * Whether plan `p` cannot be written as a suggestion of writer `w`
	 * (`sugg.refused`): it moves blocks, or merges, retypes, changes data or
	 * formats what is not its author's own pending block.
	 */
	const refuses = (p: Plan, w: number): boolean => {
		const at = about(p);
		return p.writes.some(
			(s) =>
				s.op === 'moveBlocks' ||
				(REFUSE.includes(s.op) &&
					!ownBlock(at(s), w) &&
					!(s.op === 'setBlockType' && at(s) !== s.id))
		);
	};

	/**
	 * Write plan `p` as suggestion `id` (the view's suggesting mode), by the
	 * suggestion's writer: insertions are written, a text delete proposes
	 * the units that are not its author's pending ones (those go), a block
	 * delete proposes the blocks it removes (its author's own go), and a plan
	 * it {@link refuses} writes nothing. Later steps' offsets, prepared with
	 * the proposed text gone, step over it (an insertion lands after it).
	 * Answers the result and where the plan's caret is now.
	 */
	const apply = (
		id: string,
		p: Prepared
	): { result: OpResult; at?: { block: BlockId; offset: number } } => {
		if (!('writes' in p)) return { result: p };
		const rec = recOf(id);
		const w = rec.writer;
		if (refuses(p, w)) return { result: refused('suggesting') };
		const at = about(p);
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
		const propose = (ids: number[]) => {
			flush();
			entry(rec, ids);
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
						else if (s.op === 'deleteText' || s.op === 'removeInline') {
							flush();
							const { units } = range(s.id, s.offset, 'length' in s ? s.length : 1);
							const own = units.filter((u) => ownPending(u.client, u.clock, w));
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
						} else if (ownBlock(at(s), w)) batch.push(s);
						else if (s.op === 'deleteBlock')
							// The blocks it removes, named by their nodes.
							propose(
								s.removes.flatMap((r) => {
									const { client, clock } = itemOf<Item>(blockNodeOf(doc, r)!)!.id;
									return [client, clock, 1];
								})
							);
						// What else is not its author's is a promoted child's kind, re-read on accept.
					}
					flush();
					return wrote ? { status: 'applied', ids: p.ids } : NOOP;
				})
			)
		);
		const caret = p.at && { block: p.at.block, offset: range(p.at.block, p.at.offset, 0).at };
		return { result, ...(caret && { at: caret }) };
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
	 * it runs: the id lists first (what stays settled in its record, the
	 * text that goes held by the decider), then the operations, structure
	 * last, each reading its arguments when it runs.
	 */
	const decide = (changes: readonly SuggestedChange[], accept: boolean): DecisionPart[] => {
		const lists = new Map<string | null, number[]>();
		const ops: DecisionPart[] = [];
		for (const ch of changes) {
			const b = ch.block;
			const keep = ch.kind === 'delete' || ch.kind === 'remove' ? !accept : accept;
			// What stays is settled; a block that goes goes by its operation, a rejected split's writer text is held.
			if (keep || (ch.kind !== 'block' && ch.kind !== 'remove'))
				listOf(lists, keep ? ch.suggestion : null).push(
					...(keep || ch.kind !== 'split' ? ch.ids : ch.ids.slice(1)).flat()
				);
			if (!keep && (ch.kind === 'block' || ch.kind === 'remove'))
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
		refuses,
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
