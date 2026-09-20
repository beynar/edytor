/**
 * Engine-facing types for the placement model.
 *
 * The vendored v14 engine is plain JS that is deliberately excluded from
 * `tsconfig.json` type-checking (pulling it into the program surfaces an
 * upstream TS2589 in `utils/delta-helpers.js`). Its emitted declarations
 * (`vendor/yjs/dts`) parameterize `YNode` on a delta-config generic that
 * collapses to `never` when instantiated with `any` — unusable as an
 * ergonomic call surface.
 *
 * So the model works against the STRUCTURAL interfaces below — the exact
 * subset of the v14 Node/Doc surface it uses — and receives the engine
 * module by injection (`bindModel(Y)`). Nothing in `src/lib` imports vendor
 * `.js`, so `pnpm check` never traverses vendored sources.
 */
import type * as Y from './vendor/yjs/dts/index.js';

/** The vendored v14 module surface (`import * as Y`). */
export type EngineApi = typeof Y;

export type YDoc = InstanceType<typeof Y.Doc>;
export type YNode = InstanceType<typeof Y.Node>;
export type YUndoManager = InstanceType<typeof Y.UndoManager>;
export type YTransaction = Y.Transaction;
export type YItem = Y.Item;

/** Engine item identity — used by `crdtId` (`client:clock`). */
export type EngineItemRef = {
	id?: { client: number; clock: number };
	deleted?: boolean;
} | null;

/**
 * The deep-observer event surface (v14 `YEvent`, observed through
 * `observeDeep` on an ancestor — in our schema, the registry root).
 *
 * `deltaDeep` is the nested *modify* delta rooted at the observed node:
 * `toJSON()` yields `{type:'delta', attrs: {<attrKey>: op}}` where each op
 * is `{type:'insert'|'modify'|'delete', value?}` and a `modify` value is
 * itself a delta JSON — recursing down to the changed leaf. The run view
 * (`text/runs.ts`) parses exactly this shape to derive per-block
 * invalidation facets (`content` / `slices` / `del`). `delta` is the
 * shallow change delta of `target`.
 *
 * Not present on v13-style events — consumers must tolerate `undefined`.
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
	 * distinguishes local commits from remote applies). The assembled model
	 * (U06) uses this single channel to derive semantic change events.
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
	 * The doc's struct store — present on a real engine doc. Read-only from
	 * this layer; used by migration to detect PENDING state (update rows whose
	 * CRDT dependencies never landed — `pendingStructs`/`pendingDs` are
	 * non-null while deps are missing).
	 */
	readonly store?: {
		pendingStructs: null | { missing: Map<number, number>; update: Uint8Array };
		pendingDs: null | Uint8Array;
	};
	/**
	 * Optional in-gap rank randomness source (injected by the harness for
	 * determinism — production docs leave it unset and get `Math.random`).
	 */
	rand?: () => number;
}
