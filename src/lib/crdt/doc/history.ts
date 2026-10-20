/**
 * The document's history: the one undo manager (fork patch YP18 removed the
 * engine's). It captures the tracked local transactions that write in its
 * scope (the block registry, the text hold records, the document's data)
 * into steps, and an undo or a redo replays a step in one transaction over
 * the engine's struct primitives (`redoItem`, `keepItem`). Its rules: a text
 * delete is a hold record (fork patch YP20), so undoing it deletes the record
 * and the text shows again unless another writer's record holds it
 * (`hist.undo.restore`); undoing typing holds the typed text; an undone
 * creation is withdrawn (`hist.undo.withdraw`), an overwritten attr is
 * repaired, the stack keeps `limit` steps, the purge horizon drops the
 * steps below it (`hist.purge.horizon`), and a session's end releases them
 * all (`hist.release.end`).
 */
import { getUnixTime } from 'lib0-v14/time';
import type { EngineApi, EngineDoc, EngineNode } from '../engine-api.js';
import { openSteps, ownTextIds } from '../text/model.js';
import { readHorizon } from '../purge.js';
import {
	BLOCK_NODE,
	CONTENT_NODE,
	DATA_LEAF_PREFIX,
	DEL_PREFIX,
	DOC_DATA_ROOT,
	HORIZON_ROOT,
	INLINE_NODE,
	LAST_CHANGED_ATTR,
	RELEASE_ROOT,
	SUGGEST_ROOT,
	TEXT_DELETES_ROOT,
	TYPE,
	WITHDRAW_PREFIX
} from '../schema.js';
import {
	changedUnder,
	collectable,
	collectNow,
	collects,
	dropSearchMarkers,
	engineOps,
	walkIdSet,
	type IdSetOf,
	type StoreStruct
} from '../structs.js';
import { isInitialized } from './gate.js';
import { DocumentDestroyedError, type WriteFunnel } from './funnel.js';
import type { DocBase } from './reads.js';
import { registryOf, withdrawOnUndo } from '../placement/model.js';

/** The undo steps a document's history keeps by default: older ones are released. */
export const DEFAULT_HISTORY_LIMIT = 200;
/** The origin of the transaction that releases a dropped history step's content. */
const HISTORY_TRIM = Symbol('edytor.history.trim');

/** One undo or redo step: what its transactions inserted and deleted, and what the views keep on it. */
export class StackItem {
	/** Per-view metadata (`session/history.ts`: the selections around the step). */
	readonly meta = new Map<string, unknown>();
	/**
	 * The client it was written under when that is not the replica's own (a
	 * suggestion's writer: its transaction's `writer`): it replays under it,
	 * and its records release with the history's.
	 */
	declare writer?: number;
	constructor(
		public inserts: IdSetOf,
		public deletes: IdSetOf
	) {}
}

/** A step taken into a stack: added (a new step) or updated (the open one took a transaction). */
export type StepEvent = { stackItem: StackItem; origin: unknown; type: 'undo' | 'redo' };

/** What a history captures: its transaction view. */
type Tr = {
	origin: unknown;
	local: boolean;
	/** The client a part wrote it under, when not the replica's own (a suggestion's writer). */
	writer?: number;
	insertSet: IdSetOf;
	deleteSet: IdSetOf;
	changed: Map<unknown, Set<string | null>>;
};

export type HistoryOptions = {
	/** The origins whose transactions are captured (by identity, or by constructor). Default `{ null }`. */
	trackedOrigins?: Set<unknown>;
	/** Transactions closer together than this many milliseconds merge into one step. Default 500. */
	captureTimeout?: number;
	/** The undo steps kept; older ones are released. Default {@link DEFAULT_HISTORY_LIMIT}. */
	limit?: number;
	/** Whether a tracked transaction is captured at all. Default: every one. */
	captureTransaction?: (tr: { local?: boolean; origin?: unknown }) => boolean;
};

/** What a history is made over: the document and the rules of its replay. */
export type Rules = {
	Y: EngineApi;
	doc: EngineDoc;
	scope: EngineNode[];
	/** The records list a replay's text holds go to (fork patch YP20). */
	records: EngineNode;
	/** Whether an item a replay would delete is withdrawn instead (`hist.undo.withdraw`). */
	withdraw(item: StoreStruct, step: StackItem): boolean;
	/** Repair the attrs a replay left undefined. */
	repair(step: StackItem): void;
};

/** The single-value attrs a history step must never leave undefined. */
const REPAIRED: Record<string, readonly string[]> = {
	[BLOCK_NODE]: [TYPE, LAST_CHANGED_ATTR],
	[INLINE_NODE]: [TYPE]
};

/** A unit of a block's text: a character or an inline atom (what a hold record holds). */
const isUnit = (it: StoreStruct): boolean => {
	const content = (it as { content?: { str?: unknown; type?: { name?: string } } }).content;
	return (
		it.parentSub === null &&
		(it.parent as { name?: string } | undefined)?.name === CONTENT_NODE &&
		(typeof content?.str === 'string' || content?.type?.name === INLINE_NODE)
	);
};

/**
 * A document's undo manager: the undo and redo stacks of the tracked local
 * transactions in its scope. `undo()`/`redo()` replay the top step and
 * return it (`null`: nothing changed); `stopCapturing()` closes the open
 * step; `clear()` drops every step and releases what they kept.
 */
export class UndoManager {
	undoStack: StackItem[] = [];
	redoStack: StackItem[] = [];
	/** Whether an `undo()` is replaying (its transaction is captured into the redo stack). */
	undoing = false;
	redoing = false;
	/** The step a replay applies, while its transaction runs. */
	currStackItem: StackItem | null = null;
	/** When the open step last took a transaction (ms since the epoch; 0: no open step). */
	lastChange = 0;
	captureTimeout: number;
	readonly trackedOrigins: Set<unknown>;
	captureTransaction: (tr: { local?: boolean; origin?: unknown }) => boolean;
	readonly limit: number;
	readonly doc: EngineDoc;
	readonly #rules: Rules;
	readonly #ops: ReturnType<typeof engineOps>;
	readonly #observers = new Set<(event: StepEvent, added: boolean) => void>();
	/** What dropped steps released (an item is released once every step that deleted it is gone). */
	readonly #released: IdSetOf;
	readonly #horizon: EngineNode;
	/** A captured step wrote a block's delete or withdraw mark: the session's end records its release. */
	#marked = false;
	/** The session ended (`end()`): nothing more is released. */
	#ended = false;

	constructor(rules: Rules, options: HistoryOptions = {}) {
		this.#rules = rules;
		this.#ops = engineOps(rules.Y);
		this.#released = this.#ops.idSet();
		this.doc = rules.doc;
		this.#horizon = rules.doc.get(HORIZON_ROOT);
		this.captureTimeout = options.captureTimeout ?? 500;
		this.limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
		this.captureTransaction = options.captureTransaction ?? (() => true);
		this.trackedOrigins = options.trackedOrigins ?? new Set([null]);
		// Its own replays are tracked: an undo's transaction becomes a redo step.
		this.trackedOrigins.add(this);
		this.#ops.on(rules.doc, 'afterTransaction', this.#afterTransaction);
		this.#ops.on(rules.doc, 'destroy', this.destroy);
		const open = openSteps.get(rules.doc) ?? new Set();
		openSteps.set(rules.doc, open.add(this.#open));
	}

	/** What the step still capturing inserted (`null`: none is open): a text delete there removes. */
	#open = (): IdSetOf | null => {
		const top = this.undoStack.at(-1);
		const open =
			top !== undefined &&
			!this.undoing &&
			!this.redoing &&
			this.lastChange > 0 &&
			getUnixTime() - this.lastChange < this.captureTimeout;
		return open ? top.inserts : null;
	};

	/** Be told of every step taken into a stack (added, or the open one updated). Returns the unsubscribe. */
	observe(f: (event: StepEvent, added: boolean) => void): () => void {
		this.#observers.add(f);
		return () => this.#observers.delete(f);
	}

	/** The next transaction starts a step of its own. */
	stopCapturing(): void {
		this.lastChange = 0;
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	/** Replay the top undo step; the step, or `null` when nothing changed. */
	undo(): StackItem | null {
		this.undoing = true;
		try {
			return this.#pop(this.undoStack);
		} finally {
			this.undoing = false;
		}
	}

	/** Replay the top redo step; the step, or `null` when nothing changed. */
	redo(): StackItem | null {
		this.redoing = true;
		try {
			return this.#pop(this.redoStack);
		} finally {
			this.redoing = false;
		}
	}

	/** Drop every step (undo and redo) and release what they kept for their replay. */
	clear(): void {
		this.#release([...this.undoStack.splice(0), ...this.redoStack.splice(0)]);
	}

	/**
	 * The session ends: its page left for good (`hist.release.end`). Every
	 * step is dropped and released as a dropped step is (`#release`: what
	 * they kept is collected, the text this writer's records hold is
	 * deleted for good), in one transaction that, when a step marked a block
	 * deleted or withdrawn, also appends one release record (the
	 * {@link RELEASE_ROOT} list): its id names this writer and the clock the
	 * history ended at, so the room's purge removes what those marks hide at
	 * its next tick, past the horizon or not. Then the manager stops
	 * capturing (it is destroyed; the document attaches a fresh one if asked).
	 * A history that captured nothing writes nothing. Only for a page that
	 * cannot come back: a page the back/forward cache keeps, or one that
	 * only lost its connection, keeps its history.
	 */
	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		const dropped = [...this.undoStack.splice(0), ...this.redoStack.splice(0)];
		const marked = this.#marked;
		if (dropped.length > 0 || marked)
			this.doc.transact(() => {
				this.#release(dropped);
				if (marked) {
					const records = this.doc.get(RELEASE_ROOT);
					records.insert(records.length, [true]);
				}
			}, HISTORY_TRIM);
		this.destroy();
	}

	destroy = (): void => {
		this.trackedOrigins.delete(this);
		openSteps.get(this.doc)?.delete(this.#open);
		this.#ops.off(this.doc, 'afterTransaction', this.#afterTransaction);
		this.#ops.off(this.doc, 'destroy', this.destroy);
		this.#observers.clear();
	};

	#inScope(item: StoreStruct): boolean {
		return this.#rules.scope.some((node) => this.#ops.inside(node, item));
	}

	#afterTransaction = (transaction: unknown): void => {
		const tr = transaction as Tr;
		this.#capture(tr);
		// The purge horizon arrived: the steps below it go (`hist.purge.horizon`).
		if (tr.changed.has(this.#horizon)) this.#prune();
	};

	#capture(tr: Tr): void {
		const ops = this.#ops;
		const origin = tr.origin as { constructor?: unknown } | null;
		if (
			!this.captureTransaction(tr) ||
			!changedUnder(tr, this.#rules.scope) ||
			(!this.trackedOrigins.has(origin) &&
				(!origin || !this.trackedOrigins.has(origin.constructor)))
		)
			return;
		const { undoing, redoing } = this;
		const stack = undoing ? this.redoStack : this.undoStack;
		// A replay's step is its own; a new edit ends what could be redone.
		if (undoing) this.lastChange = 0;
		else if (!redoing) this.#release(this.redoStack.splice(0));
		const now = getUnixTime();
		const open = stack.at(-1);
		const merge =
			open !== undefined &&
			!undoing &&
			!redoing &&
			this.lastChange > 0 &&
			now - this.lastChange < this.captureTimeout;
		if (merge) {
			open.deletes = ops.merge([open.deletes, tr.deleteSet]);
			open.inserts = ops.merge([open.inserts, tr.insertSet]);
		} else stack.push(new StackItem(tr.insertSet, tr.deleteSet));
		if (!undoing && !redoing) this.lastChange = now;
		// A block's delete or withdraw mark: what it hides waits for this
		// history (its end releases it to the purge, `end()`).
		if (!this.#marked)
			for (const keys of tr.changed.values())
				for (const key of keys)
					if (
						typeof key === 'string' &&
						(key.startsWith(DEL_PREFIX) || key.startsWith(WITHDRAW_PREFIX))
					)
						this.#marked = true;
		// What the step deleted is kept from collection while a step may bring it back.
		ops.iterate(tr, tr.deleteSet, (item) => {
			if (ops.isItem(item) && this.#inScope(item)) ops.keep(item);
		});
		const step = stack.at(-1)!;
		if (tr.writer) step.writer = tr.writer;
		// A streamless block's own text is shared by every replica that
		// typed into it first: no step captures it, so undoing the first
		// typing removes the typing and keeps the text (and nonce).
		const own = ownTextIds.get(this.doc);
		if (own !== undefined) step.inserts = ops.diff(step.inserts, own);
		// The undo stack keeps its newest `limit` steps.
		const over = this.undoStack.length - this.limit;
		if (!merge && !undoing && over > 0) this.#release(this.undoStack.splice(0, over));
		const event: StepEvent = {
			stackItem: step,
			origin: tr.origin,
			type: undoing ? 'redo' : 'undo'
		};
		for (const f of this.#observers) f(event, !merge);
	}

	/**
	 * Replay the top step of `stack` in one transaction (origin: this
	 * manager): what it inserted is deleted (text: held by a record of this
	 * writer; a block: withdrawn), what it deleted comes back (a text delete
	 * was a record: deleting it shows the text), the overwritten attrs are
	 * repaired. A step that changes nothing is skipped for the one below.
	 */
	#pop(stack: StackItem[]): StackItem | null {
		const ops = this.#ops;
		const { records, withdraw, repair } = this.#rules;
		const deletedByHistory = (id: { client: number; clock: number }) =>
			[this.undoStack, this.redoStack].some((s) =>
				s.some((step) => step.deletes.has(id.client, id.clock))
			);
		// A step written under another client replays under it, and so does its replay's step.
		const local = this.doc.clientID;
		const writer = stack.at(-1)?.writer;
		this.doc.clientID = writer ?? local;
		try {
			this.doc.transact((transaction: unknown) => {
				const tr = transaction as Tr;
				tr.writer = writer;
				while (stack.length > 0 && this.currStackItem === null) {
					const step = stack.pop()!;
					const restore = new Set<StoreStruct>();
					const remove: StoreStruct[] = [];
					const held: number[] = [];
					let changed = false;
					ops.iterate(tr, step.inserts, (struct) => {
						if (!ops.isItem(struct)) return;
						const item = ops.latest(tr, struct);
						// An atom the step inserted is held whole: its attrs stay with it.
						const atom = (item.parent as EngineNode | undefined)?._item;
						if (
							atom?.id &&
							isUnit(atom as StoreStruct) &&
							step.inserts.has(atom.id.client, atom.id.clock)
						)
							return;
						if (!item.deleted && this.#inScope(item)) remove.push(item);
					});
					ops.iterate(tr, step.deletes, (struct) => {
						if (!ops.isItem(struct) || !this.#inScope(struct)) return;
						// Created and deleted within the step: nothing to bring back.
						if (step.inserts.has(struct.id.client, struct.id.clock)) return;
						// Text a record holds stays hidden: the record decides (removed with its node).
						if ((struct.holds ?? 0) > 0) return;
						restore.add(struct);
					});
					for (const item of restore)
						changed =
							ops.redo(tr, item, restore, step.inserts, deletedByHistory) !== null || changed;
					// Children before parents: more is known when an item is judged.
					for (let i = remove.length - 1; i >= 0; i--) {
						const item = remove[i]!;
						// Text the step wrote is held, never removed: a redo shows it again where it was.
						if (isUnit(item)) held.push(item.id.client, item.id.clock, item.length);
						else if (!withdraw(item, step)) ops.remove(tr, item);
						changed = true;
					}
					records.hold(held);
					this.currStackItem = changed ? step : null;
					if (changed) repair(step);
				}
				tr.changed.forEach((keys, node) => {
					if (keys.has(null)) dropSearchMarkers(node);
				});
			}, this);
		} finally {
			this.doc.clientID = local;
		}
		const step = this.currStackItem;
		this.currStackItem = null;
		return step;
	}

	/**
	 * Release what dropped steps kept for their replay: the engine collects
	 * that content now, as it would have at the delete without a history
	 * (the doc's `gcFilter` still decides), and the text their hold records
	 * hold is deleted for good. An item is released only
	 * once every step that deleted part of it was dropped (the engine merges
	 * deleted items across steps): never split, so the store keeps its
	 * merged items. Only the items themselves are released: a kept
	 * container's flag may guard a newer step's items inside it.
	 */
	#release(dropped: StackItem[]): void {
		if (dropped.length === 0) return;
		const { Y, doc } = this.#rules;
		const released = this.#released;
		for (const step of dropped) this.#ops.insertInto(released, step.deletes);
		const covered = (st: StoreStruct) => {
			const end = st.id.clock + st.length;
			return (released.clients.get(st.id.client)?.getIds() ?? []).some(
				(r) => r.clock <= st.id.clock && end <= r.clock + r.len
			);
		};
		const gc = collects(doc);
		const ops = this.#ops;
		const { records } = this.#rules;
		doc.transact((tr: unknown) => {
			for (const step of dropped)
				walkIdSet(Y, doc, step.deletes, (st) => {
					const it = st as StoreStruct & { content?: unknown };
					if (it.content === undefined || it.keep !== true || !covered(it)) return;
					it.keep = false;
					if (gc && it.deleted && collectable(doc, it)) collectNow(it, tr);
				});
			// A dropped step's text deletes can never be undone here: what this
			// writer's live records hold is deleted for good, as the purge does,
			// and the engine collects it (`hist.delete-marks.release`). A record
			// a captured remote frame wrote (the room's validation) is its
			// writer's to take back.
			const own = ops.idSet();
			for (const step of dropped)
				walkIdSet(Y, doc, step.inserts, (st, from, to) => {
					if (
						st.parent === records &&
						!st.deleted &&
						(st.id.client === doc.clientID || st.id.client === step.writer)
					)
						own.add(st.id.client, from, to - from);
				});
			const held = ops.idSet();
			ops.iterate(tr, own, (st) => {
				const ids = (st as { content?: { ids?: number[] } }).content?.ids;
				if (st.deleted || ids === undefined) return;
				for (let i = 0; i < ids.length; i += 3) held.add(ids[i], ids[i + 1], ids[i + 2]);
				ops.remove(tr, st);
			});
			ops.iterate(tr, held, (it) => {
				if (it.removed !== false) return;
				ops.remove(tr, it);
				dropSearchMarkers(it.parent);
			});
		}, HISTORY_TRIM);
	}

	/**
	 * The purge horizon (`hist.purge.horizon`): every step all of whose
	 * inserts the room stored before it is dropped and released — a replay
	 * of it would bring back content the purge removed. A step that inserted
	 * nothing is kept.
	 */
	#prune(): void {
		const horizon = readHorizon(this.doc);
		if (horizon === null) return;
		const sv = this.#rules.Y.decodeStateVector(horizon.sv) as Map<number, number>;
		const past = (step: StackItem): boolean => {
			let any = false;
			for (const [client, ranges] of step.inserts.clients)
				for (const r of ranges.getIds()) {
					any = true;
					if (r.clock + r.len > (sv.get(client) ?? 0)) return false;
				}
			return any;
		};
		const dropped: StackItem[] = [];
		for (const stack of [this.undoStack, this.redoStack]) {
			const kept = stack.filter((step) => !past(step) || !dropped.push(step));
			stack.splice(0, stack.length, ...kept);
		}
		this.#release(dropped);
	}
}

/** What a facade's history is made over: its doc, the write funnel and the bound engine layers. */
export type HistoryContext = DocBase &
	Pick<WriteFunnel, 'write' | 'disposed'> & {
		/** Stamp the version record before the history attaches. */
		init: (doc: EngineDoc) => void;
	};

/**
 * The document's history rules over `doc` (the one set every history of an
 * edytor document runs): its scope (the block registry, the text hold
 * records, the document's data), the records a replay's text holds go to,
 * the withdraw rule (`hist.undo.withdraw`) and the attr repair below.
 */
export const historyRules = (Y: EngineApi, doc: EngineDoc): Rules => {
	/**
	 * Undo repair, inside the replay's transaction. A replayed step
	 * deletes its own attr write and re-creates the value that write
	 * overwrote — unless a concurrent write sits between them, where the
	 * engine refuses the restore (the peer's value was deleted at
	 * integration). The attr is then undefined on every replica. For each
	 * block/atom attr the step overwrote whose tip is now deleted, write
	 * back the overwritten value from the step's own `deletes`: undo
	 * reverts to what this writer overwrote (`lastChangedBy` to the
	 * previous author), and the repair syncs like any write.
	 */
	const repairAttrs = (step: StackItem): void => {
		const lost = new Map<EngineNode, Map<string, unknown>>();
		walkIdSet(Y, doc, step.deletes, (s) => {
			const node = s.parent as EngineNode;
			const key = s.parentSub;
			// A collected struct (a node the room's purge removed) has no key.
			if (typeof key !== 'string') return;
			if (!key.startsWith(DATA_LEAF_PREFIX) && !REPAIRED[node?.name]?.includes(key)) return;
			if (step.inserts.has(s.id.client, s.id.clock)) return;
			const values = (s as StoreStruct & { content: { getContent(): unknown[] } }).content;
			let attrs = lost.get(node);
			if (attrs === undefined) lost.set(node, (attrs = new Map()));
			attrs.set(key, values.getContent().at(-1));
		});
		for (const [node, attrs] of lost) {
			if (node._item?.deleted) continue;
			for (const [key, value] of attrs)
				if (node.getAttr(key) === undefined) node.setAttr(key, value);
		}
	};

	// The text hold records are in scope (an undo deletes the undoer's
	// own, fork patch YP20). An undone creation withdraws the block instead
	// of deleting it (`hist.undo.withdraw`).
	const records = doc.get(TEXT_DELETES_ROOT);
	return {
		Y,
		doc,
		scope: [registryOf(doc), records, doc.get(DOC_DATA_ROOT), doc.get(SUGGEST_ROOT)],
		records,
		withdraw: withdrawOnUndo(doc),
		repair: repairAttrs
	};
};

/** The history factory of one facade. */
export const docHistory = (c: HistoryContext) => {
	const { Y, doc, init, write, disposed } = c;

	/**
	 * The document's undo manager, SCOPED TO THE BLOCK REGISTRY (with the
	 * text hold records and the document's data), attached only after the
	 * doc carries the schema version record:
	 *
	 * - the `meta` root (version stamp, schema name) is outside the scope,
	 *   so `init`'s version write is undo-inert: undo can never strip
	 *   `meta.v` or resurrect a stale schema version;
	 * - attach-after-init: the deterministic bootstrap insert IS inside the
	 *   registry; this factory runs `init` first (a no-op on initialized
	 *   docs), so the bootstrap always predates capture;
	 * - remote/provider writes never enter the stack: applied updates carry
	 *   a foreign origin (and are non-local), which the tracked origins
	 *   (and the document's `captureTransaction`) leave out.
	 */
	const createUndoManager = (options: HistoryOptions = {}): UndoManager => {
		if (disposed()) {
			throw new DocumentDestroyedError('createUndoManager');
		}
		write(() => {
			if (!isInitialized(doc)) init(doc);
		});
		return new UndoManager(historyRules(Y, doc), options);
	};

	return { createUndoManager };
};
