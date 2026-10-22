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
 *
 * The part is built over a document by {@link suggestionsOf} (the shared
 * suggestions plugin, the room, a bare document on a server): once built,
 * the document's `toJSON()` leaves its pending suggestions out. A document
 * no one built it over reads its suggestions' content as plain content.
 */
import type { EngineDoc, EngineNode } from '../engine-api.js';
import {
	ATTRIBUTION_ROOT,
	CONTENT_NODE,
	isNodeLike,
	SUGGEST_ROOT,
	TEXT_DELETES_ROOT
} from '../schema.js';
import { blockNodeOf, registryOf, type BlockId } from '../placement/model.js';
import { isRowMark, newNode, openRangeCursor, ownTextIds, proposing } from '../text/model.js';
import {
	asYDoc,
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
import type { DocAnchor, EdytorDocConfig, OpResult, Plan, PlanStep, Prepared } from './types.js';
import type { DocBase, DocReads } from './reads.js';
import type { JSONDoc } from '../../utils/json.js';
import type { EdytorDocument } from '../document.js';
import { keepingReplaced } from '../incarnations.js';
import {
	ACTOR_PREFIX,
	CLIENT_PREFIX,
	profileOf,
	sanitizeProfile
} from '../attribution/attribution.js';
import { bindBlockAttribution } from '../attribution/block.js';

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
	| { into: string | null; ids: number[]; blocks?: BlockId[] }
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

/** What the part reads of its document beyond the facade: the facade's `part` (`edytor-doc.ts`). */
export type SuggestContext = DocBase &
	DocReads & {
		config: EdytorDocConfig;
		/** A facade over another doc, with `config`. */
		create: (doc: EngineDoc, config: EdytorDocConfig) => SuggestFacade;
		/** Its changes no index fact shows: counted in the facade's `version`. */
		v: number;
		/**
		 * The document without its pending suggestions, read by `read` (the
		 * export `toJSON()` gives unless asked for the suggestions);
		 * `undefined` while none is pending.
		 */
		base: (<T>(read: (other: SuggestFacade) => T) => T | undefined) | undefined;
	};

/** The facade the part is built over: its `part`, and the operations it writes through. */
export type SuggestFacade = {
	part: SuggestContext;
	toJSON: (options?: { suggestions?: boolean }) => JSONDoc;
	dispose: () => void;
	apply: (p: Prepared, quiet?: boolean) => OpResult;
	transact: <R>(fn: () => R) => R;
	anchorAt: (id: BlockId, offset: number, affinity?: 'left' | 'right') => DocAnchor | null;
	resolveAnchor: (anchor: DocAnchor) => { blockId: BlockId; offset: number } | null;
	/** Its operations by name (`f[op](…args)`). */
	[op: string]: unknown;
};

const parts = new WeakMap<SuggestContext, DocSuggest>();

/**
 * The shared suggestions of the document `facade` is over, built once:
 * from then on, its `toJSON()` leaves the pending ones out (`sugg.json.base`).
 */
export const suggestionsOf = (facade: SuggestFacade): DocSuggest =>
	parts.get(facade.part) ?? parts.set(facade.part, docSuggest(facade)).get(facade.part)!;

/**
 * Build the shared suggestions over `document`, a document read without a
 * view (on a server, in a worker): its `toJSON()` leaves the pending ones
 * out from then on, as a view's with the shared suggestions plugin does. A
 * document no one built them over reads their content as plain content.
 */
export const adoptSharedSuggestions = (document: EdytorDocument): void =>
	void suggestionsOf(document.facade as SuggestFacade);

/** The document's shared suggestions ({@link suggestionsOf}), built over facade `f`. */
const docSuggest = (f: SuggestFacade) => {
	const c = f.part;
	const { Y, doc, runsView, view } = c;
	const BA = bindBlockAttribution(Y);
	const ops = engineOps(Y);
	const { idSet } = ops;
	const root = (): EngineNode => doc.get(SUGGEST_ROOT);
	const actorOf = (client: number): string | undefined => {
		const bound = doc.get(ATTRIBUTION_ROOT).getAttr(`c/${client}`);
		return typeof bound === 'string' ? bound : undefined;
	};
	/**
	 * Run `fn` in a transaction (`tr`) writing as `client` (a suggestion's
	 * writer), then as before: the transaction names the writer, so a
	 * history replays its step under it (`StackItem.writer`).
	 */
	const as = <R>(client: number, fn: (tr: unknown) => R): R =>
		f.transact(() =>
			doc.transact((tr: unknown) => {
				const local = doc.clientID;
				if (client !== local) (tr as { writer?: number }).writer = client;
				doc.clientID = client;
				try {
					return fn(tr);
				} finally {
					doc.clientID = local;
				}
			})
		);
	/** The writers this replica minted: client ids it writes suggestions under besides its own. */
	const writers = new Set<number>();

	// ── the records ─────────────────────────────────────────────────────

	type Table = {
		recs: Rec[];
		byWriter: Map<number, Rec[]>;
		/** The records holding a proposal. */
		proposing: Rec[];
	};
	/** Bumped by every change of the records (a commit, or a write of this part); the facade's `version` too. */
	let version = 0;
	const bump = () => {
		version++;
		c.v++;
	};
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
			// Not itself: a block merged into it shows its stream there.
			if (typeof owner === 'string' && owner !== b && c.live(owner)) return owner;
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
		bump();
		for (const f of listeners) f();
	};
	doc.on('commit', onCommit);

	// ── writes ──────────────────────────────────────────────────────────

	/** A fresh writer this replica writes suggestions under. */
	const writer = (): number => {
		let w = 0;
		while (!w || w === doc.clientID || storeOf(doc).getClock(w))
			w = (nonceOf(doc) | 0x4000000) >>> 0;
		writers.add(w);
		return w;
	};

	/**
	 * Bind writer `w` to this replica's actor, written by `w` itself, once
	 * (`sugg.writer.binding`), and the actor's profile when the stored one
	 * differs: inside the writer's first transaction.
	 */
	const bind = (w: number) => {
		const actor = c.config.actor?.();
		const attr = doc.get(ATTRIBUTION_ROOT);
		if (!actor || !writers.has(w) || attr.getAttr(CLIENT_PREFIX + w) !== undefined) return;
		attr.setAttr(CLIENT_PREFIX + w, actor.id);
		const next = profileOf(actor);
		const stored = sanitizeProfile(attr.getAttr(ACTOR_PREFIX + actor.id));
		if (stored.name !== next.name || stored.color !== next.color)
			attr.setAttr(ACTOR_PREFIX + actor.id, next);
	};

	/**
	 * Open a suggestion written by `writer` (a fresh writer by default): its
	 * record, in no history step. Answers its id.
	 */
	const open = (
		options: { id?: string; writer?: number; via?: string; label?: string; at?: number } = {}
	): string =>
		f.transact(() => {
			const w = options.writer ?? writer();
			const id = options.id ?? mint('s');
			const from = storeOf(doc).getClock(w);
			as(w, () => {
				bind(w);
				root().setAttr(id, newNode('suggestion'));
				const rec = root().getAttr(id) as EngineNode;
				rec.setAttr('at', options.at ?? Date.now());
				if (options.via) rec.setAttr('via', options.via);
				if (options.label) rec.setAttr('lbl', options.label);
			});
			// No history step captures the record's creation: its clocks stay its own.
			const own = ownTextIds.get(doc) ?? ownTextIds.set(doc, idSet()).get(doc)!;
			own.add(w, from, storeOf(doc).getClock(w) - from);
			bump();
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
		bump();
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
		return as(w, (tr) => {
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
					result = f.apply(
						{ ...p, writes, effect: effectOf(writes), version: runsView.version() } as Plan,
						true
					);
				anchor = p.at ? f.anchorAt(p.at.block, p.at.offset, 'right') : null;
			} finally {
				proposing.delete(doc);
				ops.unhide(tr);
			}
			if (blocks.length) {
				entry(rec, blocks);
				result = { status: 'applied', ids: p.ids };
			}
			bump();
			const caret = anchor && f.resolveAnchor(anchor);
			return {
				result,
				id: rec.id,
				...(caret && { at: { block: caret.blockId, offset: caret.offset } })
			};
		});
	};

	/**
	 * Write decision part `part` (an id list) by the current client: settled
	 * in its record, or held, the text that goes: its blocks stamped as
	 * changed by the decider, as a text delete stamps them.
	 */
	const hold = ({ into, ids, blocks = [] }: Extract<DecisionPart, { ids: number[] }>): void =>
		f.transact(() => {
			if (into !== null) return entry(recOf(into), ids);
			doc.get(TEXT_DELETES_ROOT).hold(ids);
			const actor = c.config.actor?.();
			for (const b of actor ? blocks : []) {
				const node = blockNodeOf(doc, b);
				if (node) BA.stampChange(doc, node, b, actor!.id);
			}
		});

	/**
	 * What accepting (`accept`) or rejecting `changes` writes, in the order
	 * it runs ({@link DECIDE}): the id lists first (what stays settled in its
	 * record, the text that goes held by the decider), then the merges, then
	 * the block deletes, each reading its arguments when it runs.
	 */
	const decide = (changes: readonly SuggestedChange[], accept: boolean): DecisionPart[] => {
		const lists = new Map<string | null, number[]>();
		const gone = new Set<BlockId>();
		const [merges, deletes]: DecisionPart[][] = [[], []];
		for (const { kind, block: b, suggestion, ids } of changes) {
			const act = DECIDE[kind][accept ? 0 : 1];
			if (act === 2) gone.add(b);
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
		return [
			...[...lists].map(([into, ids]) => ({
				into,
				ids,
				...(into === null && { blocks: [...gone] })
			})),
			...merges,
			...deletes
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
		exec: (op: string, args: unknown[]) => unknown = (op, args) =>
			(f[op] as (...a: unknown[]) => unknown)(...args),
		w = doc.clientID
	) =>
		as(w, () => {
			bind(w);
			for (const part of parts)
				if ('op' in part) for (const args of part.calls()) exec(part.op, args);
				else hold(part);
		});

	/** Every pending change, in document order. */
	const changes = (): SuggestedChange[] => {
		const map = pending();
		return [...map.keys()].sort(c.compare).flatMap((b) => map.get(b)!);
	};

	/**
	 * The document without its pending suggestions (`sugg.json.base`), read
	 * by `read`: on a copy, every pending one rejected; `undefined` while
	 * none is pending.
	 */
	const base = <T>(read: (other: SuggestFacade) => T): T | undefined => {
		if (root().attrKeys().next().done || !changes().length) return;
		const { Y } = c;
		const copy = keepingReplaced(new Y.Doc());
		Y.applyUpdate(copy, Y.encodeStateAsUpdate(asYDoc(doc)));
		const other = c.create(copy as EngineDoc, { ...c.config, actor: undefined });
		const all = suggestionsOf(other);
		all.run(all.decide(all.changes(), false));
		const out = read(other);
		all.dispose();
		other.dispose();
		copy.destroy();
		return out;
	};
	c.base = base;

	return {
		/** A fresh writer this replica writes suggestions under. */
		writer,
		/** The writers this replica minted (a history tags their steps, `StackItem.writer`). */
		writers,
		open,
		apply,
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
