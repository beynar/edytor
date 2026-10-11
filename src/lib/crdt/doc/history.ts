/**
 * The document's history: the one undo manager (fork patch YP18 removed the
 * engine's). It captures the tracked local transactions that write in its
 * scope (the block registry, the text delete marks, the document's data)
 * into steps, and an undo or a redo replays a step in one transaction over
 * the engine's struct primitives (`redoItem`, `keepItem`). Its rules: text
 * comes back as the delete marks allow (`hist.undo.restore`), an undone
 * creation is withdrawn (`hist.undo.withdraw`), an overwritten attr is
 * repaired, the stack keeps `limit` steps, and the purge horizon drops the
 * steps below it (`hist.purge.horizon`).
 */
import { getUnixTime } from 'lib0-v14/time';
import type { EngineApi, EngineDoc, EngineNode } from '../engine-api.js';
import type { TextDeletes } from '../text/deletes.js';
import { ownTextIds } from '../text/model.js';
import { readHorizon } from '../purge.js';
import {
	BLOCK_NODE,
	DATA_LEAF_PREFIX,
	DOC_DATA_ROOT,
	HORIZON_ROOT,
	INLINE_NODE,
	LAST_CHANGED_ATTR,
	TYPE
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
import { EdytorDocDisposedError, type WriteFunnel } from './funnel.js';
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
type Rules = {
	Y: EngineApi;
	doc: EngineDoc;
	scope: EngineNode[];
	/** The text delete marks' restore and apply rules (`text/deletes.ts`). */
	marks: { restoreFilter(item: unknown): boolean; onApply(tr: unknown, step: StackItem): void };
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
	}

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

	destroy = (): void => {
		this.trackedOrigins.delete(this);
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
		// What the step deleted is kept from collection while a step may bring it back.
		ops.iterate(tr, tr.deleteSet, (item) => {
			if (ops.isItem(item) && this.#inScope(item)) ops.keep(item);
		});
		const step = stack.at(-1)!;
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
	 * manager): what it inserted is deleted (or withdrawn), what it deleted
	 * comes back (text as its delete marks allow), the overwritten attrs are
	 * repaired. A step that changes nothing is skipped for the one below.
	 */
	#pop(stack: StackItem[]): StackItem | null {
		const ops = this.#ops;
		const { marks, withdraw, repair } = this.#rules;
		const deletedByHistory = (id: { client: number; clock: number }) =>
			[this.undoStack, this.redoStack].some((s) =>
				s.some((step) => step.deletes.has(id.client, id.clock))
			);
		this.doc.transact((transaction: unknown) => {
			const tr = transaction as Tr;
			while (stack.length > 0 && this.currStackItem === null) {
				const step = stack.pop()!;
				const restore = new Set<StoreStruct>();
				const remove: StoreStruct[] = [];
				let changed = false;
				ops.iterate(tr, step.inserts, (struct) => {
					if (!ops.isItem(struct)) return;
					const item = ops.latest(tr, struct);
					if (!item.deleted && this.#inScope(item)) remove.push(item);
				});
				ops.iterate(tr, step.deletes, (struct) => {
					if (!ops.isItem(struct) || !this.#inScope(struct)) return;
					// Created and deleted within the step: nothing to bring back.
					if (step.inserts.has(struct.id.client, struct.id.clock)) return;
					// Text comes back through the delete marks (`onApply`): withheld here.
					if (!marks.restoreFilter(struct)) changed = true;
					else restore.add(struct);
				});
				for (const item of restore)
					changed = ops.redo(tr, item, restore, step.inserts, deletedByHistory) !== null || changed;
				// Children before parents: more is known when an item is judged.
				for (let i = remove.length - 1; i >= 0; i--) {
					if (!withdraw(remove[i]!, step)) ops.remove(tr, remove[i]!);
					changed = true;
				}
				this.currStackItem = changed ? step : null;
				if (changed) {
					marks.onApply(tr, step);
					repair(step);
				}
			}
			tr.changed.forEach((keys, node) => {
				if (keys.has(null)) dropSearchMarkers(node);
			});
		}, this);
		const step = this.currStackItem;
		this.currStackItem = null;
		return step;
	}

	/**
	 * Release what dropped steps kept for their replay: the engine collects
	 * that content now, as it would have at the delete without a history
	 * (the doc's `gcFilter` still decides: a text copy another replica may
	 * have to copy again stays, `text/deletes.ts`). An item is released only
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
		doc.transact((tr: unknown) => {
			for (const step of dropped)
				walkIdSet(Y, doc, step.deletes, (st) => {
					const it = st as StoreStruct & { content?: unknown };
					if (it.content === undefined || it.keep !== true || !covered(it)) return;
					it.keep = false;
					if (gc && it.deleted && collectable(doc, it)) collectNow(it, tr);
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
		D: TextDeletes;
		/** Stamp the version record before the history attaches. */
		init: (doc: EngineDoc) => void;
	};

/** The history factory of one facade. */
export const docHistory = (c: HistoryContext) => {
	const { Y, doc, D, init, write, disposed } = c;

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

	/**
	 * The document's undo manager, SCOPED TO THE BLOCK REGISTRY (with the
	 * text delete marks and the document's data), attached only after the
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
			throw new EdytorDocDisposedError('createUndoManager');
		}
		write(() => {
			if (!isInitialized(doc)) init(doc);
		});
		// Text delete marks (`text/deletes.ts`): the marks are in scope (an undo
		// removes the undoer's own), and the history restores text only as the
		// marks allow. An undone creation withdraws the block instead of
		// deleting it (`hist.undo.withdraw`).
		const marks = D.history(doc, () => um);
		const um: UndoManager = new UndoManager(
			{
				Y,
				doc,
				scope: [registryOf(doc), D.scope(doc), doc.get(DOC_DATA_ROOT)],
				marks,
				withdraw: withdrawOnUndo(doc),
				repair: repairAttrs
			},
			options
		);
		return um;
	};

	return { createUndoManager };
};
