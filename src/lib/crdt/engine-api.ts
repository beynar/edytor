/**
 * Engine-facing types for the placement model.
 *
 * The vendored v14 engine is plain JSDoc-typed JS that is deliberately
 * excluded from `tsconfig.json` type-checking. Its emitted declarations
 * (`vendor/yjs/dts`) parameterize `YNode` on a delta-config generic that
 * collapses to `never` when instantiated with `any` — unusable as an
 * ergonomic call surface.
 *
 * So the model works against the STRUCTURAL interfaces below — the exact
 * subset of the v14 Node/Doc surface it uses — and receives the engine
 * module by injection (`bindModel(Y)`). Only `engine.js` (declared by
 * `engine.d.ts`) imports vendor `.js`, so `pnpm check` never traverses
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
export type YUndoManager = InstanceType<typeof Y.UndoManager>;
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
}

/**
 * The deep-observer event surface (v14 `YEvent`, observed through
 * `observeDeep` on an ancestor — in our schema, the registry root). The
 * document index folds the event's `transaction.changed` at commit.
 */
export interface EngineDeepEvent {
	readonly target: unknown;
	readonly currentTarget: unknown;
	readonly keysChanged?: ReadonlySet<string>;
	readonly delta?: { toJSON(): unknown };
	readonly deltaDeep?: { toJSON(): unknown };
	readonly transaction?: unknown;
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

	insert(index: number, content: unknown, format?: Record<string, unknown>): void;
	delete(index: number, length?: number): void;
	format(index: number, length: number, formats: Record<string, unknown>): void;
	get(index: number): unknown;
	slice(start?: number, end?: number): unknown[];
	toArray(): unknown[];

	/** Maintained delta cache — `toJSON()` yields the serialized op list. */
	readonly delta: { toJSON(): { children?: unknown[] } };
	toDelta(opts?: { deep?: boolean }): { toJSON(): unknown };

	/** Deep event channel — anchors/observers follow the node across moves. */
	observeDeep(f: (event: EngineDeepEvent, transaction: unknown) => void): unknown;
	unobserveDeep(f: (event: EngineDeepEvent, transaction: unknown) => void): void;
	on(name: 'delta', f: (delta: unknown, origin: unknown) => void): void;
}

/** Structural minimum of the vendored `Y.Doc`. */
export interface EngineDoc {
	clientID: number;
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
