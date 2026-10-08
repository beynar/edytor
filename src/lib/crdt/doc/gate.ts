/**
 * The schema gate — module-level, pure document reads shared by providers
 * and migration without binding an engine.
 *
 * ── Schema manifest ────────────────────────────────────────────────────
 *
 * Unified `Y.Node` cannot distinguish roles by class (no `Y.Text` vs
 * `Y.Map`), so every semantic role is recorded explicitly in {@link SCHEMA}
 * — the constants table IS the manifest (node names, root keys, attr
 * names). The replicated half of the contract is the version record: init
 * writes `doc.get('meta').setAttr('v', SCHEMA_VERSION)` (+ `schema` name) so
 * ANY replica — including one that only ever applied updates — can read the
 * schema version before mutating (the version gate). `doc.get` on a root
 * emits no update, so the read path stays write-free.
 *
 * Replicated layout:
 *
 * ```
 * doc.get('blocks')                      registry — flat map, blockId → node('block')
 *   └ <blockId>                           id/n/type/data/del + content/claims/at
 *                                         (n: incarnation nonce)
 * doc.get('meta')                        version record root
 *   ├ v : number                          SCHEMA_VERSION (LWW attr — concurrent init converges)
 *   └ schema : 'edytor-doc'               SCHEMA_NAME
 * ```
 */
import type { EngineDoc } from '../engine-api.js';
import { isNodeLike, SCHEMA } from '../schema.js';
import { isLegacyDoc } from '../migration/legacy-schema.js';

export const SCHEMA_VERSION = SCHEMA.version;
export const SCHEMA_NAME = SCHEMA.name;
export const META_KEY = SCHEMA.roots.meta;

/**
 * The replicated schema version (`meta.v`) — `undefined` before init.
 * Read-only: `doc.get` on a root emits no update.
 */
export const schemaVersion = (doc: EngineDoc): number | undefined => {
	const v = doc.get(SCHEMA.roots.meta).getAttr(SCHEMA.metaAttrs.version);
	return typeof v === 'number' ? v : undefined;
};

/** True iff the `blocks` registry holds at least one entry (live or deleted). */
export const registryEmpty = (doc: EngineDoc): boolean =>
	doc.get(SCHEMA.roots.registry).attrKeys().next().done === true;

/**
 * True iff the document carries the schema version record. Content alone —
 * e.g. a raw `doc.get('blocks').setAttr('x', …)` write — is NOT proof of
 * initialization: the gate distinguishes "versioned" from "has any registry
 * state" so rogue unversioned writes never masquerade as an initialized doc.
 * A replica that learned `meta.v` purely by applying updates counts.
 */
export const isInitialized = (doc: EngineDoc): boolean => schemaVersion(doc) !== undefined;

/**
 * A document's relationship to this build's schema:
 *
 * - `unversioned` — registry state exists but `meta.v` is absent. Someone
 *   wrote replicated content without running the schema path (a rogue or
 *   v13-era write). This state must NEVER be persisted/broadcast as a
 *   document update by a provider.
 * - `unsupported` — `meta.v` names a version this build does not speak
 *   (e.g. `99` written by a future build). Content still applies (a replica
 *   cannot refuse structs it already shares a protocol with), but providers
 *   surface a `schema-mismatch` signal so operators can detect skew.
 * - `foreign` — `meta.v` is the supported version but `meta.schema` is
 *   missing or names a DIFFERENT manifest (`'not-edytor'`, a next-gen name,
 *   an app-local doc kind). A valid version number alone does not make the
 *   payload an edytor document — the manifest name is part of the contract
 *   (the version-only check let foreign `meta.schema` values
 *   cross the staging boundary).
 */
export type SchemaProblem = {
	kind: 'unversioned' | 'unsupported' | 'foreign';
	/** The observed `meta.v` (undefined for `unversioned`). */
	version?: number;
	/** The observed `meta.schema` (undefined when absent). */
	schema?: unknown;
};

/** The observed `meta.schema` manifest name (`undefined` when absent). */
const schemaName = (doc: EngineDoc): unknown =>
	doc.get(SCHEMA.roots.meta).getAttr(SCHEMA.metaAttrs.schema);

/**
 * Inspect the document's schema record. `null` = clean (versioned under the
 * supported schema AND manifest name, or completely untouched). Read-only,
 * safe mid-transaction.
 */
export const checkSchema = (doc: EngineDoc): SchemaProblem | null => {
	const v = schemaVersion(doc);
	const name = schemaName(doc);
	if (v === undefined) {
		if (registryEmpty(doc)) {
			// Completely untouched is clean — but a bare FOREIGN manifest
			// name with no other state is still a foreign claim, not a doc
			// this build can speak for. A stray copy of our own name is
			// inert (no registry, no version claim).
			return name === undefined || name === SCHEMA_NAME ? null : { kind: 'foreign', schema: name };
		}
		return { kind: 'unversioned', schema: name };
	}
	if (v !== SCHEMA_VERSION) return { kind: 'unsupported', version: v, schema: name };
	if (name !== SCHEMA_NAME) return { kind: 'foreign', version: v, schema: name };
	return null;
};

/** Error raised by {@link assertSchema} — carries the detected problem. */
export class SchemaMismatchError extends Error {
	constructor(
		public readonly docName: string,
		public readonly problem: SchemaProblem
	) {
		super(
			problem.kind === 'unversioned'
				? `Document "${docName}" carries replicated registry state but no meta.v schema version — refusing to treat it as initialized.`
				: problem.kind === 'unsupported'
					? `Document "${docName}" claims unsupported schema version ${problem.version} (this build speaks ${SCHEMA_VERSION}).`
					: problem.schema === undefined
						? `Document "${docName}" carries meta.v=${problem.version} but no meta.schema manifest name — refusing it as an "${SCHEMA_NAME}" document.`
						: `Document "${docName}" claims foreign schema "${String(problem.schema)}" (this build speaks "${SCHEMA_NAME}").`
		);
		this.name = 'SchemaMismatchError';
	}
}

/**
 * Hard gate — throws {@link SchemaMismatchError} when `checkSchema` reports a
 * problem. Used by migration and by `Edytor.sync()` before
 * mutating a synced document.
 */
export const assertSchema = (doc: EngineDoc, docName = 'doc'): void => {
	const problem = checkSchema(doc);
	if (problem !== null) throw new SchemaMismatchError(docName, problem);
};

/**
 * Error raised by {@link assertUsableDoc} — the doc cannot host a v14 facade.
 * `kind` distinguishes a foreign engine object (a real v13 `yjs` Doc — a
 * different CRDT implementation entirely) from a v14 doc that decodes the
 * legacy v13 Edytor schema (applied v13 update rows awaiting migration).
 */
export class UnsupportedDocError extends Error {
	constructor(public readonly kind: 'foreign' | 'legacy') {
		super(
			kind === 'legacy'
				? 'Document carries the legacy v13 Edytor schema (`content` root) — ' +
						'migrate it via `crdt.migration` before attaching an editor.'
				: 'Document is not a v14 engine doc — the `blocks` registry is not a ' +
						'unified Y.Node. Use `crdt.createDoc()` (or `new Y.Doc()` from ' +
						'`edytor/crdt`); a v13 `yjs` Doc must be migrated via ' +
						'`crdt.migration` (from its stored updates), not passed to the runtime.'
		);
		this.name = 'UnsupportedDocError';
	}
}

/**
 * Document-boundary guard run by {@link EdytorDocBinding.create} before the
 * runs view attaches. The facade only speaks the v14 unified-node surface —
 * without this gate a foreign doc dies obscurely inside `buildView`
 * (`registry.forEachAttr is not a function`), and a legacy-schema doc would be
 * silently misread. Both fail fast with an actionable error instead.
 */
export const assertUsableDoc = (doc: EngineDoc): void => {
	let registry: unknown;
	try {
		registry = typeof doc?.get === 'function' ? doc.get(SCHEMA.roots.registry) : undefined;
	} catch {
		registry = undefined;
	}
	if (!isNodeLike(registry) || typeof registry.forEachAttr !== 'function') {
		throw new UnsupportedDocError('foreign');
	}
	if (isLegacyDoc(doc)) {
		throw new UnsupportedDocError('legacy');
	}
};
