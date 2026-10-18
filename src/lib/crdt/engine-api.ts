/**
 * Engine-facing types for the placement model.
 *
 * The vendored v14 engine is plain JSDoc-typed JS that is deliberately
 * excluded from `tsconfig.json` type-checking. The model works against the
 * STRUCTURAL interfaces below — the exact
 * subset of the v14 Node/Doc surface it uses — and reads the engine
 * through `engine.js` (its `Y`, declared by `engine.d.ts`), the only
 * module that imports vendor `.js`, so `pnpm check` never traverses
 * vendored sources.
 */
import type * as Y from './vendor/yjs/dts/index.js';
import type { Y as Engine } from './engine.js';

/**
 * The engine surface every `bind*` receives: the object in `engine.js`
 * (exactly the symbols edytor calls, so consumer bundles tree-shake the
 * rest). The full namespace `import * as Y from 'edytor/crdt'` is a
 * superset and satisfies it.
 */
export type EngineApi = typeof Engine;

export type YDoc = InstanceType<typeof Y.Doc>;
export type YNode = InstanceType<typeof Y.Node>;
/** The document's undo manager (`doc/history.ts`). */
export type YUndoManager = import('./doc/history.js').UndoManager;
export type YTransaction = Y.Transaction;
export type YItem = Y.Item;

/** Engine item identity — used by `crdtId` (`client:clock`). */
export type EngineItemRef = {
	id?: { client: number; clock: number };
	deleted?: boolean;
	/**
	 * Parentage of the item — the containing shared type and the attr key it
	 * sits under (`null` for sequence children). Read by the shared model
	 * state to map `Transaction.changed` entries back to
	 * block/facet coordinates mid-transaction.
	 */
	parent?: unknown;
	parentSub?: string | null;
} | null;

/**
 * Structural minimum of the in-flight engine `Transaction` — exposed on the
 * doc as `doc._transaction` while a transaction is open. `changed` maps each
 * touched shared type to the set of `parentSub` keys whose items changed
 * (attr names for map-like children, `null` for sequence edits); the
 * document index folds it once at commit.
 */
export interface EngineTransaction {
	changed?: Map<unknown, Set<string | null>>;
	/** The visibility changes hold records made, in order: `client, clock, ±len` per item (`> 0` shown). */
	holds?: number[];
	/** The units whose mover changed (the fork's move records), in order: `client, clock, len` per item. */
	moves?: number[];
}

/**
 * Structural minimum of the vendored `Y.Node` (v14) used by the placement
 * model. A real `YNode` satisfies this at runtime; typed consumers cast once
 * at the boundary (`doc as unknown as EngineDoc`).
 */
export interface EngineNode {
	/** Node name ('block' | 'content' | 'at' | 'inline' in our schema). */
	readonly name: string;
	/** The doc this node is integrated into; `null` while detached. */
	readonly doc: unknown | null;
	/** Sequence length (invalid read on detached nodes — track offsets instead). */
	readonly length: number;
	/** The item this node is attached to (identity anchor for `crdtId`). */
	readonly _item: EngineItemRef;

	getAttr(key: string): unknown;
	setAttr(key: string, value: unknown): unknown;
	deleteAttr(key: string): void;
	forEachAttr(f: (value: unknown, key: string, node: EngineNode) => void): void;
	attrKeys(): IterableIterator<string>;

	insert(index: number, content: unknown): void;
	/**
	 * Delete `length` live units at `index`. With `into` (the document's
	 * records list), they are held by one record appended there instead (a
	 * delete its writer can take back), except those `fresh` names, which are
	 * removed.
	 */
	delete(index: number, length?: number, into?: EngineNode | null, fresh?: unknown): void;
	/** Append one hold record of `ids` (`client, clock, len` triples) to this records list: they read as deleted while it lives. */
	hold(ids: number[]): void;
	/**
	 * Move the units `ids` names (`client, clock, len` triples, in order) to
	 * live index `index` of this sequence: one move record there (the fork's
	 * `ContentMove`); `side` is its class among the items of its origin (`0`
	 * after, `1` before), `at` the chain it stands at for the sort of two
	 * records at one origin — the units from the root sequence down to the
	 * unit it stands at, outermost first (`null`: the first unit it names) —
	 * and `part` its order among the records standing there.
	 */
	move(
		index: number,
		ids: number[],
		side?: number,
		part?: number,
		at?: ReadonlyArray<{ client: number; clock: number }> | null
	): void;
}

/** Structural minimum of the vendored `Y.Doc`. */
export interface EngineDoc {
	clientID: number;
	/**
	 * Which node values a concurrent write of the same key replaced keep
	 * their subtree (`null`: none, upstream's semantics). Every edytor
	 * document carries the block registry's rule.
	 */
	keepReplaced?: ((item: never) => boolean) | null;
	get(key?: string): EngineNode;
	transact<T>(f: (transaction: unknown) => T, origin?: unknown): T;
	/**
	 * Doc-level `update` channel — fires once per transaction that produced
	 * replicated state (local commits AND remote `applyUpdate`s), carrying
	 * the transaction's origin and the transaction itself (`transaction.local`
	 * distinguishes local commits from remote applies). The assembled model uses this single channel to derive semantic change events.
	 */
	on(
		name: 'update',
		f: (update: Uint8Array, origin: unknown, doc: EngineDoc, transaction: unknown) => void
	): void;
	off(
		name: 'update',
		f: (update: Uint8Array, origin: unknown, doc: EngineDoc, transaction: unknown) => void
	): void;
	/**
	 * Doc-level `commit` channel — fires once per
	 * transaction, before `afterTransaction`, with the transaction: the
	 * index folds it there.
	 */
	on(name: 'commit', f: (transaction: never) => void): void;
	off(name: 'commit', f: (transaction: never) => void): void;
	/**
	 * Doc-level `beforeCommit` channel (the fork's) — fires once per
	 * outermost transaction, after its function returned and while the
	 * transaction is still open: a listener's writes join it.
	 */
	on(name: 'beforeCommit', f: (transaction: never) => void): void;
	off(name: 'beforeCommit', f: (transaction: never) => void): void;
	/** Doc destruction event — doc-scoped state must release on destroy. */
	on(name: 'destroy', f: () => void): void;
	off(name: 'destroy', f: () => void): void;
	/**
	 * The doc's struct store — present on a real engine doc. Migration reads
	 * it to detect PENDING state (update rows whose CRDT dependencies never
	 * landed — `pendingStructs`/`pendingDs` are non-null while deps are
	 * missing); the inbound refusal (`protocols/sync.ts` `applyRemote`)
	 * judges the pending store and discards it when it holds a forged stamp.
	 */
	readonly store?: {
		pendingStructs: null | { missing: Map<number, number>; update: Uint8Array };
		pendingDs: null | Uint8Array;
		/** The next clock `client` writes at (a source rank's tie). */
		getClock(client: number): number;
	};
	/**
	 * The engine's CURRENT transaction (`null` outside one) — vendored
	 * `Doc._transaction`. Used by the shared model state to discover
	 * uncommitted changes for read-your-writes invalidation.
	 */
	readonly _transaction?: EngineTransaction | null;
}
