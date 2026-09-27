/**
 * Vendor-internal struct access — the ONE place Edytor code reaches into
 * the engine's struct store (`doc.store.clients`) and walks structs by id
 * set. Centralizing these reads keeps the blast radius of a vendored
 * engine upgrade in one module: when an internal is renamed or reshaped,
 * the fail-fast checks below break loudly at upgrade time instead of
 * silently disabling undo-repair or run invalidation (the old
 * optional-chained reads turned a rename into "repair quietly stops
 * firing").
 *
 * The engine surface is injected (`Y: EngineApi`) like every other bound
 * module — this file never imports vendor `.js`.
 */
import type { EngineApi, EngineDoc } from './engine-api.js';

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
	right?: StoreStruct | null;
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

/** This replica's next clock — it advances exactly when the replica writes an item. */
export const clockOf = (doc: EngineDoc): number => {
	const own = clientsOf(doc).get(doc.clientID);
	const last = own?.[own.length - 1];
	return last === undefined ? 0 : last.id.clock + last.length;
};

/** How many items the transaction has deleted so far (its delete set's length). */
export const deletedLen = (tr: unknown): number => {
	let n = 0;
	(tr as { deleteSet: IdSetLike }).deleteSet.clients.forEach((ranges) => {
		for (const r of ranges.getIds()) n += r.len;
	});
	return n;
};
