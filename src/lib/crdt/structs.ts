/**
 * Vendor internals — the ONE place Edytor code reaches into the engine's
 * private state (the struct store, a node's attr items and first item,
 * the doc's collection settings and transaction events) and calls the
 * engine's internal functions with Edytor's structural views of its
 * objects. Centralizing these keeps the blast radius of a vendored engine
 * upgrade in one module: when an internal is renamed or reshaped, the
 * accessors below are the lines to change, and the fail-fast checks break
 * loudly at upgrade time instead of silently disabling run invalidation or
 * history lineage (the old optional-chained reads turned a rename into a
 * silent no-op).
 *
 * The model works against structural types (`EngineDoc`, `EngineNode`,
 * `StoreStruct`, `IdSetLike`: the subset it reads) while the engine's
 * generated declarations (`vendor/yjs/dts`) type its classes; a real engine
 * object satisfies the structural view at runtime. Each accessor states
 * that correspondence once, so a call site needs no cast.
 *
 * The engine surface is injected (`Y: EngineApi`) like every other bound
 * module — this file never imports vendor `.js`.
 */
import type { EngineApi, EngineDoc, EngineNode, YDoc, YNode, YUndoManager } from './engine-api.js';

/**
 * Structural shape of one store struct (Item | GC | Skip) — the subset
 * Edytor reads. `redone`/`keep` are local-only bits (never serialized).
 */
export type StoreStruct = {
	id: { client: number; clock: number };
	length: number;
	deleted: boolean;
	/** `null` for sequence items; an attr name for map-entry items. */
	parentSub: string | null;
	parent: unknown;
	left?: StoreStruct | null;
	right?: StoreStruct | null;
	content?: { arr?: unknown[] };
	countable?: boolean;
	keep?: boolean;
	redone?: { client: number; clock: number } | null;
};

/**
 * The engine's IdSet shape (insertSet/deleteSet): per-client range lists —
 * each `{clock, len}` covers a contiguous struct run in that client's
 * store list.
 */
export type IdSetLike = {
	clients: Map<number, { getIds(): { clock: number; len: number }[] }>;
	has(client: number, clock: number): boolean;
};

/**
 * The doc's struct store — vendor-internal (`doc.store.clients`).
 * FAIL-FAST: a missing store means the doc is not a vendored-engine doc
 * (or the vendored layout changed) — either way the only honest response
 * is a descriptive throw, never a silent fallback.
 */
export const clientsOf = (doc: EngineDoc): Map<number, StoreStruct[]> => {
	const clients = (doc as { store?: { clients?: Map<number, StoreStruct[]> } }).store?.clients;
	if (clients === undefined) {
		throw new Error(
			'structs: doc.store.clients missing — the vendored engine layout changed (or this doc is not a vendored-engine doc)'
		);
	}
	return clients;
};

/**
 * The struct covering `clock` in a client's clock-sorted struct list, or
 * `null` when no struct contains it. Wraps the vendor's `findIndexSS`
 * binary search — which THROWS on a miss — into the null-on-miss
 * convention callers use.
 */
export const structAt = (
	Y: EngineApi,
	structs: readonly StoreStruct[],
	clock: number
): StoreStruct | null => {
	if (structs.length === 0) return null;
	try {
		return (structs[Y.findIndexSS(structs as never[], clock)] as StoreStruct | undefined) ?? null;
	} catch {
		return null;
	}
};

/**
 * Walk every struct an IdSet covers, invoking `fn` per struct in
 * (client, clock) order. IdSet ranges are item-aligned (they record whole
 * structs), so an overlapping struct is a covered struct — the walk never
 * splits.
 *
 * `fn` returning `false` halts the walk early (caller-side short-circuit).
 *
 * Returns `false` when coverage was INCOMPLETE — a client's struct list
 * was missing or a range start could not be located — so the caller can
 * fall back to an all-consumers/opaque answer instead of trusting a
 * partial walk. `clientsOf` throws first when the store itself is absent.
 */
export const walkIdSetStructs = (
	Y: EngineApi,
	doc: EngineDoc,
	idSet: IdSetLike,
	fn: (struct: StoreStruct) => boolean | void
): boolean => {
	const clients = clientsOf(doc);
	let complete = true;
	let stopped = false;
	idSet.clients.forEach((ranges, client) => {
		if (stopped) return;
		const structs = clients.get(client);
		if (structs === undefined) {
			complete = false;
			return;
		}
		for (const r of ranges.getIds()) {
			const end = r.clock + r.len;
			let i: number;
			try {
				i = Y.findIndexSS(structs as never[], r.clock);
			} catch {
				complete = false;
				continue;
			}
			for (; i < structs.length; i++) {
				const s = structs[i]!;
				if (s.id.clock >= end) break;
				if (fn(s) === false) {
					stopped = true;
					return;
				}
			}
		}
	});
	return complete;
};

/**
 * {@link walkIdSetStructs}, clipped: `fn(struct, from, to)` gets the clock
 * range `[from, to)` of the struct the id set covers (a struct can reach past
 * a range a diff of two id sets cut).
 */
export const walkIdSetRanges = (
	Y: EngineApi,
	doc: EngineDoc,
	idSet: IdSetLike,
	fn: (struct: StoreStruct, from: number, to: number) => void
): boolean => {
	const clients = clientsOf(doc);
	let complete = true;
	idSet.clients.forEach((ranges, client) => {
		const structs = clients.get(client);
		if (structs === undefined) {
			complete = false;
			return;
		}
		for (const r of ranges.getIds()) {
			const end = r.clock + r.len;
			let i: number;
			try {
				i = Y.findIndexSS(structs as never[], r.clock);
			} catch {
				complete = false;
				continue;
			}
			for (; i < structs.length; i++) {
				const s = structs[i]!;
				if (s.id.clock >= end) break;
				fn(s, Math.max(r.clock, s.id.clock), Math.min(end, s.id.clock + s.length));
			}
		}
	});
	return complete;
};

/**
 * The id the local `redone` chain leads `id` to: the copy an undo or redo
 * on THIS replica re-created of a deleted item (redo copies chain), or `id`
 * itself. Replica-dependent by design: only the replica that ran the
 * history command has the chain.
 */
export const followRedone = (
	Y: EngineApi,
	doc: EngineDoc,
	id: { client: number; clock: number }
): { client: number; clock: number } => {
	const clients = clientsOf(doc);
	for (let at = id; ; ) {
		const struct = structAt(Y, clients.get(at.client) ?? [], at.clock);
		if (!struct?.redone) return at;
		at = { client: struct.redone.client, clock: struct.redone.clock + at.clock - struct.id.clock };
	}
};

/**
 * Forget `node`'s search markers (vendor-internal `_searchMarker`, fork patch YP4): a
 * write made through items directly (a delete or `redoItem`, not the node's
 * own insert/delete methods) leaves their indices stale — the engine's undo
 * drops them the same way after a pop.
 */
export const dropSearchMarkers = (node: unknown): void => {
	const markers = (node as { _searchMarker?: unknown[] | null } | null)?._searchMarker;
	if (markers) markers.length = 0;
};

/** The clock `client`'s next struct gets in `doc`. */
export const nextClock = (doc: EngineDoc, client: number): number => {
	const structs = clientsOf(doc).get(client);
	const last = structs?.[structs.length - 1];
	return last === undefined ? 0 : last.id.clock + last.length;
};

/**
 * Whether `doc` holds updates it cannot integrate yet (vendor-internal
 * `store.pendingStructs`/`pendingDs`): an out-of-order delivery can apply
 * a delete whose replacement is still pending, so an attr may read
 * undefined until the missing update arrives.
 */
export const holdsPending = (doc: EngineDoc): boolean => {
	const store = (doc as { store?: { pendingStructs?: unknown; pendingDs?: unknown } }).store;
	return (store?.pendingStructs ?? null) !== null || (store?.pendingDs ?? null) !== null;
};

/**
 * The transactions the engine has opened and not finished cleaning up
 * (vendor-internal `doc._transactionCleanups`), in order: the open one, and
 * those started during an earlier one's cleanup, whose bodies already ran
 * and whose observers have not.
 */
export const queuedTransactions = (doc: EngineDoc): readonly unknown[] =>
	(doc as { _transactionCleanups?: unknown[] })._transactionCleanups ?? [];

// ── views: the engine's objects as the structural types ─────────────────

/**
 * A vendored document through the structural view the model works against
 * (`EngineDoc`). The two differ only where the engine types an attr key
 * `string | number`: edytor writes string keys only.
 */
export const asEngineDoc = (doc: YDoc): EngineDoc => doc as unknown as EngineDoc;

/** The vendored document behind a structural one (every `EngineDoc` edytor holds is one). */
export const asYDoc = (doc: EngineDoc): YDoc => doc as unknown as YDoc;

/** The vendored node behind a structural one (every `EngineNode` edytor holds is one). */
export const asYNode = (node: EngineNode): YNode => node as unknown as YNode;

/** A new detached node of the engine, through the structural view. */
export const newNode = (Y: EngineApi, name: string): EngineNode =>
	new Y.Node(name) as unknown as EngineNode;

/**
 * A renderer-free bounded read cursor on `node` (the fork's `RangeCursor`),
 * in the caller's view of a cursor.
 */
export const rangeCursorOf = <C>(Y: EngineApi, node: EngineNode): C =>
	new Y.RangeCursor(asYNode(node), null) as unknown as C;

// ── node and document internals ──────────────────────────────────────────

/**
 * A node's attr entries (vendor `_map`): per key, the item of its current
 * value (deleted when the key was removed). `I` is the caller's view of an
 * item.
 */
export const attrItems = <I = StoreStruct>(node: EngineNode | YNode): Map<string, I> =>
	(node as unknown as { _map: Map<string, I> })._map;

/** A node's first sequence item (vendor `_start`), `null` when it holds none. */
export const firstItem = <I = StoreStruct>(node: EngineNode | YNode): I | null =>
	(node as unknown as { _start?: I | null })._start ?? null;

/** A node's sequence length as the engine keeps it (vendor `_length`). */
export const sequenceLength = (node: EngineNode | YNode): number =>
	(node as unknown as { _length: number })._length;

/** The item a node is the value of (`_item`), in the caller's view. */
export const itemOf = <I = StoreStruct>(node: EngineNode): I | null =>
	node._item as unknown as I | null;

/**
 * Run `f` with `node`'s renderer (vendor `_renderer`) set aside: a write
 * addresses live-content space, whatever renderer a reader installed.
 */
export const withoutRenderer = <T>(node: EngineNode, f: () => T): T => {
	const n = node as unknown as { _renderer: unknown };
	const renderer = n._renderer;
	n._renderer = null;
	try {
		return f();
	} finally {
		n._renderer = renderer;
	}
};

/** The struct store's reads edytor makes (vendor `doc.store`). */
export type StoreLike = {
	clients: Map<number, StoreStruct[]>;
	getClock(client: number): number;
	getItem(id: { client: number; clock: number }): StoreStruct;
};

/** The doc's struct store (vendor `store`). */
export const storeOf = (doc: EngineDoc | YDoc): StoreLike =>
	(doc as unknown as { store: StoreLike }).store;

/** The doc's collection settings (vendor `gc`, `gcFilter`), in the caller's view of an item. */
type Collection<I> = { gc: boolean; gcFilter: (item: I) => boolean };

/** Whether `doc` collects deleted content at all (vendor `gc`). */
export const collects = (doc: EngineDoc | YDoc): boolean =>
	(doc as unknown as Collection<unknown>).gc;

/** Whether `doc`'s collection filter lets it collect `item` (vendor `gcFilter`). */
export const collectable = (doc: EngineDoc | YDoc, item: unknown): boolean =>
	(doc as unknown as Collection<unknown>).gcFilter(item);

/**
 * Keep from collection what `keep` answers: `doc`'s filter becomes the one
 * it had and `keep` (vendor `gcFilter`).
 */
export const keepFromCollection = <I = StoreStruct>(
	doc: EngineDoc | YDoc,
	keep: (item: I) => boolean
): void => {
	const d = doc as unknown as Collection<I>;
	const before = d.gcFilter;
	d.gcFilter = (item) => before(item) && keep(item);
};

/**
 * Collect `item` now, inside `tr` (vendor `Item#gc`): what the engine does
 * at a delete when no history keeps the item. The caller has asked
 * {@link collects} and {@link collectable}.
 */
export const collectNow = (item: object, tr: unknown): void =>
	(item as unknown as { gc(tr: unknown, parentGCd: boolean): void }).gc(tr, false);

/**
 * Listen to `doc`'s transaction events (vendor `beforeTransaction`,
 * `afterTransaction`), with the caller's view of a transaction.
 */
export const onTransaction = <T>(
	doc: EngineDoc | YDoc,
	event: 'beforeTransaction' | 'afterTransaction',
	f: (tr: T) => void
): void => (doc as unknown as { on(e: string, f: (tr: T) => void): void }).on(event, f);

/** The steps of a history's undo stack (or its redo stack), in the caller's view. */
export const stepsOf = <S>(stack: YUndoManager['undoStack']): S[] => stack as unknown as S[];

// ── engine functions over the structural views ──────────────────────────

/** An engine id set as the model reads and writes it. */
export type IdSetOf = IdSetLike & {
	add(client: number, clock: number, len: number): void;
	intersects(client: number, clock: number, len: number): boolean;
};

/**
 * The engine's id-set and item functions, taking and answering the
 * structural views (`IdSetOf`, `StoreStruct`, a transaction as `unknown`).
 */
export const engineOps = (Y: EngineApi) => {
	type V = Parameters<EngineApi['diffIdSet']>[0];
	type Tr = Parameters<EngineApi['iterateStructsByIdSet']>[0];
	type Item = Parameters<EngineApi['redoItem']>[1];
	return {
		/** A new empty id set. */
		idSet: (): IdSetOf => Y.createIdSet() as unknown as IdSetOf,
		/** The ids of `a` that are not in `b`. */
		diff: (a: IdSetLike, b: IdSetLike): IdSetOf =>
			Y.diffIdSet(a as unknown as V, b as unknown as V) as unknown as IdSetOf,
		/** Add the ids of `from` to `into`. */
		insertInto: (into: IdSetLike, from: IdSetLike): void =>
			Y.insertIntoIdSet(into as unknown as V, from as unknown as V),
		/** Each struct `ids` covers, split at its edges, inside `tr`. */
		iterate: <I = StoreStruct>(tr: unknown, ids: IdSetLike, f: (item: I) => void): void =>
			Y.iterateStructsByIdSet(tr as Tr, ids as unknown as V, f as unknown as (s: unknown) => void),
		/** The item starting at `client:clock`, split there, inside `tr`. */
		cleanStart: <I = StoreStruct>(tr: unknown, client: number, clock: number): I =>
			Y.getItemCleanStart(tr as Tr, Y.createID(client, clock)) as unknown as I,
		/**
		 * Re-create deleted `item` as the engine's undo does (`redoItem`): its
		 * copy, or `null` when it cannot come back.
		 */
		redo: <I = StoreStruct>(tr: unknown, item: I, items: Set<I>, um: YUndoManager): I | null =>
			Y.redoItem(
				tr as Tr,
				item as unknown as Item,
				items as unknown as Set<Item>,
				Y.createIdSet(),
				false,
				um
			) as unknown as I | null,
		/**
		 * Integrate a new item holding `content` right after `left` (its
		 * origin: `left`'s last id) in `parent`, written by `client` at
		 * `clock`, inside `tr`.
		 */
		appendAfter: (
			tr: unknown,
			left: StoreStruct,
			parent: EngineNode,
			client: number,
			clock: number,
			content: unknown[]
		): void => {
			const item = new Y.Item(
				Y.createID(client, clock),
				left as unknown as Item,
				(left as unknown as Item).lastId,
				null,
				null,
				asYNode(parent),
				null,
				new Y.ContentAny(content)
			);
			item.integrate(tr as Tr, 0);
		},
		/** Whether `item` is a node value a concurrent write replaced and its doc keeps. */
		isKeptReplaced: (item: unknown): boolean => Y.isKeptReplaced(item as Item)
	};
};
