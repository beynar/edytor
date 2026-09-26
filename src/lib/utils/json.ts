/**
 * Canonical serialisation types for the editor document model.
 *
 * This module is engine-agnostic: it only describes the JSON surface shared by
 * the model wrappers, the CRDT facade and consumers. No `yjs` import exists
 * anywhere under `src/lib` outside the vendored v14 engine — editor commands
 * speak the typed node surface (`DocBlock` in `src/lib/crdt/nodes.ts`).
 *
 * ## Boundary contract (gate-3 F4)
 *
 * `JSONBlock.data`, `JSONText.marks`, `JSONInlineBlock.data`, format payloads
 * and every other value crossing the replicated boundary are **JSON-typed
 * only**: plain objects, arrays, strings, finite numbers, booleans and `null`.
 * Non-JSON values cannot cross the wire — peers and persistence only ever see
 * the serialized form — so `cloneJson` coerces or drops them (`Date` → string,
 * `Map` → `{}`, `undefined`/function keys dropped, `NaN`/`Infinity` → `null`,
 * circular/`bigint` → throws). Read/publication paths that must survive
 * hostile values already inside replicated state use {@link cloneJsonSafe},
 * the never-throwing projection.
 *
 * The coercion is never *silent*: in dev builds `cloneJson` walks the value
 * and reports every offending path via `console.warn`. Store plain JSON —
 * serialize richer values (dates, typed maps) yourself at the plugin edge.
 *
 * ## Wire-normalization contract (gate-F2 F2-M1)
 *
 * The update encoder writes every replicated string through UTF-8 encoding,
 * which maps each UNPAIRED UTF-16 surrogate to U+FFFD (`EF BF BD`). A string
 * stored verbatim locally therefore decodes DIFFERENTLY on every receiving
 * replica — permanent same-item divergence (upstream-inherited; the vendored
 * engine is deliberately unpatched). The CRDT facade closes the hole at the
 * boundary instead: every caller-supplied CONTENT and PAYLOAD string is
 * normalized to well-formed UTF-16 by {@link sanitizeWireString}/
 * {@link sanitizeWireJson} BEFORE entering replicated state, so the local
 * store always holds exactly what the wire would deliver. Valid surrogate
 * pairs pass through untouched — normalization never merges or rewrites
 * well-formed input.
 *
 * ## Spec preparation (U2)
 *
 * {@link jsonContentToItems} / {@link jsonBlockToSpec} are the canonical
 * JSON → facade `ContentItem`/`BlockSpec` converters — the admission shape
 * `facade.insertBlock`/`DocBlock.set` consume (see `placement/model.ts`
 * `insertOne`/`appendItems`). Content preparation builds specs DIRECTLY
 * from JSON — never through disposable live-wrapper trees. The spec types
 * are imported type-only, so this module keeps its zero-runtime-dependency
 * contract (`placement/model.ts` already runtime-imports this module — the
 * type edge runs the other way and is erased at compile time).
 */
import { DEV } from 'esm-env';
import { id } from '../utils.js';
import type { BlockSpec, ContentItem } from '../crdt/placement/model.js';

export type Mark = [string, Record<string, unknown> | boolean | string];

export type SerializableContent =
	| {
			[key: string]: SerializableContent;
	  }
	| string
	| boolean
	| number
	| null;

export type JSONText = {
	text: string;
	marks?: Record<string, SerializableContent>;
};

export type JSONInlineBlock = {
	id?: string;
	data?: any;
	type: string;
};

export type JSONBlock = {
	type: string;
	id?: string;
	data?: Record<string, SerializableContent>;
	children?: JSONBlock[];
	content?: (JSONText | JSONInlineBlock)[];
};

export type PartialJSONBlock = Omit<JSONBlock, 'children' | 'content'>;

export type JSONDoc = {
	children: JSONBlock[];
} & Partial<Record<string, unknown>>;

export type Delta = {
	insert?: string;
	retain?: number;
	delete?: number;
	attributes?: SerializableContent;
};

const MAX_JSON_BOUNDARY_VIOLATIONS = 25;
const MAX_JSON_BOUNDARY_REPORTS = 200;

const JSON_COERCION: Record<string, string> = {
	Date: 'coerces to an ISO string',
	RegExp: 'coerces to {}',
	Map: 'coerces to {}',
	Set: 'coerces to {}',
	WeakMap: 'coerces to {}',
	WeakSet: 'coerces to {}',
	Promise: 'coerces to {}',
	ArrayBuffer: 'coerces to {}'
};

/**
 * Dev-only: collect one line per value that will not survive a JSON
 * round-trip. Capped so a hostile payload cannot flood the report.
 */
const collectJsonBoundaryViolations = (
	value: unknown,
	path: string,
	violations: string[],
	seen: Set<unknown>
): void => {
	if (violations.length >= MAX_JSON_BOUNDARY_VIOLATIONS || value === null) {
		return;
	}

	const type = typeof value;
	if (type === 'string' || type === 'boolean') {
		return;
	}
	if (type === 'number') {
		if (!Number.isFinite(value as number)) {
			violations.push(`${path}: non-finite number coerces to null`);
		}
		return;
	}
	if (type === 'undefined') {
		violations.push(`${path}: undefined key is dropped (array slot → null)`);
		return;
	}
	if (type === 'function' || type === 'symbol' || type === 'bigint') {
		violations.push(`${path}: ${type} is not serializable`);
		return;
	}

	if (seen.has(value)) {
		violations.push(`${path}: circular reference throws at serialize time`);
		return;
	}

	if (Array.isArray(value)) {
		seen.add(value);
		value.forEach((item, index) =>
			collectJsonBoundaryViolations(item, `${path}[${index}]`, violations, seen)
		);
		seen.delete(value);
		return;
	}

	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		const name = (value as object).constructor?.name ?? 'non-plain object';
		violations.push(`${path}: ${name} is not JSON — ${JSON_COERCION[name] ?? 'coerces to {}'}`);
		return;
	}

	seen.add(value);
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		collectJsonBoundaryViolations(item, `${path}.${key}`, violations, seen);
	}
	seen.delete(value);
};

const reportedJsonBoundaryViolations = new Set<string>();

/** Dev-only violation report shared by {@link cloneJson} and {@link cloneJsonSafe}. */
const warnJsonBoundary = (fn: string, value: unknown): void => {
	const violations: string[] = [];
	collectJsonBoundaryViolations(value, '$', violations, new Set());
	if (violations.length === 0) return;
	const report = violations.join('\n  ');
	if (reportedJsonBoundaryViolations.has(report)) return;
	if (reportedJsonBoundaryViolations.size >= MAX_JSON_BOUNDARY_REPORTS) {
		reportedJsonBoundaryViolations.clear();
	}
	reportedJsonBoundaryViolations.add(report);
	console.warn(
		`[edytor] ${fn}: non-JSON values at the replicated boundary are coerced or dropped:\n  ${report}`
	);
};

/**
 * Deep-clone a value through the JSON boundary (`JSON.parse(JSON.stringify)`).
 * Every call site is a point where replicated state is crossed — see the
 * module docstring for the JSON-only contract. Dev builds warn once per
 * unique violation report so non-JSON values never coerce silently.
 */
export const cloneJson = <T>(value: T): T => {
	if (DEV) warnJsonBoundary('cloneJson', value);
	return JSON.parse(JSON.stringify(value)) as T;
};

/**
 * Total JSON projection — the read-side counterpart of {@link cloneJson}
 * (gate-H R4). `cloneJson` deliberately still throws on `bigint` and
 * circular input so WRITE boundaries refuse loudly before mutating;
 * `cloneJsonSafe` NEVER throws — it is for read/intern/publication paths
 * that must stay live even when replicated state holds a hostile value
 * that bypassed boundary validation (a raw `setAttr` write, or a remote
 * payload delivered straight into the shared store).
 *
 * The projection follows `JSON.stringify` parity wherever stringify is
 * defined, extended minimally where it would throw:
 *
 * - `bigint` → the exact `number` when it is a safe integer, otherwise its
 *   decimal string (no silent precision loss);
 * - circular references → the re-entered key is dropped (an array slot
 *   becomes `null`), matching how unserializable properties are dropped;
 * - non-plain objects keep `stringify` semantics: `toJSON()` is honored,
 *   otherwise own enumerable properties serialize (Map/Set → `{}`);
 * - `undefined`/functions/symbols drop exactly like `stringify` (object
 *   key dropped, array slot → `null`, root → `undefined`);
 * - non-finite numbers → `null`; a throwing `toJSON`, getter or proxy →
 *   the object projects as `{}` (array → `[]`).
 *
 * Every replica projects the same stored value to the same result, so
 * reads stay convergent even though the stored payload itself was hostile.
 */
export const cloneJsonSafe = <T>(value: T): T => {
	if (DEV) warnJsonBoundary('cloneJsonSafe', value);
	const DROP: unique symbol = Symbol('json-boundary-drop');
	const norm = (v: unknown, seen: Set<unknown>): unknown => {
		const t = typeof v;
		if (t === 'string' || t === 'boolean' || v === null) return v;
		if (t === 'number') return Number.isFinite(v as number) ? v : null;
		if (t === 'bigint') {
			const n = Number(v);
			return Number.isSafeInteger(n) ? n : (v as bigint).toString();
		}
		// undefined / function / symbol — dropped like `JSON.stringify`.
		if (t !== 'object') return DROP;
		if (seen.has(v)) return DROP;
		seen.add(v);
		try {
			// `stringify` honors `toJSON` on any object before walking props.
			const toJSON = (v as { toJSON?: unknown }).toJSON;
			if (typeof toJSON === 'function') {
				const w = (toJSON as (key: string) => unknown).call(v, '');
				if (w !== v) return norm(w, seen);
			}
			if (Array.isArray(v)) {
				const out: unknown[] = new Array(v.length);
				for (let i = 0; i < v.length; i++) {
					const n = norm(v[i], seen);
					out[i] = n === DROP ? null : n;
				}
				return out;
			}
			const out: Record<string, unknown> = {};
			for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
				const n = norm(item, seen);
				if (n !== DROP) out[k] = n;
			}
			return out;
		} catch {
			// Hostile object — throwing getter/toJSON/revoked proxy. The
			// value cannot serialize; project it as the empty container.
			return Array.isArray(v) ? [] : {};
		} finally {
			seen.delete(v);
		}
	};
	const out = norm(value, new Set());
	return (out === DROP ? undefined : out) as T;
};

/**
 * Normalize a string to well-formed UTF-16 — each unpaired surrogate becomes
 * U+FFFD, identical to the USVString conversion the wire's UTF-8 encoder
 * applies on delivery (gate-F2 F2-M1). Applied to every caller-supplied
 * string that enters replicated state (text content, caller-assigned ids,
 * type names) so the local store holds what the wire would carry. Interior
 * valid surrogate pairs pass through unchanged (`toWellFormed` is the exact
 * inverse of the lossy encode). Idempotent — safe on already-clean input.
 */
export const sanitizeWireString = (s: string): string => s.toWellFormed();

/**
 * {@link cloneJson} + {@link sanitizeWireString} on every string in the
 * payload — values AND object keys (a `data`/`marks` key is itself a
 * replicated wire string). This is the JSON-payload half of the F2-M1
 * boundary contract: two differently-encoded raw keys that normalize to the
 * same key collide last-write-wins — the same outcome the decoder produces
 * when both encode to the identical wire string.
 */
export const sanitizeWireJson = <T>(value: T): T => {
	const walk = (v: unknown): unknown => {
		if (typeof v === 'string') return sanitizeWireString(v);
		if (Array.isArray(v)) return v.map(walk);
		if (v !== null && typeof v === 'object') {
			const out: Record<string, unknown> = {};
			for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
				out[sanitizeWireString(k)] = walk(item);
			}
			return out;
		}
		return v;
	};
	return walk(cloneJson(value)) as T;
};

// ── spec preparation (JSON → facade admission shapes) ──────────────────
//
// The converters below are the ONLY live path from caller JSON to the
// document's `ContentItem`/`BlockSpec` admission surface. They mint the
// runtime `id('b'|'i')` scheme where ids are missing and preserve caller
// ids otherwise (`freshIds` forces fresh identity — paste/duplicate
// semantics). Payloads (`data`, `marks`) cross the boundary through
// {@link cloneJson}; wire-string normalization itself is applied later by
// the facade's `sanitizeSpec`, so these stay faithful to caller input.
//
// Normalization is deliberately NOT done here: the document's projection
// derives the content invariant (text-first/text-last, no adjacent
// text/inline parts — `deriveContentParts` over `contentItemsOf`), so raw
// JSON items are stored verbatim and read back normalized. The view's
// `groupContent` exists only for DETACHED spec mirrors (`new Block({block})`
// pre-admission `content` parts) — see `block.utils.ts`.

/** `(JSONText | JSONInlineBlock)[]` → facade `ContentItem[]` (ids minted where missing). */
export const jsonContentToItems = (
	content: (JSONText | JSONInlineBlock)[],
	freshIds = false,
	mint: (prefix: 'b' | 'i') => string = id
): ContentItem[] =>
	content.map((part): ContentItem => {
		if ('type' in part) {
			return {
				kind: 'inline',
				id: freshIds || !part.id ? mint('i') : part.id,
				type: part.type,
				...(part.data ? { data: cloneJson(part.data) } : {})
			};
		}
		return {
			kind: 'text',
			text: part.text,
			...(part.marks ? { marks: cloneJson(part.marks) } : {})
		};
	});

/** `JSONBlock` → facade insert spec (ids `mint`ed where missing, recursively). */
export const jsonBlockToSpec = (
	block: JSONBlock,
	freshIds = false,
	mint: (prefix: 'b' | 'i') => string = id
): BlockSpec => ({
	id: freshIds || !block.id ? mint('b') : block.id,
	type: block.type,
	...(block.data ? { data: cloneJson(block.data) as Record<string, unknown> } : {}),
	...(block.content ? { content: jsonContentToItems(block.content, freshIds, mint) } : {}),
	...(block.children
		? { children: block.children.map((c) => jsonBlockToSpec(c, freshIds, mint)) }
		: {})
});
