/**
 * Block, atom and document data (properties) as fine-grained leaves.
 *
 * A node's data is a JSON object stored one attr per leaf: `d/` and the
 * leaf's path as an RFC 6901 pointer without its leading `/` (`~` → `~0`,
 * `/` → `~1`). A leaf is a primitive, `null` or an empty container (`{}`,
 * `[]`), so an emptied one persists. An array is its `[]` leaf plus its
 * items: item `id` keeps its value under the segment `~id` (a primitive at
 * it, an object's or array's leaves under it), and its existence and place
 * are its SLOT `{ p, i }` in the owner's one order sequence — the node's
 * list part (`placement/slots.ts`, fork patch YP22): an item lives while a
 * live slot of its id does (the first live slot of an id counts: two peers
 * adopting one array write two), the order is the sequence's, and a move is
 * a move record there. `~` and a letter is no escape, so no key reads as an
 * item. Each leaf is a map entry, so different keys and different items
 * merge and one key is last writer wins; a delete removes the item's slots
 * and leaves, so a concurrent edit inside it or move of it leaves orphans
 * the read skips. A path names an item by index or by id, so a held item
 * is reached wherever peers moved it; an id that names no live item
 * refuses the patch, so nothing is written under a dead item. A key
 * starting with `~` is `~0…` in a path (`keySegment`).
 *
 * Read rule: the leaves are read as a tree; a path with live items is an
 * array (in slot order), one with keys an object (it beats a primitive leaf
 * at the same path: Ada sets `a = 1` while Bob sets `a.b = 2`), else its
 * leaf. A leaf holding an object or an array (an atomic path's,
 * `data.atomic`, or an array 0.1.0-next.6 wrote) reads as its keys or as
 * items with ids derived from the array (as any array assigned where no
 * item is), so two replicas writing into it write the same items; a patch
 * opens it only along its path, and the first write through it gives every
 * item its slot.
 */
import type { EngineNode } from './engine-api.js';
import { DATA_LEAF_PREFIX } from './schema.js';
import { hash32 } from './rand.js';
import { jsonEquals } from '../utils/json.js';
import {
	entriesOf,
	isDataSlot,
	placeAfter,
	removeUnit,
	triples,
	type DataSlot,
	type Entry
} from './placement/slots.js';
import { asEngineDoc } from './structs.js';

type JsonObj = Record<string, unknown>;

/**
 * One data edit at `path` (object keys and array indexes from the data's
 * root): `splice` takes `Array.prototype.splice`'s arguments and `order`
 * the array's current indexes in their new order; else it sets `value`, or
 * deletes the key or removes the item when there is none.
 */
export type DataPatch = {
	readonly path: readonly string[];
	readonly value?: unknown;
	readonly splice?: readonly [start: number, deleteCount?: number, ...items: unknown[]];
	readonly order?: readonly number[];
};

/** An attr write a patch plans: the key and its value, `undefined` to delete it. */
export type LeafWrite = readonly [key: string, value: unknown];
/**
 * A sequence write a patch plans (`placement/slots.ts`): new items' slots
 * after item `after` (`null`: first) of the array at `path`, a move of items
 * there, or the removal of items' slots.
 */
export type SlotWrite =
	| { seq: 'insert'; path: string; after: string | null; ids: string[] }
	| { seq: 'move'; path: string; after: string | null; ids: string[] }
	| { seq: 'remove'; path: string; ids: string[] };
/** One write a data patch plans. */
export type DataWrite = LeafWrite | SlotWrite;

export const isObject = (v: unknown): v is JsonObj =>
	v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A path of the data as a tree: its leaf (`v`), its segments' subtrees, its
 * items in order (`items`, when it is an array) and, among them, those whose
 * slot is not written yet (`unslotted`: derived from a closed leaf).
 */
type Tree = {
	p: string;
	v?: unknown;
	k: Map<string, Tree>;
	items?: string[];
	unslotted?: Set<string>;
};
type Entry_ = { id?: string; keep?: boolean; value?: unknown };

const tree = (p = '', v?: unknown): Tree => ({ p, v, k: new Map() });
const kid = (t: Tree, s: string): Tree =>
	t.k.get(s) ?? t.k.set(s, tree(t.p === '' ? s : `${t.p}/${s}`)).get(s)!;
const enc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');
const dec = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~');
const itemish = (s: string) => /^~[a-z]/.test(s);
/**
 * Key `k` as a patch path segment: a leading `~` as `~0` (RFC 6901), so a
 * key spelled like an item id (`~abc`) never names one.
 */
export const keySegment = (k: string) => (k.startsWith('~') ? `~0${k.slice(1)}` : k);
/** The object key a path segment names (`keySegment`'s inverse). */
export const segmentKey = (s: string) => (s.startsWith('~0') ? `~${s.slice(2)}` : s);
const index = (k: string) => (/^(0|[1-9]\d*)$/.test(k) ? Number(k) : -1);
/** `t`'s live items in order. */
const itemsOf = (t: Tree): string[] => t.items ?? [];
const isArr = (t: Tree) => Array.isArray(t.v) || itemsOf(t).length > 0;
/** The item `seg` names among `items`: by its id (`~…`) or by its index. */
const itemAt = (items: string[], seg: string): string | undefined =>
	itemish(seg) ? items.find((i) => i === seg) : items[index(seg)];

/** Whether `t` holds a non-empty object or array as one leaf (no subtree under it). */
const closed = (t: Tree): boolean =>
	t.k.size === 0 &&
	itemsOf(t).length === 0 &&
	t.v !== null &&
	typeof t.v === 'object' &&
	Object.keys(t.v).length > 0;
/** `t` with a container leaf's value as its subtree: its keys, or derived items (slotless until written). */
const open = (t: Tree): Tree => {
	if (closed(t)) {
		const value = t.v;
		t.v = undefined;
		derived.assign(t, value);
		if (t.items !== undefined) t.unslotted = new Set(t.items);
	}
	return t;
};

/** The JSON `t` reads as (`undefined` for nothing): a fresh value. */
const valueOf = (t: Tree): unknown => {
	if (closed(t)) return valueOf(open(tree(t.p, t.v)));
	const items = itemsOf(t);
	if (items.length) return items.map((id) => valueOf(t.k.get(id) ?? tree()) ?? null);
	const keys = [...t.k]
		.map(([s, c]) => [dec(s), itemish(s) ? undefined : valueOf(c)] as const)
		.filter(([, v]) => v !== undefined);
	// Own properties only: a `__proto__` key (a peer's too) is data, never a prototype.
	return keys.length ? Object.fromEntries(keys) : t.v;
};

/** The ordered item ids per array path, read from the owner's sequence (the first live slot of an id counts). */
type Slots = Map<string, string[]>;
const treeOf = (leaves: Map<string, unknown>, slots: Slots): Tree => {
	const root = tree();
	for (const [key, v] of [...leaves].sort(([a], [b]) => (a < b ? -1 : 1)))
		key.slice(DATA_LEAF_PREFIX.length).split('/').reduce(kid, root).v = v;
	for (const [p, ids] of slots) {
		const t = p === '' ? root : p.split('/').reduce(kid, root);
		t.items = ids;
	}
	return root;
};
const leavesFrom = (t: Tree, prefix = DATA_LEAF_PREFIX, out = new Map<string, unknown>()) => {
	for (const [s, c] of t.k) {
		if (c.v !== undefined) out.set(prefix + s, c.v);
		leavesFrom(c, `${prefix}${s}/`, out);
	}
	return out;
};

/**
 * Past this many candidate pairs (equal elements of the two middles),
 * `common` pairs nothing between the prefix and the suffix.
 */
const PAIRS_BOUND = 1 << 18;
/**
 * A common subsequence of `a` and `b`, as index pairs, in time and memory
 * linear in their lengths: the common prefix and suffix, then
 * between them a longest common subsequence (Hunt–Szymanski: the candidate
 * pairs, each element of `b` against the equal ones of `a`, read as a
 * longest increasing run, `O(r log n)` for `r` pairs), exact while there
 * are at most `PAIRS_BOUND` candidates (always when `a`'s middle values are
 * distinct, as `order`'s ids are); past it nothing between them pairs, so
 * `arrange` pairs those items by position.
 */
export const common = (a: readonly string[], b: readonly string[]): [number, number][] => {
	let [n, m, start] = [a.length, b.length, 0];
	while (start < n && start < m && a[start] === b[start]) start++;
	while (n > start && m > start && a[n - 1] === b[m - 1]) [n, m] = [n - 1, m - 1];
	const out: [number, number][] = [];
	for (let k = 0; k < start; k++) out.push([k, k]);
	// Where each value of `a`'s middle stands, descending.
	const at = new Map<string, number[]>();
	for (let i = n - 1; i >= start; i--) {
		const list = at.get(a[i]!);
		if (list) list.push(i);
		else at.set(a[i]!, [i]);
	}
	const mid = b.slice(start, m);
	let pairs = 0;
	for (const s of mid) pairs += at.get(s)?.length ?? 0;
	if (pairs <= PAIRS_BOUND) {
		// `ends[k]`: the smallest index of `a` a run of `k + 1` pairs ends at; `last[k]`, that pair.
		const [ends, last]: number[][] = [[], []];
		const [is, js, prev] = [new Int32Array(pairs), new Int32Array(pairs), new Int32Array(pairs)];
		let p = 0;
		mid.forEach((s, d) => {
			// Descending, so one element of `b` never extends a run it ends.
			for (const i of at.get(s) ?? []) {
				let [lo, hi] = [0, ends.length];
				while (lo < hi) {
					const h = (lo + hi) >> 1;
					if (ends[h]! < i) lo = h + 1;
					else hi = h;
				}
				[is[p], js[p], prev[p]] = [i, start + d, lo ? last[lo - 1]! : -1];
				[ends[lo], last[lo]] = [i, p++];
			}
		});
		const run: [number, number][] = [];
		for (let q = ends.length ? last[ends.length - 1]! : -1; q >= 0; q = prev[q]!)
			run.push([is[q]!, js[q]!]);
		out.push(...run.reverse());
	}
	for (let k = 0; n + k < a.length; k++) out.push([n + k, m + k]);
	return out;
};
/** `v` as JSON with sorted keys: equal values, equal strings. */
const canon = (v: unknown) =>
	JSON.stringify(v, (_, x) => (isObject(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
/** New items holding `values`. */
const added = (values: unknown[]): Entry_[] => values.map((value) => ({ value }));

/**
 * The tree edits. New items take ids from `rand`; without `rand` they are
 * derived from their indexes and `client` (a new array's hash), so equal
 * values write equal items everywhere. The sequence writes they need
 * (slots, moves, removals) go to `out`.
 */
const edits = (rand?: () => number, client = 0, out?: SlotWrite[]) => {
	const fresh = (t: Tree, i: number): string => {
		for (;;) {
			const id = rand
				? `~${Math.floor(36 ** 7 * (10 + 26 * rand())).toString(36)}`
				: `~l${i++}.${client.toString(36)}`;
			if (!t.k.has(id) && !itemsOf(t).includes(id)) return id;
		}
	};
	const remove = (t: Tree, id: string) => {
		const item = t.k.get(id);
		if (item !== undefined) drop(item);
		t.k.delete(id);
		if (t.items !== undefined) t.items = t.items.filter((x) => x !== id);
		if (t.unslotted?.delete(id) !== true) out?.push({ seq: 'remove', path: t.p, ids: [id] });
	};
	/** What `t` held goes with it: the slots of every array at or under it. */
	const drop = (t: Tree): void => {
		for (const id of itemsOf(t)) remove(t, id);
		for (const c of t.k.values()) drop(c);
	};
	/**
	 * Give `entries` (kept items, moved items, new values) their places in
	 * `t`, in order: each new item's slot and each moved item's record go
	 * right after the entry before it (YATA's origin rule keeps what one
	 * writer puts after an item together, whatever a peer inserts there
	 * meanwhile), consecutive ones as one write.
	 */
	const lay = (t: Tree, entries: Entry_[]): void => {
		const ids: string[] = [];
		let after: string | null = null;
		let run: SlotWrite | null = null;
		for (let p = 0; p < entries.length; p++) {
			const e = entries[p]!;
			let id = e.id;
			let seq: 'insert' | 'move' | null = null;
			if (id === undefined) {
				id = fresh(t, p);
				assign(kid(t, id), e.value);
				seq = 'insert';
			} else if (t.unslotted?.delete(id)) seq = 'insert';
			else if (!e.keep) seq = 'move';
			ids.push(id);
			if (seq !== null && out !== undefined) {
				if (run !== null && run.seq === seq) run.ids.push(id);
				else out.push((run = { seq, path: t.p, after, ids: [id] }));
			} else run = null;
			after = id;
		}
		t.items = ids;
	};
	/** Make `t` read as `value`, writing only what differs: objects key by key, arrays item by item. */
	const assign = (t: Tree, value: unknown): void => {
		if (Array.isArray(value) && itemsOf(open(t)).length) return arrange(t, value);
		// Anything else replaces what `t` held, but an object's equal keys.
		const object = isObject(value) && Object.keys(value).length > 0;
		for (const id of itemsOf(t)) remove(t, id);
		for (const s of [...t.k.keys()])
			if (!object || itemish(s) || !Object.hasOwn(value, dec(s))) {
				drop(t.k.get(s)!);
				t.k.delete(s);
			}
		t.v = object ? undefined : Array.isArray(value) ? [] : value;
		if (object) for (const [k, v] of Object.entries(value)) assign(kid(t, enc(k)), v);
		// A new array's items derive from it: two peers making the same one make one.
		if (Array.isArray(value)) edits(undefined, hash32(canon(value)), out).lay(t, added(value));
	};
	/**
	 * An array reassigned: the items a longest common run keeps equal stay;
	 * between two of them, old and new items pair by position (each keeps
	 * its id and takes the new value), the rest are removed or inserted.
	 */
	const arrange = (t: Tree, next: unknown[]): void => {
		const old = itemsOf(t);
		const was = old.map((id) => canon(valueOf(t.k.get(id) ?? tree()) ?? null));
		const entries: Entry_[] = [];
		let [i, j] = [0, 0];
		for (const [mi, mj] of [...common(was, next.map(canon)), [old.length, next.length]]) {
			for (let n = 0; n < Math.max(mi - i, mj - j); n++) {
				const o = i + n < mi ? old[i + n] : undefined;
				if (j + n >= mj) remove(t, o!);
				else if (o === undefined) entries.push({ value: next[j + n] });
				else {
					entries.push({ id: o, keep: true });
					assign(kid(t, o), next[j + n]);
				}
			}
			if (mi < old.length) entries.push({ id: old[mi]!, keep: true });
			[i, j] = [mi + 1, mj + 1];
		}
		t.v = [];
		lay(t, entries);
	};
	/**
	 * The tree at `path` (objects made along it), or `undefined` where an
	 * index or id fits no live item (an id where no array is: removed with it).
	 */
	const reach = (t: Tree | undefined, path: readonly string[]): Tree | undefined => {
		for (const k of path) {
			if (!t) return t;
			if (isArr(open(t))) {
				const item = itemAt(itemsOf(t), k);
				t = item === undefined ? undefined : kid(t, item);
			} else if (itemish(k)) return undefined;
			else {
				t.v = undefined; // a value on the way becomes an object
				t = kid(t, enc(segmentKey(k)));
			}
		}
		return t && open(t);
	};
	/** Apply `patch` to `root`; `false` when it fits no value there. */
	const apply = (root: Tree, { path, value, splice, order }: DataPatch): boolean => {
		const at = reach(root, splice || order ? path : path.slice(0, -1));
		if (!at) return false;
		const items = isArr(at) ? itemsOf(at) : undefined;
		const list: Entry_[] = items?.map((id) => ({ id, keep: true })) ?? [];
		const k = path.at(-1);
		if (order) {
			const ids = Array.isArray(order) ? order.map((i) => list[i]?.id) : [];
			const permutes = new Set(ids).size === list.length && !ids.includes(undefined);
			if (!items || ids.length !== list.length || !permutes) return false;
			// What a longest increasing run keeps in place stays; the others move.
			const was = list.map((e) => e.id!);
			const kept = new Set(common(was, ids as string[]).map(([, p]) => p));
			list.splice(0, list.length, ...ids.map((id, p) => ({ id, keep: kept.has(p) })));
		} else if (splice) {
			const [start, count, ...values] = Array.isArray(splice) ? splice : [];
			if (!items || !Number.isInteger(start) || (splice.length > 1 && !Number.isInteger(count)))
				return false;
			const removed =
				splice.length > 1 ? list.splice(start!, count!, ...added(values)) : list.splice(start!);
			for (const e of removed) remove(at, e.id!);
		} else if (k === undefined) {
			assign(root, isObject(value) ? value : {});
			return true;
		} else if (!items) {
			if (itemish(k)) return false; // an item where no array is
			if (value !== undefined) assign(reach(at, [k])!, value);
			else {
				const gone = at.k.get(enc(segmentKey(k)));
				if (gone !== undefined) drop(gone);
				// The last key of an object deleted keeps the object.
				if (at.k.delete(enc(segmentKey(k))) && at !== root && valueOf(at) === undefined) at.v = {};
			}
			return true;
		} else {
			const i = itemish(k) ? list.findIndex((e) => e.id === k) : index(k);
			if (i < 0) return false; // no such index, or the item is gone
			if (value === undefined) list.splice(i, 1).forEach((e) => remove(at, e.id!));
			else if (i < list.length) assign(kid(at, list[i]!.id!), value);
			else list.push(...added([...Array(i - list.length).fill(null), value]));
		}
		at.v = [];
		lay(at, list);
		return true;
	};
	return { assign, apply, lay };
};
const derived = edits();

const leavesOf = (node: EngineNode): Map<string, unknown> => {
	const out = new Map<string, unknown>();
	for (const key of node.attrKeys())
		if (key.startsWith(DATA_LEAF_PREFIX)) out.set(key, node.getAttr(key));
	return out;
};
/** The data slots of `node`'s sequence as displayed: per array path, its item ids in order (an id once), and each id's entries. */
const slotsOf = (node: EngineNode): { slots: Slots; entries: Map<string, Entry[]> } => {
	const slots: Slots = new Map();
	const entries = new Map<string, Entry[]>();
	if (node.doc == null) return { slots, entries };
	for (const e of entriesOf(asEngineDoc(node.doc as never), node)) {
		if (!isDataSlot(e.value)) continue;
		const { p, i } = e.value;
		const key = `${p}\u0000${i}`;
		const list = entries.get(key);
		if (list === undefined) {
			entries.set(key, [e]);
			const ids = slots.get(p);
			if (ids === undefined) slots.set(p, [i]);
			else ids.push(i);
		} else list.push(e);
	}
	return { slots, entries };
};
/** The leaves of `value` under `prefix`, and the slots of its arrays' items, derived from them. */
const writesOfValue = (value: unknown): DataWrite[] => {
	const t = tree();
	const out: SlotWrite[] = [];
	edits(undefined, 0, out).assign(t, value);
	return [...leavesFrom(t), ...out];
};
/** A new node's data, as the writes that give it (its leaves and its arrays' slots). */
export const dataWrites = (data: unknown): DataWrite[] => writesOfValue(isObject(data) ? data : {});
/** A path of the data as a leaf key (`d/` and its pointer). */
export const leafKey = (path: readonly string[]): string =>
	DATA_LEAF_PREFIX + path.map((k) => enc(k)).join('/');
/** A path of the data as a slot's `p` (its pointer without `d/`). */
const slotPath = (key: string): string => key.slice(DATA_LEAF_PREFIX.length);

/**
 * The leaves of `root` with every atomic path (`data.atomic`: a leaf key a
 * kind declares) holding one leaf: the value of everything at and under it.
 */
const collapse = (root: Tree, atomic: readonly string[]) => {
	for (const key of atomic) {
		let t: Tree | undefined = root;
		for (const s of slotPath(key).split('/')) t = t?.k.get(s);
		if (t === undefined || (t.k.size === 0 && itemsOf(t).length === 0)) continue;
		t.v = valueOf(t);
		t.k.clear();
		t.items = undefined;
		t.unslotted = undefined;
	}
	return leavesFrom(root);
};
/** Whether `path` (a slot's `p`) lies at or under one of the atomic leaf keys. */
const underAtomic = (path: string, atomic: readonly string[]): boolean =>
	atomic.some((key) => {
		const a = slotPath(key);
		return path === a || path.startsWith(`${a}/`);
	});
/** `node`'s data (`undefined` when it has none). */
export const readData = (node: EngineNode): JsonObj | undefined =>
	valueOf(treeOf(leavesOf(node), slotsOf(node).slots)) as JsonObj | undefined;

/**
 * The ids of the items of the array at `path` (keys, item indexes or ids)
 * in `node`'s data, in order; `[]` where no array is.
 */
export const itemIds = (node: EngineNode, path: readonly string[]): string[] =>
	idsAt(treeOf(leavesOf(node), slotsOf(node).slots), path);
const idsAt = (root: Tree, path: readonly string[]): string[] => {
	let t: Tree | undefined = root;
	for (const k of path)
		if (t && isArr(open(t))) {
			const item = itemAt(itemsOf(t), k);
			t = item === undefined ? undefined : t.k.get(item);
		} else t = itemish(k) ? undefined : t?.k.get(enc(segmentKey(k)));
	return t ? itemsOf(open(t)) : [];
};

/**
 * `node`'s data as it reads once `patches` are applied (nothing written),
 * with the ids of the array items at a path (`itemIds`): an item a patch
 * makes has no slot yet (`''`), so a later patch names it by index.
 * `null` when a patch fits no value.
 */
export const previewData = (
	node: EngineNode | undefined,
	patches: readonly DataPatch[]
): { data: JsonObj; ids: (path: readonly string[]) => string[] } | null => {
	const base = node ? leavesOf(node) : new Map<string, unknown>();
	const { slots } = node ? slotsOf(node) : { slots: new Map() as Slots };
	const root = treeOf(base, slots);
	if (!patches.every((p) => edits().apply(root, p))) return null;
	const known = new Set([...slots.values()].flat());
	return {
		data: (valueOf(root) as JsonObj | undefined) ?? {},
		ids: (path) => idsAt(root, path).map((id) => (known.has(id) ? id : ''))
	};
};

/** `data` with `patches` applied in order, as a fresh value (a root patch replaces it); `null` when one fits no value. */
export const applyPatch = (data: JsonObj, patches: readonly DataPatch[]): JsonObj | null => {
	const root = tree();
	derived.assign(root, data);
	if (!patches.every((p) => derived.apply(root, p))) return null;
	return (valueOf(root) as JsonObj | undefined) ?? {};
};

/**
 * The writes that give `node` the data `patches` make of its own (new
 * items get ids from `rand`), or `null` when a patch fits no value there:
 * only the leaves of the keys and items a patch touches change, so a
 * concurrent edit of another key or item is kept, and only the slots of
 * the items it makes, moves or removes. An atomic path is written as one
 * leaf and the leaves and slots under it are dropped. An unchanged value
 * writes nothing.
 */
export const patchWrites = (
	node: EngineNode,
	patches: readonly DataPatch[],
	client = 0,
	rand?: () => number,
	atomic: readonly string[] = []
): DataWrite[] | null => {
	const now = leavesOf(node);
	const { slots } = slotsOf(node);
	const root = treeOf(now, slots);
	const before = valueOf(root);
	const seq: SlotWrite[] = [];
	const { apply } = edits(rand, client, seq);
	if (!patches.every((p) => apply(root, p))) return null;
	if (jsonEquals(before, valueOf(root))) return [];
	const want = collapse(root, atomic);
	const leaves = [...new Set([...now.keys(), ...want.keys()])]
		.filter((key) => !jsonEquals(now.get(key), want.get(key)))
		.map((key) => [key, want.get(key)] as const);
	return [...leaves, ...seq.filter((w) => !underAtomic(w.path, atomic))];
};

/**
 * Write `writes` on `node`: its attrs, and its arrays' slots in its one
 * sequence (`placement/slots.ts`). On a detached node (a block or atom being
 * created) the slots are appended in order; on an integrated one each write
 * goes after the item it names, read from the sequence as it stands.
 */
export const writeData = (node: EngineNode, writes: Iterable<DataWrite>): void => {
	let appended = 0;
	let read: ReturnType<typeof slotsOf> | null = null;
	/** Every displayed slot of item `id` of the array at `p` (two peers may have written one). */
	const entriesFor = (p: string, id: string): Entry[] => {
		read ??= slotsOf(node);
		return read.entries.get(`${p}\u0000${id}`) ?? [];
	};
	const entryOf = (p: string, id: string | null): Entry | null => {
		read ??= slotsOf(node);
		if (id === null) {
			const first = read.slots.get(p)?.[0];
			return first === undefined ? null : entriesFor(p, first)[0]!;
		}
		return entriesFor(p, id)[0] ?? null;
	};
	for (const w of writes) {
		if (Array.isArray(w)) {
			const [key, value] = w as LeafWrite;
			if (value === undefined) node.deleteAttr(key);
			else node.setAttr(key, value);
			continue;
		}
		const write = w as SlotWrite;
		const payloads = write.ids.map((i): DataSlot => ({ p: write.path, i }));
		if (node.doc == null) {
			// A new node: its items in order, none to move or remove yet.
			if (write.seq === 'insert') {
				node.insert(appended, payloads);
				appended += payloads.length;
			}
			continue;
		}
		const doc = asEngineDoc(node.doc as never);
		if (write.seq === 'remove') {
			for (const id of write.ids)
				for (const e of entriesFor(write.path, id)) removeUnit(doc, e.unit);
			read = null;
			continue;
		}
		// After the item named; at the array's start: before its first item.
		const left = write.after === null ? null : entryOf(write.path, write.after);
		const right = write.after === null ? entryOf(write.path, null) : null;
		if (write.seq === 'insert') placeAfter(doc, node, left, right, payloads);
		else {
			const units = write.ids.flatMap((id) => {
				const e = entryOf(write.path, id);
				return e === null ? [] : [e.unit];
			});
			placeAfter(doc, node, left, right, null, triples(units));
		}
		read = null;
	}
};
