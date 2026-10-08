/**
 * `admission.ts` — the ONE document-admission boundary.
 *
 * Every way content enters an {@link EdytorDocument} crosses the same
 * gate here, in the same order, with the same refusal semantics:
 *
 *   1. **`assertUsableDoc`** — is this a v14 engine doc at all
 *      ({@link UnsupportedDocError} `'foreign'`), and is it a v13-era
 *      layout that must be migrated rather than adopted (`'legacy'`)?
 *   2. **`assertSchema`** — does the committed schema manifest allow
 *      this build to own the doc ({@link SchemaMismatchError}:
 *      `'unversioned'` content with no version stamp, `'unsupported'`
 *      version this build cannot speak, `'foreign'` manifest naming
 *      another schema)?
 *   3. **Verdict** — `'fresh'` (registry empty — seeding is legal) or
 *      `'initialized'` (supported schema content present — assert and
 *      adopt, never seed).
 *
 * THE ADMISSION MATRIX — every entry path, what it validates, and the
 * state a refusal leaves:
 *
 *   Path                      Gate                                   Refusal leaves
 *   ─────────────────────────────────────────────────────────────────────────────
 *   `createDocument`          `assertAdmission` (trivially `'fresh'`)  nothing to refuse
 *   `loadDocument`            decode → apply onto a SCRATCH doc →      `UndecodableUpdateError`
 *                             `assertAdmission` on the merged result   (corrupt payload) / typed
 *                                                                      gate error; nothing is
 *                                                                      composed, caller's bytes
 *                                                                      untouched
 *   `attachDocument`          `assertAdmission` on the live doc        typed error BEFORE any
 *                             before composition                      composition touches it —
 *                                                                      borrowed doc byte-identical
 *                                                                      and re-attachable after the
 *                                                                      state heals
 *   `document.sync()`         `assertAdmission` re-check → verdict     problem state entered since
 *                                                                      attach (raw bypass writes):
 *                                                                      typed error, document stays
 *                                                                      `pending`, doc preserved
 *   provider frames/rows      generation word / container record;     foreign generation: dropped
 *                             inbound refusal of a foreign stamp      before decode; forged stamp:
 *                             (`protocols/sync.ts` `applyRemote`),    refused + reported; a pending
 *                             judged with what the update releases    one the update releases:
 *                             from the engine's pending store         pending store discarded; a
 *                                                                      stamp that got in anyway (raw
 *                                                                      apply) makes the doc read-only
 *   v13 migration             `bindLegacyReader` gate → rebuild via    legacy DB byte-identical; no
 *                             document-level `init` → `loadDocument`   v14 generation activated
 *
 * TWO LAYERS. The transport layer (`providers/*`, `protocols/*`) proves
 * the generation of every frame and container and refuses updates that
 * write a foreign stamp; it never stages. This module is the DOCUMENT
 * layer for bytes of unknown provenance: compose only admitted docs,
 * decide readiness by verdict, and answer `document.writable`. Both read
 * the same `checkSchema` definitions through this doorway.
 *
 * REFUSAL PRESERVES DATA. Every gate read is write-free — a refusal
 * mutates nothing: the target doc stays byte-identical, the caller's
 * update bytes are untouched, foreign roots/content survive next to a
 * refused verdict, and stored provider rows are never deleted or
 * rewritten because of one. The ONLY writes a doc sees before readiness
 * are the content it was offered; `sync()` is the single explicit
 * readiness transition, and a pending document never writes or
 * broadcasts a bootstrap block.
 */
import {
	assertSchema,
	assertUsableDoc,
	checkSchema,
	isInitialized,
	registryEmpty,
	schemaVersion,
	SchemaMismatchError,
	UnsupportedDocError
} from './edytor-doc.js';
import type { SchemaProblem } from './edytor-doc.js';
import type { EngineApi, EngineDoc, YDoc } from './engine-api.js';
import { asEngineDoc } from './structs.js';
import { keepingReplaced } from './incarnations.js';

// ── shared gate vocabulary (one doorway for document + transport layers) ──
export {
	assertSchema,
	assertUsableDoc,
	checkSchema,
	isInitialized,
	registryEmpty,
	schemaVersion,
	SchemaMismatchError,
	UnsupportedDocError
};
export type { SchemaProblem };

/**
 * What an admitted doc carries — the `sync()` readiness decision:
 *
 * - `'fresh'` — no schema claim and an empty block registry; seeding
 *   (`facade.init`) is legal. Foreign/unrelated ROOTS may still exist —
 *   they are not schema claims and coexist next to the seeded schema.
 * - `'initialized'` — supported schema content is committed; the doc is
 *   adopted as-is (`hydrated`), never seeded.
 */
export type AdmissionVerdict = 'fresh' | 'initialized';

/**
 * Non-throwing admission result — the audit/read-side counterpart of
 * {@link assertAdmission}.
 */
export type AdmissionResult =
	| { admitted: true; verdict: AdmissionVerdict }
	| { admitted: false; error: UnsupportedDocError | SchemaMismatchError };

/**
 * Raised when a candidate update cannot even be decoded or integrated —
 * refused before the schema question is ever asked. Distinct from the
 * schema refusals: this payload was never document-shaped.
 */
export class UndecodableUpdateError extends Error {
	constructor(
		/** What the update was offered as (e.g. `'loaded document'`). */
		public readonly docName: string,
		public readonly cause: unknown
	) {
		super(
			`Update refused for "${docName}": the payload could not be decoded or integrated` +
				(cause instanceof Error ? ` — ${cause.message}` : '')
		);
		this.name = 'UndecodableUpdateError';
	}
}

/**
 * The document-level admission gate — runs the ordered checks and throws
 * the typed refusal:
 *
 * - {@link UnsupportedDocError} `'foreign'` — not a v14 engine doc
 *   (foreign roots/engines may still attach *content* later; this is
 *   about doc shape);
 * - {@link UnsupportedDocError} `'legacy'` — v13-era layout present;
 *   route through `crdt/migration` instead of attaching;
 * - {@link SchemaMismatchError} `'unversioned' | 'unsupported' |
 *   'foreign'` — a schema claim this build cannot own.
 *
 * PURE READS — a refusal leaves the doc byte-identical (the reads may
 * materialize empty root SHARE entries in the doc's share map, which do
 * not encode into updates). Returns the {@link AdmissionVerdict} for the
 * readiness decision.
 */
export const assertAdmission = (doc: EngineDoc, docName = 'document'): AdmissionVerdict => {
	assertUsableDoc(doc);
	assertSchema(doc, docName);
	return isInitialized(doc) ? 'initialized' : 'fresh';
};

/**
 * Non-throwing {@link assertAdmission} — for audits, diagnostics, and
 * tests that need the verdict without control flow. Unexpected
 * (non-admission) errors still throw.
 */
export const inspectAdmission = (doc: EngineDoc, docName = 'document'): AdmissionResult => {
	try {
		return { admitted: true, verdict: assertAdmission(doc, docName) };
	} catch (error) {
		if (error instanceof UnsupportedDocError || error instanceof SchemaMismatchError) {
			return { admitted: false, error };
		}
		throw error;
	}
};

export const bindAdmission = (Y: EngineApi) => ({
	/**
	 * Staged update admission — the `loadDocument` seam. The payload is
	 * decoded and integrated onto a THROWAWAY scratch doc; the document
	 * gate then runs on the merged result, and only an admitted scratch
	 * is returned for composition. A refusal therefore leaves nothing
	 * mutated: the caller's bytes are never written anywhere, and no
	 * partially-integrated state escapes the scratch.
	 *
	 * Throws {@link UndecodableUpdateError} for payloads that fail to
	 * decode/integrate at all, then the usual typed refusals.
	 */
	admitUpdate: (
		update: Uint8Array | ReadonlyArray<Uint8Array | { v2: Uint8Array }>,
		docName = 'loaded document',
		options: {
			/** Prepare the scratch doc before anything is applied (e.g. its `gcFilter`). */
			prepare?: (doc: YDoc) => void;
		} = {}
	): YDoc => {
		const doc = keepingReplaced(new Y.Doc());
		options.prepare?.(doc);
		const apply = (part: Uint8Array | { v2: Uint8Array }) =>
			part instanceof Uint8Array ? Y.applyUpdate(doc, part) : Y.applyUpdateV2(doc, part.v2);
		try {
			// Several updates (`{ v2 }`: in the v2 encoding) are applied in one
			// transaction, with no merge pass.
			if (update instanceof Uint8Array) apply(update);
			else Y.transact(doc, () => update.forEach(apply));
		} catch (cause) {
			throw new UndecodableUpdateError(docName, cause);
		}
		assertAdmission(asEngineDoc(doc), docName);
		return doc;
	}
});
