/**
 * Properties: the deep proxy behind `block.data`, `atom.data` and
 * `edytor.data` (syncrostate's feel, one small module).
 *
 * A read goes to `read()` every time (the view's live, reactive source), so
 * a template that reads `block.data.title` re-renders when anyone changes
 * it. Plain objects read as nested proxies, arrays as array proxies,
 * everything else as the raw value; a proxy is cached per path, so its
 * identity is stable. An object or array held in an array item is that
 * item's (its path names the item by id, from `ids`): it stays on its item
 * wherever peers move it, so `{#each list as item (item)}` keeps a row, and
 * the focused field in it, on its item; once the item is removed, or its
 * array is, its writes are refused. A key is a path segment as
 * `keySegment` writes it (`~abc` as `~0abc`: never an item's id). A write
 * is one data patch through `write` (a
 * command): `obj.key = v`, `arr[i] = v` (by index) and `delete obj.key`
 * patch that path (a write inside an item, that item);
 * `push`, `pop`, `shift`, `unshift`, `splice` and `length` are one
 * `splice`, `sort` and `reverse` one `order` (the items move), `fill` and
 * `copyWithin` writes of the items they change.
 * `JSON.stringify` and `$state.snapshot` read plain JSON through it.
 */
import { keySegment, segmentKey, type DataPatch } from '../crdt/data.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
	v !== null && typeof v === 'object' && !Array.isArray(v);
/** A plain JSON copy (proxies included), or `undefined`. */
const plain = (v: unknown) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

type Op = Omit<DataPatch, 'path'> & { at?: string };
type Mutator = (n: number, args: unknown[], was: unknown[], out: unknown) => Op | Op[];
/** The items of `now` that differ from `was`, as writes of those items. */
const changed: Mutator = (_, __, was, now) =>
	(now as unknown[]).flatMap((value, i) =>
		JSON.stringify(value) === JSON.stringify(was[i]) ? [] : [{ at: `${i}`, value }]
	);
/**
 * Each array mutator as the patches of the array (or of its items `at`),
 * from its length `n`, the call's `args`, the array `was` and the result `out`.
 */
const MUTATORS: Record<string, Mutator> = {
	push: (n, args) => ({ splice: [n, 0, ...args] }),
	pop: (n) => ({ splice: [Math.max(n - 1, 0), n && 1] }),
	shift: () => ({ splice: [0, 1] }),
	unshift: (_, args) => ({ splice: [0, 0, ...args] }),
	// The start and count `splice` resolved (negative, fractional, past the end).
	splice: (n, [start, , ...items], _, out) => {
		const s = Math.trunc(Number(start)) || 0;
		return { splice: [s < 0 ? Math.max(n + s, 0) : Math.min(s, n), (out as []).length, ...items] };
	},
	sort: (n, [compare], was) => ({ order: sorted(n, was, compare) }),
	reverse: (n) => ({ order: Array.from({ length: n }, (_, i) => n - 1 - i) }),
	fill: changed,
	copyWithin: changed
};
/** The indexes `Array.prototype.sort` puts `values` in (stable, `undefined` compare: by string). */
const sorted = (n: number, values: unknown[], compare?: unknown) => {
	const by =
		typeof compare === 'function'
			? (compare as (a: unknown, b: unknown) => number)
			: (a: unknown, b: unknown) => (`${a}` < `${b}` ? -1 : `${a}` > `${b}` ? 1 : 0);
	return Array.from({ length: n }, (_, i) => i).sort((a, b) => by(values[a], values[b]));
};

export const propsProxy = <T extends object = Json>(
	read: () => Json,
	write: (ops: DataPatch[]) => void,
	/** The ids of the items of the array at a path (`facade.dataItemIds`). */
	ids: (path: readonly string[]) => string[] = () => []
): T => {
	const cache = new Map<string, object>();
	// Item ids per array path, for the value `read()` last gave.
	let seen: unknown;
	const known = new Map<string, string[]>();
	const idsOf = (path: readonly string[]): string[] => {
		const now = read();
		if (now !== seen) {
			seen = now;
			known.clear();
		}
		const key = JSON.stringify(path);
		return known.get(key) ?? known.set(key, ids(path)).get(key)!;
	};
	const at = (path: readonly string[]): unknown =>
		path.reduce<unknown>(
			(v, k, n) =>
				/^~[a-z]/.test(k)
					? Array.isArray(v)
						? v[idsOf(path.slice(0, n)).indexOf(k)]
						: undefined // its array is gone
					: v !== null && typeof v === 'object'
						? (v as Json)[segmentKey(k)]
						: undefined,
			read()
		);
	const put = (path: string[], value: unknown) =>
		write([{ path, ...(value !== undefined && { value: plain(value) }) }]);
	const wrap = (path: string[], v: unknown): unknown =>
		Array.isArray(v) || isObject(v) ? proxy(path, Array.isArray(v)) : v;

	const proxy = (path: string[], array: boolean): object => {
		const key = `${array ? '[' : '{'}${JSON.stringify(path)}`;
		const cached = cache.get(key);
		if (cached) return cached;
		const current = (): Json | unknown[] => {
			const v = at(path);
			return array ? (Array.isArray(v) ? v : []) : isObject(v) ? v : {};
		};
		/** The path of child `k`: an item by its id, a key as its segment. */
		const child = (k: string) => [...path, (array && idsOf(path)[Number(k)]) || keySegment(k)];
		const items = () => (current() as unknown[]).map((v, i) => wrap(child(`${i}`), v));
		const own = (k: string) => Object.prototype.hasOwnProperty.call(current(), k);
		const made = new Proxy(array ? [] : {}, {
			get(target, k) {
				if (typeof k === 'symbol')
					return array && k === Symbol.iterator
						? () => items()[Symbol.iterator]()
						: Reflect.get(target, k);
				if (array && k === 'length') return (current() as unknown[]).length;
				if (own(k)) return wrap(child(k), (current() as Json)[k]);
				if (array && Object.hasOwn(MUTATORS, k))
					return (...args: unknown[]) => {
						const was = plain(current()) as unknown[];
						const next = [...was];
						const fn = (Array.prototype as unknown as Json)[k] as (...a: unknown[]) => unknown;
						args = args.map((a) => (a !== null && typeof a === 'object' ? plain(a) : a));
						const out = fn.apply(next, args);
						const ops = [MUTATORS[k]!(was.length, args, was, out)].flat();
						write(ops.map(({ at, ...op }) => ({ ...op, path: at ? [...path, at] : path })));
						return out === next ? made : out;
					};
				const method = array ? (Array.prototype as unknown as Json)[k] : undefined;
				if (typeof method === 'function')
					return (...args: unknown[]) => method.apply(items(), args);
				return Reflect.get(target, k);
			},
			set(_, k, value) {
				if (typeof k === 'symbol') return false;
				if (array && k === 'length') {
					const n = (current() as unknown[]).length;
					const nulls = Array.from({ length: Math.max(value - n, 0) }, () => null);
					write([{ path, splice: [Math.min(value, n), Math.max(n - value, 0), ...nulls] }]);
				} else put([...path, keySegment(k)], value);
				return true;
			},
			deleteProperty(_, k) {
				if (typeof k === 'symbol') return false;
				if (own(k)) put([...path, keySegment(k)], undefined);
				return true;
			},
			has: (target, k) => (typeof k === 'string' && own(k)) || Reflect.has(target, k),
			ownKeys: () => [...Object.keys(current()), ...(array ? ['length'] : [])],
			getOwnPropertyDescriptor(target, k) {
				if (array && k === 'length')
					return (
						Reflect.getOwnPropertyDescriptor(target, k) && {
							value: (current() as unknown[]).length,
							writable: true,
							enumerable: false,
							configurable: false
						}
					);
				if (typeof k !== 'string' || !own(k)) return undefined;
				return {
					value: wrap(child(k), (current() as Json)[k]),
					writable: true,
					enumerable: true,
					configurable: true
				};
			}
		});
		cache.set(key, made);
		return made;
	};
	return proxy([], false) as T;
};
