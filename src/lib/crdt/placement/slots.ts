/**
 * Slots and move records — where a block or an array item stands (fork
 * patch YP22).
 *
 * Every data owner keeps ONE order sequence, its node's list part (a block's
 * node, an atom's node, the registry root for the top-level blocks, the
 * `docdata` root for the document's data). The sequence holds one countable
 * unit per thing it orders:
 *
 * - a block's **home slot** `{ b: id }`, written once at the block's creation
 *   in its parent's sequence, right after its left sibling's unit (YATA's
 *   origin rule: later inserts there stay together, `order.insert.run`);
 * - an array item's **slot** `{ p: path, i: id }` (`crdt/data.ts`): the
 *   item exists while its slot does;
 * - a **move record** (the engine's `ContentMove`): one unit at the
 *   destination naming the units it moves, in order. Each named unit shows
 *   at the record that wins its movers — the greatest `(priority, client,
 *   clock)` — and reads as deleted at home, so a sequence walk sees it gone
 *   from there. Deleting a record (an undo) hands its units to the next
 *   record, else home.
 *
 * A reader of a sequence (`entriesOf`) walks its live items: a slot at home,
 * or a record expanded to the units it shows. A writer places a new slot or a
 * record after a displayed entry (`placeAfter`): when that entry is a unit in
 * the middle of a record's display, the new record also carries the record's
 * later units, so the new thing shows between them.
 *
 * The engine is read through `engine.js` (structural types, `engine-api.ts`).
 */
import type { EngineDoc, EngineNode } from '../engine-api.js';
import { Y } from '../engine.js';
import {
	asYDoc,
	clientsOf,
	engineOps,
	firstItem,
	storeOf,
	structAt,
	type StoreStruct
} from '../structs.js';

export type BlockId = string;
/**
 * A block's home slot in its parent's sequence; `s`, when the block was made
 * by a split (Enter, a paste of lines): the id (`client, clock`) of the
 * split's boundary item in the text, the engine's sort key among the slots
 * of one origin (the boundaries' order in the text, so two peers' splits of
 * one block keep its text's order, `order.split.text`).
 */
export type BlockSlot = { b: BlockId; s?: [client: number, clock: number] };
/** An array item's slot: the array's path (`crdt/data.ts`) and the item's id. */
export type DataSlot = { p: string; i: string };
/** One unit of a sequence: its engine id. */
export type Unit = { c: number; k: number };

export const isBlockSlot = (v: unknown): v is BlockSlot =>
	v != null && typeof v === 'object' && typeof (v as BlockSlot).b === 'string';
export const isDataSlot = (v: unknown): v is DataSlot =>
	v != null &&
	typeof v === 'object' &&
	typeof (v as DataSlot).p === 'string' &&
	typeof (v as DataSlot).i === 'string';

/** A sequence item as the slot reads walk it. */
export type SeqItem = StoreStruct & {
	left: SeqItem | null;
	right: SeqItem | null;
	content: {
		arr?: unknown[];
		priority?: number;
		side?: number;
		part?: number;
		at?: unknown;
		ids?: number[];
	};
	/** The record that shows this unit (fork patch YP22), `null` at home. */
	mover?: SeqItem | null;
	movers?: SeqItem[] | null;
	/** Removed or held: shown nowhere. */
	gone?: boolean;
};

/** Whether `it` is a move record. */
export const isRecord = (it: SeqItem): boolean =>
	it.content.priority !== undefined && it.content.ids !== undefined;

/** A record's stamp, the order its wins follow: `(priority, client, clock)`. */
export type Stamp = readonly [priority: number, client: number, clock: number];
export const stampOf = (r: SeqItem): Stamp => [r.content.priority!, r.id.client, r.id.clock];
export const cmpStamp = (a: Stamp, b: Stamp): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** One displayed entry of a sequence: its value, its unit, and the record it shows through (`at`: its place in the record's display). */
export type Entry = { value: unknown; unit: Unit; via: SeqItem | null; at: number };

const ops = engineOps(Y);

/** The item holding unit `u` and the value at it, or `null` when `doc` lacks it (a GC struct, not arrived). */
export const unitOf = (doc: EngineDoc, u: Unit): { item: SeqItem; value: unknown } | null => {
	const structs = clientsOf(doc).get(u.c);
	if (structs === undefined || u.k >= storeOf(doc).getClock(u.c)) return null;
	const item = structAt(Y, structs, u.k) as SeqItem | null;
	if (item === null || !ops.isItem(item)) return null;
	const arr = item.content.arr;
	return { item, value: arr === undefined ? undefined : arr[u.k - item.id.clock] };
};

/** The item holding unit `u`, or `null` when `doc` lacks it (no value read: the fold's hot path). */
export const itemAt = (doc: EngineDoc, u: Unit): SeqItem | null => {
	const structs = clientsOf(doc).get(u.c);
	if (structs === undefined || u.k >= storeOf(doc).getClock(u.c)) return null;
	const item = structAt(Y, structs, u.k) as SeqItem | null;
	return item === null || !ops.isItem(item) ? null : item;
};

/** The units record `r` shows, in order: those it wins (`mover === r`) and that are not gone. */
export const displayedUnits = (doc: EngineDoc, r: SeqItem): Entry[] => {
	const out: Entry[] = [];
	const ids = r.content.ids!;
	for (let i = 0; i < ids.length; i += 3)
		for (let k = 0; k < ids[i + 2]!; k++) {
			const unit = { c: ids[i]!, k: ids[i + 1]! + k };
			const u = unitOf(doc, unit);
			if (u !== null && u.item.mover === r && u.item.gone !== true)
				out.push({ value: u.value, unit, via: r, at: out.length });
		}
	return out;
};

/** The entries of `it` (a live slot item, or a record expanded), `[]` when it shows nothing. */
const entriesOfItem = (doc: EngineDoc, it: SeqItem): Entry[] => {
	if (it.deleted) return [];
	if (isRecord(it)) return displayedUnits(doc, it);
	const arr = it.content.arr;
	if (arr === undefined) return [];
	return arr.map((value, j) => ({
		value,
		unit: { c: it.id.client, k: it.id.clock + j },
		via: null,
		at: 0
	}));
};

/** The displayed entries of `node`'s sequence, in order. */
export const entriesOf = (doc: EngineDoc, node: EngineNode): Entry[] => {
	const out: Entry[] = [];
	for (let it = firstItem<SeqItem>(node); it !== null; it = it.right)
		for (const e of entriesOfItem(doc, it)) out.push(e);
	return out;
};

/**
 * The entry unit `home` displays as: at home when no live record wins it,
 * else at its mover (`via`, `at`); `null` when it shows nowhere (gone).
 */
export const anchorOf = (doc: EngineDoc, home: Unit): Entry | null => {
	const u = unitOf(doc, home);
	if (u === null || u.item.gone === true) return null;
	const r = u.item.mover ?? null;
	if (r === null || r.deleted) return { value: u.value, unit: home, via: null, at: 0 };
	const shown = displayedUnits(doc, r);
	const at = shown.findIndex((e) => e.unit.c === home.c && e.unit.k === home.k);
	return at < 0 ? null : shown[at]!;
};

/** The sequence node that holds `e`'s displaying item (its record's, or its slot's). */
export const nodeOf = (doc: EngineDoc, e: Entry): EngineNode =>
	(e.via !== null ? e.via.parent : unitOf(doc, e.unit)!.item.parent) as EngineNode;

/** The live index of the item that displays `e` (its record, or its slot unit). */
const liveIndexOf = (doc: EngineDoc, e: Entry): number => {
	const id =
		e.via === null ? Y.createID(e.unit.c, e.unit.k) : Y.createID(e.via.id.client, e.via.id.clock);
	return Y.indexOfId(asYDoc(doc), id)!.index;
};

/** `units` as `client, clock, len` triples (one unit each). */
export const triples = (units: readonly Unit[]): number[] => units.flatMap((u) => [u.c, u.k, 1]);

/**
 * Write new slots (`payloads`) and/or a move of `moved` (unit triples) into
 * `node`'s sequence right after the displayed entry `left` (at the start when
 * `null`; `right` the entry that follows, if any). When `left` is a unit in
 * the middle of a record's display, the record written here carries that
 * record's later units too, so the new entries show between them. `side` is
 * the record's class among the items of its origin (`0` after, `1` before);
 * `chain` the units the record stands at for the engine's sort of two
 * records at one origin, given its first unit — the home slots from the root
 * sequence down to the unit it stands at (`null`: the first unit alone) — and
 * `part` its order among the records standing there. `shown` reads the units
 * a record shows, as the reader sees them (the index's: a unit a cycle sent
 * back elsewhere is not carried). Returns the first new slot's unit (`null`
 * without slots).
 */
export const placeAfter = (
	doc: EngineDoc,
	node: EngineNode,
	left: Entry | null,
	right: Entry | null,
	payloads: readonly unknown[] | null,
	moved: readonly number[] | null = null,
	side = 0,
	part = 0,
	chain: ((first: Unit) => readonly Unit[]) | null = null,
	shown: (r: SeqItem) => Entry[] = (r) => displayedUnits(doc, r)
): Unit | null => {
	let index: number;
	let carry: number[] = [];
	if (left === null) index = right === null ? node.length : liveIndexOf(doc, right);
	else {
		if (left.via !== null) {
			const there = shown(left.via);
			carry = triples(there.slice(left.at + 1).map((e) => e.unit));
		}
		// A unit shown at home though its item moved away (a cycle sent it back)
		// is no live unit: the gap after it starts at its live index.
		const live = left.via !== null || unitOf(doc, left.unit)?.item.deleted !== true;
		index = liveIndexOf(doc, left) + (live ? 1 : 0);
	}
	let first: Unit | null = null;
	const units: number[] = moved === null ? [] : [...moved];
	if (payloads !== null && payloads.length > 0) {
		first = { c: doc.clientID, k: storeOf(doc).getClock(doc.clientID) };
		node.insert(index, payloads as unknown[]);
		if (carry.length > 0) units.push(first.c, first.k, payloads.length);
	}
	// A carried unit that moves here anyway is named once.
	const named = new Set<string>();
	for (let i = 0; i < units.length; i += 3)
		for (let k = 0; k < units[i + 2]!; k++) named.add(`${units[i]}:${units[i + 1]! + k}`);
	for (let i = 0; i < carry.length; i += 3)
		if (!named.has(`${carry[i]}:${carry[i + 1]}`)) units.push(carry[i]!, carry[i + 1]!, 1);
	if (units.length > 0 && (moved !== null || carry.length > 0)) {
		const at = chain === null ? null : chain({ c: units[0]!, k: units[1]! });
		// A chain of the first unit alone is the engine's default: not written.
		const own = at !== null && at.length === 1 && at[0]!.c === units[0] && at[0]!.k === units[1];
		node.move(
			index,
			units,
			side,
			part,
			at === null || own ? null : at.map((u) => Y.createID(u.c, u.k))
		);
	}
	return first;
};

/** Remove unit `u` from its sequence (the engine's delete: it shows nowhere any more). */
export const removeUnit = (doc: EngineDoc, u: Unit): void => {
	Y.transact(asYDoc(doc), (tr) => {
		const it = Y.getItemCleanStart(tr, Y.createID(u.c, u.k));
		if (it.length > 1) Y.getItemCleanStart(tr, Y.createID(u.c, u.k + 1));
		if (!it.removed) ops.remove(tr, it as unknown as StoreStruct);
	});
};
