/**
 * Block, atom and document data (properties) as fine-grained leaves.
 *
 * A node's data is a JSON object stored one attr per leaf: `d/` and the
 * leaf's path as an RFC 6901 pointer without its leading `/` (`~` → `~0`,
 * `/` → `~1`). A leaf is a primitive, `null` or an empty container (`{}`,
 * `[]`), so an emptied one persists. An array is its `[]` leaf plus its
 * items, as `Y.Array` holds them: item `id` keeps its value under the
 * segment `~id` (a primitive at it, an object's or array's leaves under it)
 * and its place in the rank `~id#` (`placement/rank.ts`), a move's in
 * `~id>`; `~` and a letter is no escape, so no key reads as an item. Each
 * attr is a map entry, so different keys and different items merge, one
 * key is last writer wins, and an item lives while its first rank does: a
 * delete removes its ranks and leaves, so a concurrent edit inside it or
 * move of it leaves orphans the read skips. A path names an item by index
 * or by id, so a held item is reached wherever peers moved it; an id that
 * names no live item (removed, or its array gone) refuses the patch, so
 * nothing is written under a dead item. A key starting with `~` is `~0…`
 * in a path (`keySegment`).
 *
 * Read rule: the leaves are read as a tree; a path with live items is an
 * array (sorted by rank, then id), one with keys an object (it beats a
 * primitive leaf at the same path: Ada sets `a = 1` while Bob sets
 * `a.b = 2`), else its leaf. The legacy whole `data` attr (documents
 * written before 0.1.0-next.6) is a base each leaf shadows at, above and
 * under its path; an array leaf with values (next.6's atomic arrays, and
 * every array of the attr) reads as items with ids and ranks derived from
 * the array (as any array assigned where no item is), so two replicas
 * exploding it write the same items. A patch
 * writes its leaves over the attr while it still reads right, else deletes
 * it and writes every leaf (residual: a peer's concurrent set of a key it
 * held, or its removal of an item, may then lose to the exploded value).
 */
import type { EngineNode } from './engine-api.js';
import { DATA, DATA_LEAF_PREFIX } from './schema.js';
import { rankAfter } from './placement/rank.js';
import { hash32 } from './rand.js';
import { jsonEquals } from '../utils/json.js';

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

export const isObject = (v: unknown): v is JsonObj =>
	v !== null && typeof v === 'object' && !Array.isArray(v);

/** A path of the data as a tree: its leaf (`v`) and its segments' subtrees. */
type Tree = { v?: unknown; k: Map<string, Tree> };
type Item = { id: string; rank: string };
type Entry = { id?: string; keep?: boolean; value?: unknown };

const tree = (v?: unknown): Tree => ({ v, k: new Map() });
const kid = (t: Tree, s: string): Tree => t.k.get(s) ?? t.k.set(s, tree()).get(s)!;
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
/** A rank's characters (`placement/rank.ts`, P7: variable-length digits, `!` before a tie). */
const RANK = /^[-\w?!]+$/;
const index = (k: string) => (/^(0|[1-9]\d*)$/.test(k) ? Number(k) : -1);
const rank = (v: unknown) => (typeof v === 'string' && RANK.test(v) ? v : undefined);
/** Item `id`'s place: where a move put it (`id>`), else where it was made (`id#`). */
const placeOf = (t: Tree, id: string) => rank(t.k.get(`${id}>`)?.v) ?? rank(t.k.get(`${id}#`)?.v);
/** `t`'s live items (made, `id#`, and not removed: a move never revives one), in order. */
const itemsOf = (t: Tree): Item[] => {
	const out: Item[] = [];
	for (const [s, c] of t.k)
		if (s.endsWith('#') && itemish(s) && rank(c.v))
			out.push({ id: s.slice(0, -1), rank: placeOf(t, s.slice(0, -1))! });
	// ` ` sorts below every rank character: a rank before its extensions, then by id.
	return out.sort((a, b) => (`${a.rank} ${a.id}` < `${b.rank} ${b.id}` ? -1 : 1));
};
const isArr = (t: Tree) => Array.isArray(t.v) || itemsOf(t).length > 0;
/** The item `seg` names among `items`: by its id (`~…`) or by its index. */
const itemAt = (items: Item[], seg: string): Item | undefined =>
	itemish(seg) ? items.find((i) => i.id === seg) : items[index(seg)];

/** The JSON `t` reads as (`undefined` for nothing). */
const valueOf = (t: Tree): unknown => {
	const items = itemsOf(t);
	if (items.length) return items.map(({ id }) => valueOf(t.k.get(id) ?? tree()) ?? null);
	const keys = [...t.k]
		.map(([s, c]) => [dec(s), itemish(s) ? undefined : valueOf(c)] as const)
		.filter(([, v]) => v !== undefined);
	// Own properties only: a `__proto__` key (a peer's too) is data, never a prototype.
	return keys.length ? Object.fromEntries(keys) : t.v;
};

const treeOf = (leaves: Map<string, unknown>): Tree => {
	const root = tree();
	for (const [key, v] of [...leaves].sort(([a], [b]) => (a < b ? -1 : 1)))
		key.slice(DATA_LEAF_PREFIX.length).split('/').reduce(kid, root).v = v;
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
 * `common` pairs nothing between the prefix and the suffix (R8).
 */
const PAIRS_BOUND = 1 << 18;
/**
 * A common subsequence of `a` and `b`, as index pairs, in time and memory
 * linear in their lengths (R8, WU-17): the common prefix and suffix, then
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
const added = (values: unknown[]): Entry[] => values.map((value) => ({ value }));

/**
 * The tree edits. New items take ids and ranks from `rand` and `client`;
 * without `rand` they are derived from their indexes and `client` (a new
 * array's hash), so equal values write equal items everywhere.
 */
const edits = (rand?: () => number, client = 0) => {
	const pick = rand ?? (() => 0);
	const fresh = (t: Tree, i: number): string => {
		for (;;) {
			const id = rand
				? `~${Math.floor(36 ** 7 * (10 + 26 * rand())).toString(36)}`
				: `~l${i++}.${client.toString(36)}`;
			if (![id, `${id}#`, `${id}>`].some((s) => t.k.has(s))) return id;
		}
	};
	const remove = (t: Tree, id: string) => [id, `${id}#`, `${id}>`].forEach((s) => t.k.delete(s));
	/**
	 * A rank in `(left, right)`. After an item this client placed, it is in
	 * the client's run there (`rankAfter`): what it inserts after its own
	 * items stays together, as `Y.Array` keeps an insert after its origin,
	 * whatever a peer inserts in that gap meanwhile. Elsewhere a plain rank.
	 */
	const between = (left: string | undefined, right: string | undefined): string =>
		rankAfter(left, right, client, pick);
	/** Give `entries` (kept items, moved items, new values) their places in `t`, in order. */
	const lay = (t: Tree, entries: Entry[]): void => {
		let left: string | undefined;
		let right: string | undefined;
		let r = -1; // the next kept entry, whose place bounds the run before it
		for (let p = 0; p < entries.length; p++) {
			const e = entries[p]!;
			if (e.keep) {
				left = placeOf(t, e.id!);
				continue;
			}
			if (r < p) {
				for (r = p + 1; r < entries.length && !entries[r]!.keep; r++);
				right = r < entries.length ? placeOf(t, entries[r]!.id!) : undefined;
			}
			const id = e.id ?? fresh(t, p);
			left = kid(t, `${id}${e.id ? '>' : '#'}`).v = between(
				left,
				left !== undefined && right !== undefined && left >= right ? undefined : right
			);
			if (e.id === undefined) assign(kid(t, id), e.value);
		}
	};
	/** Make `t` read as `value`, writing only what differs: objects key by key, arrays item by item. */
	const assign = (t: Tree, value: unknown): void => {
		if (Array.isArray(value) && itemsOf(t).length) return arrange(t, value);
		// Anything else replaces what `t` held, but an object's equal keys.
		const object = isObject(value) && Object.keys(value).length > 0;
		for (const s of [...t.k.keys()])
			if (!object || itemish(s) || !Object.hasOwn(value, dec(s))) t.k.delete(s);
		t.v = object ? undefined : Array.isArray(value) ? [] : value;
		if (object) for (const [k, v] of Object.entries(value)) assign(kid(t, enc(k)), v);
		// A new array's items derive from it: two peers making the same one make one.
		if (Array.isArray(value)) edits(undefined, hash32(canon(value))).lay(t, added(value));
	};
	/**
	 * An array reassigned: the items a longest common run keeps equal stay;
	 * between two of them, old and new items pair by position (each keeps
	 * its id and takes the new value), the rest are removed or inserted.
	 */
	const arrange = (t: Tree, next: unknown[]): void => {
		const old = itemsOf(t);
		const was = old.map(({ id }) => canon(valueOf(t.k.get(id) ?? tree()) ?? null));
		const entries: Entry[] = [];
		let [i, j] = [0, 0];
		for (const [mi, mj] of [...common(was, next.map(canon)), [old.length, next.length]]) {
			for (let n = 0; n < Math.max(mi - i, mj - j); n++) {
				const o = i + n < mi ? old[i + n]! : undefined;
				if (j + n >= mj) remove(t, o!.id);
				else if (!o) entries.push({ value: next[j + n] });
				else {
					entries.push({ id: o.id, keep: true });
					assign(kid(t, o.id), next[j + n]);
				}
			}
			if (mi < old.length) entries.push({ id: old[mi]!.id, keep: true });
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
			if (isArr(t)) {
				const item = itemAt(itemsOf(t), k);
				t = item && kid(t, item.id);
			} else if (itemish(k)) return undefined;
			else {
				t.v = undefined; // a value on the way becomes an object
				t = kid(t, enc(segmentKey(k)));
			}
		}
		return t;
	};
	/** Apply `patch` to `root`; `false` when it fits no value there. */
	const apply = (root: Tree, { path, value, splice, order }: DataPatch): boolean => {
		const at = reach(root, splice || order ? path : path.slice(0, -1));
		if (!at) return false;
		const items = isArr(at) ? itemsOf(at) : undefined;
		const list: Entry[] = items?.map(({ id }) => ({ id, keep: true })) ?? [];
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
			// The last key of an object deleted keeps the object.
			else if (at.k.delete(enc(segmentKey(k))) && at !== root && valueOf(at) === undefined)
				at.v = {};
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
/** The leaves of `value` under `prefix`; its arrays' items derived from them. */
const leavesOfValue = (value: unknown, prefix = DATA_LEAF_PREFIX) => {
	const t = tree();
	derived.assign(t, value);
	return leavesFrom(t, prefix);
};
/** A new node's data, as leaves. */
export const dataLeaves = (data: unknown): Map<string, unknown> =>
	leavesOfValue(isObject(data) ? data : {});
/**
 * `leaves` over the bases they shadow (each leaf at, above and under its
 * path): the legacy attr, and each array leaf with values (as items).
 */
const effective = (base: unknown, leaves: Map<string, unknown>): Map<string, unknown> => {
	/** `key` and the paths above it longer than `floor`. */
	const above = (key: string, floor = 0) => {
		const out: string[] = [];
		for (let i = key.length; i > floor; i = key.lastIndexOf('/', i - 1)) out.push(key.slice(0, i));
		return out;
	};
	const near = new Set([...leaves.keys()].flatMap((key) => above(key)));
	const out = new Map<string, unknown>();
	const under = (prefix: string, value: unknown) => {
		for (const [key, v] of leavesOfValue(value, prefix))
			if (!near.has(key) && !above(key, prefix.length - 1).some((p) => leaves.has(p)))
				out.set(key, v);
	};
	if (isObject(base)) under(DATA_LEAF_PREFIX, base);
	for (const [key, v] of leaves) {
		out.set(key, v);
		if (Array.isArray(v) && v.length) {
			under(`${key}/`, v);
			out.set(key, []);
		} else if (isObject(v) && Object.keys(v).length) {
			// An object written as one leaf (an atomic path, `data.atomic`) reads as its keys.
			under(`${key}/`, v);
			out.set(key, {});
		}
	}
	return out;
};

/** A path of the data as a leaf key (`d/` and its pointer). */
export const leafKey = (path: readonly string[]): string =>
	DATA_LEAF_PREFIX + path.map((k) => enc(k)).join('/');

/**
 * `leaves` with every atomic path (`data.atomic`, H8: a leaf key a kind
 * declares) holding one leaf: the value of everything at and under it.
 */
const collapse = (leaves: Map<string, unknown>, atomic: readonly string[]) => {
	if (atomic.length === 0) return leaves;
	const root = treeOf(leaves);
	for (const key of atomic) {
		let t: Tree | undefined = root;
		for (const s of key.slice(DATA_LEAF_PREFIX.length).split('/')) t = t?.k.get(s);
		if (t === undefined || t.k.size === 0) continue;
		t.v = valueOf(t);
		t.k.clear();
	}
	return leavesFrom(root);
};
const read = (base: unknown, leaves: Map<string, unknown>) =>
	valueOf(treeOf(effective(base, leaves))) as JsonObj | undefined;

/** `node`'s data (`undefined` when it has none). */
export const readData = (node: EngineNode): JsonObj | undefined =>
	read(node.getAttr(DATA), leavesOf(node));

/**
 * The ids of the items of the array at `path` (keys, item indexes or ids)
 * in `node`'s data, in order; `[]` where no array is.
 */
export const itemIds = (node: EngineNode, path: readonly string[]): string[] => {
	let t: Tree | undefined = treeOf(effective(node.getAttr(DATA), leavesOf(node)));
	for (const k of path)
		if (t && isArr(t)) {
			const item: Item | undefined = itemAt(itemsOf(t), k);
			t = item && t.k.get(item.id);
		} else t = itemish(k) ? undefined : t?.k.get(enc(segmentKey(k)));
	return t ? itemsOf(t).map(({ id }) => id) : [];
};

/** `data` with `patches` applied in order, as a fresh value (a root patch replaces it); `null` when one fits no value. */
export const applyPatch = (data: JsonObj, patches: readonly DataPatch[]): JsonObj | null => {
	const root = treeOf(dataLeaves(data));
	if (!patches.every((p) => derived.apply(root, p))) return null;
	return (valueOf(root) as JsonObj | undefined) ?? {};
};

/**
 * The attr writes that give `node` the data `patches` make of its own (new
 * items get ids from `rand`, ranks from `client`), or `null` when a patch
 * fits no value there: only the leaves of the keys and items a patch
 * touches change, so a concurrent edit of another key or item is kept. A
 * legacy base (the attr, an atomic array leaf) stays under the leaves while
 * they still read as the patched value, else it is exploded: every leaf
 * written, the attr deleted. An unchanged value writes nothing.
 */
export const patchWrites = (
	node: EngineNode,
	patches: readonly DataPatch[],
	client = 0,
	rand?: () => number,
	atomic: readonly string[] = []
): LeafWrite[] | null => {
	const [base, now] = [node.getAttr(DATA), leavesOf(node)];
	const was = effective(base, now);
	const root = treeOf(was);
	const before = valueOf(root);
	const { apply } = edits(rand, client);
	if (!patches.every((p) => apply(root, p))) return null;
	const value = valueOf(root);
	if (jsonEquals(before, value)) return [];
	// An atomic path is written as one leaf, and every leaf stored under it goes (H8).
	const want = collapse(leavesFrom(root), atomic);
	const under = (key: string) => atomic.some((a) => key.startsWith(`${a}/`));
	const diff = (from: Map<string, unknown>): LeafWrite[] =>
		[...new Set([...from.keys(), ...want.keys()])]
			.filter((key) => !jsonEquals(from.get(key), want.get(key)))
			.map((key) => [key, want.get(key)] as const);
	const own = [
		...diff(collapse(was, atomic)),
		...[...now.keys()]
			.filter((key) => under(key) && !want.has(key))
			.map((key) => [key, undefined] as const)
	];
	const after = new Map(now);
	for (const [key, value] of own) value === undefined ? after.delete(key) : after.set(key, value);
	if (jsonEquals(read(base, after), value)) return own;
	return [...(base === undefined ? [] : [[DATA, undefined] as const]), ...diff(now)];
};

/** Write `writes` on `node` (a detached one too: a block or atom being created). */
export const writeLeaves = (node: EngineNode, writes: Iterable<LeafWrite>): void => {
	for (const [key, value] of writes)
		if (value === undefined) node.deleteAttr(key);
		else node.setAttr(key, value);
};
