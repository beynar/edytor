/**
 * Properties: the deep proxy behind `block.data`, `atom.data` and
 * `edytor.data` (syncrostate's feel, one small module).
 *
 * A read goes to `read()` every time (the view's live, reactive source), so
 * a template that reads `block.data.title` re-renders when anyone changes
 * it. Plain objects read as nested proxies, arrays as array proxies,
 * everything else as the raw value; a proxy is cached per path, so its
 * identity is stable. A write is one data patch through `write` (a command):
 * `obj.key = v` and `delete obj.key` patch that key; an array is one value,
 * so an array mutator (`push`, `splice`, `sort`, …), an index or `length`
 * write, or a write inside an item patches the whole array once.
 * `JSON.stringify` and `$state.snapshot` read plain JSON through it.
 */
import type { DataPatch } from '../crdt/data.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
	v !== null && typeof v === 'object' && !Array.isArray(v);
/** A plain JSON copy (proxies included), or `undefined`. */
const plain = (v: unknown) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

const MUTATORS = new Set([
	'push',
	'pop',
	'shift',
	'unshift',
	'splice',
	'sort',
	'reverse',
	'fill',
	'copyWithin'
]);

export const propsProxy = <T extends object = Json>(
	read: () => Json,
	write: (ops: DataPatch[]) => void
): T => {
	const cache = new Map<string, object>();
	const at = (path: readonly string[]): unknown =>
		path.reduce<unknown>(
			(v, k) => (v !== null && typeof v === 'object' ? (v as Json)[k] : undefined),
			read()
		);
	/** Write `value` at `path`: inside an array, the whole array with it. */
	const put = (path: string[], value: unknown) => {
		const i = path.findIndex(
			(_, j) => j < path.length - 1 && Array.isArray(at(path.slice(0, j + 1)))
		);
		if (i < 0) return write([{ path, ...(value !== undefined && { value: plain(value) }) }]);
		const [root, rest] = [path.slice(0, i + 1), path.slice(i + 1)];
		const whole = plain(at(root));
		let o = whole;
		for (const k of rest.slice(0, -1))
			o = o[k] !== null && typeof o[k] === 'object' ? o[k] : (o[k] = {});
		if (value === undefined) delete o[rest[rest.length - 1]!];
		else o[rest[rest.length - 1]!] = plain(value);
		write([{ path: root, value: whole }]);
	};
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
		const items = () => (current() as unknown[]).map((v, i) => wrap([...path, `${i}`], v));
		const own = (k: string) => Object.prototype.hasOwnProperty.call(current(), k);
		const made = new Proxy(array ? [] : {}, {
			get(target, k) {
				if (typeof k === 'symbol')
					return array && k === Symbol.iterator
						? () => items()[Symbol.iterator]()
						: Reflect.get(target, k);
				if (array && k === 'length') return (current() as unknown[]).length;
				if (own(k)) return wrap([...path, k], (current() as Json)[k]);
				if (array && MUTATORS.has(k))
					return (...args: unknown[]) => {
						const next = plain(current()) as unknown[];
						const fn = (Array.prototype as unknown as Json)[k] as (...a: unknown[]) => unknown;
						const out = fn.apply(
							next,
							args.map((a) => (typeof a === 'function' ? a : plain(a)))
						);
						put(path, next);
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
					const next = plain(current()) as unknown[];
					next.length = value;
					put(path, next);
				} else put([...path, k], value);
				return true;
			},
			deleteProperty(_, k) {
				if (typeof k === 'symbol') return false;
				if (own(k)) put([...path, k], undefined);
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
					value: wrap([...path, k], (current() as Json)[k]),
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
