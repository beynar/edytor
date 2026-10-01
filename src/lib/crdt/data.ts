/**
 * Block, atom and document data (properties) as fine-grained leaves.
 *
 * A node's data is a JSON object stored one attr per leaf: `d/` and the
 * leaf's path as an RFC 6901 pointer without its leading `/` (`~` → `~0`,
 * `/` → `~1`). A leaf is a primitive, `null`, an array or an empty object
 * (`{}`, so an emptied object persists). Each attr is a map entry, so two
 * writers editing different keys both keep theirs, and one key is last
 * writer wins.
 *
 * ponytail: arrays are atomic (one leaf, whole-value last writer wins); an
 * array whose items merge would be a sequence type under the leaf, as
 * syncrostate's `SyncedArray` does, read and patched by index here.
 *
 * Read rule: the legacy whole `data` attr (documents written before
 * 0.1.0-next.6) is the base; the leaves apply over it, parents before
 * deeper paths. A primitive leaf and leaves under the same path (Ada sets
 * `a = 1` while Bob sets `a.b = 2`) read as the object on every replica.
 * A set writes its leaf over the legacy attr; the first patch the attr
 * would show through explodes it into leaves and deletes it, in the same
 * write (residual: a peer's concurrent set of a key it held may then lose
 * to the exploded old value).
 */
import type { EngineNode } from './engine-api.js';
import { DATA, DATA_LEAF_PREFIX } from './schema.js';
import { cloneJsonSafe, jsonEquals } from '../utils/json.js';

type JsonObj = Record<string, unknown>;

/** One data edit: the value at `path` (object keys from the data's root); no `value` deletes it. */
export type DataPatch = { readonly path: readonly string[]; readonly value?: unknown };

/** An attr write a patch plans: the key and its value, `undefined` to delete it. */
export type LeafWrite = readonly [key: string, value: unknown];

export const isObject = (v: unknown): v is JsonObj =>
	v !== null && typeof v === 'object' && !Array.isArray(v);

const leafKey = (path: readonly string[]): string =>
	DATA_LEAF_PREFIX + path.map((k) => k.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
const pathOf = (key: string): string[] =>
	key
		.slice(DATA_LEAF_PREFIX.length)
		.split('/')
		.map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));

const leavesOf = (node: EngineNode): Map<string, unknown> => {
	const out = new Map<string, unknown>();
	for (const key of node.attrKeys())
		if (key.startsWith(DATA_LEAF_PREFIX)) out.set(key, node.getAttr(key));
	return out;
};

/** `value`'s leaves under `path` (the root is never a leaf). */
const flatten = (path: string[], value: unknown, out = new Map<string, unknown>()) => {
	if (isObject(value) && (path.length === 0 || Object.keys(value).length > 0))
		for (const [k, v] of Object.entries(value)) flatten([...path, k], v, out);
	else if (value !== undefined) out.set(leafKey(path), value);
	return out;
};

/** Put `v` at `path` in `root` (objects made along it; `undefined` deletes); `merge`: a `{}` keeps an object there. */
const put = (root: JsonObj, path: readonly string[], v: unknown, merge = false): void => {
	// Own properties only: a `__proto__` or `constructor` key (a peer's too) is data, never a prototype.
	const own = (o: JsonObj, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
	const set = (o: JsonObj, k: string, value: unknown) =>
		Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true });
	let o = root;
	for (const k of path.slice(0, -1)) {
		let next = own(o, k);
		if (!isObject(next)) set(o, k, (next = {}));
		o = next as JsonObj;
	}
	const last = path[path.length - 1]!;
	if (v === undefined) delete o[last];
	else set(o, last, merge && isObject(v) ? (isObject(own(o, last)) ? own(o, last) : {}) : v);
};

/** The data a legacy attr and leaves read as: the attr, then the leaves, parents first (the object wins). */
const assemble = (base: unknown, leaves: Map<string, unknown>): JsonObj | undefined => {
	if (leaves.size === 0) return base == null ? undefined : (base as JsonObj);
	const out = isObject(base) ? cloneJsonSafe(base) : {};
	// By key: a parent's key prefixes its descendants' (parents first), and
	// every replica builds the same key order.
	for (const key of [...leaves.keys()].sort()) put(out, pathOf(key), leaves.get(key), true);
	return out;
};

/** `node`'s data (`undefined` when it has none). */
export const readData = (node: EngineNode): JsonObj | undefined =>
	assemble(node.getAttr(DATA), leavesOf(node));

/** `data` with `patches` applied in order, as a fresh value (a root patch replaces it). */
export const applyPatch = (data: JsonObj, patches: readonly DataPatch[]): JsonObj => {
	let out = cloneJsonSafe(data);
	for (const { path, value } of patches) {
		if (path.length === 0) out = isObject(value) ? cloneJsonSafe(value) : {};
		else put(out, path, cloneJsonSafe(value));
	}
	return out;
};

/**
 * The attr writes that give `node` the data `patches` make of its own: only
 * the leaves at, under or above a patched path change, so a concurrent edit
 * of another key is kept. A legacy attr stays under the leaves while they
 * still read as the patched value (a set), so two peers' first sets of
 * different keys never write each other's old values; a patch it would show
 * through (a delete, an object over its object, a whole replace) explodes it:
 * every leaf written, the attr deleted. An unchanged value writes nothing.
 */
export const patchWrites = (node: EngineNode, patches: readonly DataPatch[]): LeafWrite[] => {
	const current = readData(node) ?? {};
	const next = applyPatch(current, patches);
	if (jsonEquals(current, next)) return [];
	const [base, now, want] = [node.getAttr(DATA), leavesOf(node), flatten([], next)];
	const writes = (all: boolean): LeafWrite[] => {
		const touched = (key: string) =>
			all ||
			patches.some(({ path }) => {
				const k = leafKey(path);
				return path.length === 0 || key === k || key.startsWith(k + '/') || k.startsWith(key + '/');
			});
		return [...new Set([...now.keys(), ...want.keys()])]
			.filter((key) => touched(key) && !jsonEquals(now.get(key), want.get(key)))
			.map((key) => [key, want.get(key)] as const);
	};
	const own = writes(false);
	if (base === undefined) return own;
	const after = new Map(now);
	for (const [key, value] of own) value === undefined ? after.delete(key) : after.set(key, value);
	return jsonEquals(assemble(base, after), next) ? own : [[DATA, undefined], ...writes(true)];
};

/** Write `writes` on `node` (a detached one too: a block or atom being created). */
export const writeLeaves = (node: EngineNode, writes: Iterable<LeafWrite>): void => {
	for (const [key, value] of writes)
		if (value === undefined) node.deleteAttr(key);
		else node.setAttr(key, value);
};

/** A new node's data, as leaves. */
export const dataLeaves = (data: unknown): Map<string, unknown> =>
	flatten([], isObject(data) ? data : {});
