/**
 * Canonical serialisation types for the editor document model.
 *
 * This module is engine-agnostic: it only describes the JSON surface shared by
 * the model wrappers, the CRDT facade and consumers. CRDT-bound compatibility
 * types (YTextLike/YBlockLike) live in `src/lib/crdt/compat.ts` so no `yjs`
 * import exists anywhere under `src/lib` outside the vendored v14 engine.
 *
 * ## Boundary contract (gate-3 F4)
 *
 * `JSONBlock.data`, `JSONText.marks`, `JSONInlineBlock.data`, format payloads
 * and every other value crossing the replicated boundary are **JSON-typed
 * only**: plain objects, arrays, strings, finite numbers, booleans and `null`.
 * Non-JSON values cannot cross the wire — peers and persistence only ever see
 * the serialized form — so `cloneJson` coerces or drops them (`Date` → string,
 * `Map` → `{}`, `undefined`/function keys dropped, `NaN`/`Infinity` → `null`,
 * circular/`bigint` → throws).
 *
 * The coercion is never *silent*: in dev builds `cloneJson` walks the value
 * and reports every offending path via `console.warn`. Store plain JSON —
 * serialize richer values (dates, typed maps) yourself at the plugin edge.
 */
import { DEV } from 'esm-env';

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

/**
 * Deep-clone a value through the JSON boundary (`JSON.parse(JSON.stringify)`).
 * Every call site is a point where replicated state is crossed — see the
 * module docstring for the JSON-only contract. Dev builds warn once per
 * unique violation report so non-JSON values never coerce silently.
 */
export const cloneJson = <T>(value: T): T => {
	if (DEV) {
		const violations: string[] = [];
		collectJsonBoundaryViolations(value, '$', violations, new Set());
		if (violations.length) {
			const report = violations.join('\n  ');
			if (!reportedJsonBoundaryViolations.has(report)) {
				if (reportedJsonBoundaryViolations.size >= MAX_JSON_BOUNDARY_REPORTS) {
					reportedJsonBoundaryViolations.clear();
				}
				reportedJsonBoundaryViolations.add(report);
				console.warn(
					`[edytor] cloneJson: non-JSON values at the replicated boundary are coerced or dropped:\n  ${report}`
				);
			}
		}
	}
	return JSON.parse(JSON.stringify(value)) as T;
};
