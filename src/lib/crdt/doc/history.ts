/**
 * The document's history: the undo manager every view's history is (scope,
 * text delete marks, withdrawn creations, the attr repair, the step limit and
 * the purge horizon, lineage for undo and redo).
 */
import type { EngineApi, EngineDoc, EngineNode, YUndoManager } from '../engine-api.js';
import type { BlockId } from '../placement/model.js';
import type { TextDeletes } from '../text/deletes.js';
import type { BlockAttributionApi } from '../attribution/block.js';
import { ownTextIds } from '../text/model.js';
import { readHorizon } from '../purge.js';
import {
	BLOCK_NODE,
	DATA,
	DATA_LEAF_PREFIX,
	DOC_DATA_ROOT,
	HORIZON_ROOT,
	ID,
	INLINE_NODE,
	isNodeLike,
	LAST_CHANGED_ATTR,
	TYPE
} from '../schema.js';
import {
	asYNode,
	collectable,
	collectNow,
	collects,
	engineOps,
	onTransaction,
	stepsOf,
	walkIdSetStructs,
	type IdSetLike,
	type StoreStruct
} from '../structs.js';
import { isInitialized } from './gate.js';
import { EdytorDocDisposedError, type WriteFunnel } from './funnel.js';
import type { DocBase } from './reads.js';

/** The undo steps a document's history keeps by default: older ones are released. */
export const DEFAULT_HISTORY_LIMIT = 200;
/** The origin of the transaction that releases a dropped history step's content. */
const HISTORY_TRIM = Symbol('edytor.history.trim');

/** What a facade's history is made over: its doc, the write funnel and the bound engine layers. */
export type HistoryContext = DocBase &
	Pick<WriteFunnel, 'write' | 'disposed' | 'actorOf' | 'lineageDepth' | 'lineagePending'> & {
		D: TextDeletes;
		BA: BlockAttributionApi;
		/** Each history's release of all its steps (`releaseHistory`). */
		releasers: WeakMap<YUndoManager, () => void>;
		/** Stamp the version record before the history attaches. */
		init: (doc: EngineDoc) => void;
	};

/** The history factory of one facade. */
export const docHistory = (c: HistoryContext) => {
	const {
		Y,
		doc,
		M,
		D,
		BA,
		releasers,
		init,
		write,
		disposed,
		actorOf,
		lineageDepth,
		lineagePending
	} = c;
	const ops = engineOps(Y);

	/**
	 * The supported undo seam:
	 * a UndoManager SCOPED TO THE BLOCK REGISTRY, attached only after the
	 * doc carries the schema version record.
	 *
	 * Why this shape:
	 *
	 * - Scope `blocks` — the `meta` root (version stamp, schema name) is
	 *   outside it, so `init`'s version write and any schema-version
	 *   transition are undo-inert: undo can never strip `meta.v` or
	 *   resurrect a stale schema version.
	 * - Attach-after-init — the deterministic bootstrap insert IS inside
	 *   the registry; if the manager attached before `init`, a user undo
	 *   could remove it and leave a "versioned but empty" doc that
	 *   nothing re-bootstraps. This factory runs `init` first (a no-op
	 *   on already-initialized docs), so the bootstrap always predates
	 *   capture.
	 * - Remote/provider writes never enter the stack: applied updates
	 *   carry a non-null foreign origin and non-local transactions, so
	 *   the default `trackedOrigins`/`transaction.local` filter drops
	 *   them.
	 *
	 * `opts` are the engine's UndoManager options (captureTimeout,
	 * trackedOrigins, …) passed through verbatim — callers can add
	 * origins but should not widen the scope beyond the registry.
	 */
	type UndoStep = { inserts: IdSetLike; deletes: IdSetLike };
	/** The single-value attrs a history step must never leave undefined. */
	const REPAIRED: Record<string, readonly string[]> = {
		[BLOCK_NODE]: [TYPE, DATA, LAST_CHANGED_ATTR],
		[INLINE_NODE]: [TYPE, DATA]
	};
	/**
	 * Undo repair, inside the history transaction. A popped step
	 * deletes its own attr write and re-creates the value that write
	 * overwrote — unless a concurrent write sits between them, where the
	 * engine refuses the restore (the peer's value was deleted at
	 * integration). The attr is then undefined on every replica. For each
	 * block/atom attr the step overwrote whose tip is now deleted, write
	 * back the overwritten value from the step's own `deletes`: undo
	 * reverts to what this writer overwrote (`lastChangedBy` to the
	 * previous author), and the repair syncs like any write.
	 */
	const repairAttrs = (step: UndoStep): void => {
		const lost = new Map<EngineNode, Map<string, unknown>>();
		walkIdSetStructs(Y, doc, step.deletes, (s) => {
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

	const createUndoManager = (
		options: ConstructorParameters<EngineApi['UndoManager']>[1] & { limit?: number } = {}
	): YUndoManager => {
		if (disposed()) {
			throw new EdytorDocDisposedError('createUndoManager');
		}
		const { limit = DEFAULT_HISTORY_LIMIT, ...opts } = options;
		write(() => {
			if (!isInitialized(doc)) init(doc);
		});
		// Text delete marks (fork patch YP11): the marks are in scope (an undo removes the
		// undoer's own), and the history restores text only as the marks allow.
		// An undone creation withdraws the block instead of deleting it (fork patch YP12, `hist.undo.withdraw`).
		const marks = D.history(doc, () => um);
		const um: YUndoManager = new Y.UndoManager(
			[M.registryOf(doc), D.scope(doc), doc.get(DOC_DATA_ROOT)].map(asYNode),
			{
				...opts,
				...marks,
				onApply: (tr: unknown, step: UndoStep) => {
					marks.onApply(tr, step);
					repairAttrs(step);
				},
				withdraw: M.withdrawOnUndo(doc)
			} as never
		) as YUndoManager;
		// A streamless block's own text is shared by every replica that
		// typed into it first: no history step captures it, so undoing the
		// first typing removes the typing and keeps the text (and nonce).
		const skipOwnText = ({ stackItem }: { stackItem: { inserts: IdSetLike } }): void => {
			const ids = ownTextIds.get(doc);
			if (ids !== undefined) stackItem.inserts = ops.diff(stackItem.inserts, ids);
		};
		um.on('stack-item-added', skipOwnText);
		um.on('stack-item-updated', skipOwnText);
		// The undo stack keeps its newest `limit` steps. A step that
		// falls off releases what it kept for its undo (its deleted items),
		// and the engine collects their content now, as it would have at
		// the delete without a history (the doc's `gcFilter` still decides:
		// a text copy another replica may have to copy again stays, fork patch YP11).
		// An item is released only once every step that deleted part of it
		// fell off (the engine merges deleted items across steps): never
		// split, so the store keeps its merged items. Only the items
		// themselves are released: a kept container's flag may guard a
		// newer step's items inside it.
		const released = ops.idSet();
		const covered = (st: { id: { client: number; clock: number }; length: number }) => {
			const end = st.id.clock + st.length;
			return (released.clients.get(st.id.client)?.getIds() ?? []).some(
				(r) => r.clock <= st.id.clock && end <= r.clock + r.len
			);
		};
		const release = (dropped: UndoStep[]): void => {
			if (dropped.length === 0) return;
			for (const step of dropped) ops.insertInto(released, step.deletes);
			const gc = collects(doc);
			doc.transact((tr) => {
				for (const step of dropped)
					walkIdSetStructs(Y, doc, step.deletes, (st) => {
						const it = st as StoreStruct & { content?: unknown };
						if (it.content === undefined || it.keep !== true || !covered(it)) return;
						it.keep = false;
						if (gc && it.deleted && collectable(doc, it)) collectNow(it, tr);
					});
			}, HISTORY_TRIM);
		};
		const trim = ({ type }: { type: string }): void => {
			const over = um.undoStack.length - limit;
			if (type !== 'undo' || !(over > 0)) return;
			release(stepsOf<UndoStep>(um.undoStack.splice(0, over)));
		};
		um.on('stack-item-added', trim);
		// `releaseHistory(um)`: every step dropped and released by the same rule.
		releasers.set(um, () =>
			release(stepsOf<UndoStep>([...um.undoStack.splice(0), ...um.redoStack.splice(0)]))
		);
		// The purge horizon (`hist.purge.horizon`): when the room's purge horizon arrives,
		// every step all of whose inserts the room stored before it is
		// dropped and released — an undo of it would bring back content
		// the purge removed. A step that inserted nothing is kept.
		const horizonRoot = doc.get(HORIZON_ROOT);
		const pastHorizon = (step: UndoStep, sv: Map<number, number>): boolean => {
			let any = false;
			for (const [client, ranges] of step.inserts.clients)
				for (const r of ranges.getIds()) {
					any = true;
					if (r.clock + r.len > (sv.get(client) ?? 0)) return false;
				}
			return any;
		};
		const prune = (): void => {
			const horizon = readHorizon(doc);
			if (horizon === null) return;
			const sv = Y.decodeStateVector(horizon.sv) as Map<number, number>;
			const dropped: UndoStep[] = [];
			for (const stack of [um.undoStack, um.redoStack].map(stepsOf<UndoStep>)) {
				const kept = stack.filter((step) => !pastHorizon(step, sv) || !dropped.push(step));
				stack.splice(0, stack.length, ...kept);
			}
			release(dropped);
		};
		onTransaction<{ changed: Map<unknown, unknown> }>(doc, 'afterTransaction', (tr) => {
			if (tr.changed.has(horizonRoot)) prune();
		});
		// Lineage for undo/redo: the replay displaces the state
		// every block the popped stack item touches, so each one's subtree
		// is captured (`force`: lost whoever owns `l`) from the history
		// transaction's own `beforeTransaction`, before the replay writes.
		// The ring writes join that transaction — one update per undo —
		// and sit outside the manager's scope, so the replay never undoes
		// or re-captures them. Nothing else is stamped for undo/redo: the
		// engine's replay restores `l`, and `contributors` are add-only.
		// An undo run inside an enclosing transaction gets no lineage (it
		// is a defect of its own: it empties the redo stack).
		if (lineageDepth > 0) {
			const onBefore = (tr: { origin: unknown }): void => {
				const stack = um.undoing ? um.undoStack : um.redoing ? um.redoStack : [];
				const item = stack[stack.length - 1] as { inserts?: unknown; deletes?: unknown };
				if (tr.origin !== um || item === undefined || actorOf() === undefined) return;
				try {
					const touched = new Set<BlockId>();
					for (const idSet of [item.inserts, item.deletes]) {
						walkIdSetStructs(Y, doc, idSet as IdSetLike, (s) => {
							let n: unknown = s.parent;
							while (isNodeLike(n)) {
								const bid = n.name === BLOCK_NODE ? n.getAttr(ID) : undefined;
								if (typeof bid === 'string') return void touched.add(bid);
								n = n._item?.parent;
							}
						});
					}
					for (const bid of touched) {
						const pending = lineagePending(bid, true);
						if (pending !== undefined) BA.appendLineage(doc, bid, pending, lineageDepth);
					}
				} catch (err) {
					// Throwing here would leave the engine's transaction open.
					console.error('[edytor-doc] undo lineage capture failed', err);
				}
			};
			onTransaction(doc, 'beforeTransaction', onBefore);
		}
		return um;
	};

	return { createUndoManager };
};
