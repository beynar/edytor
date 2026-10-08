/**
 * The generation cutover (schema generation 4 → 5, 0.1.0-next.25).
 *
 * Generation 5 changed the format of what a document stores: marks are
 * paired operations (H5, fork patch P13), ranks are variable-length (P7)
 * and a SyncStep2 is v2 on the wire (P5). Bytes of generation 4 are never
 * integrated beside generation 5's (every frame and container names its
 * generation, `protocols/envelope.ts`): a container of generation 4 is
 * READ — its records applied to a scratch document, no admission, no
 * write — and its visible document taken as JSON, which generation 5
 * seeds again (a deterministic seed: two replicas converting the same
 * state write the same update). Reading needs no conversion of its own:
 * generation 4's plain format items fold as upstream formats, its ranks
 * order as strings, its delete records read as they are.
 *
 * What a conversion keeps: the visible document (blocks with their ids,
 * kinds, data and content, marks, the document's data). What it does not:
 * CRDT identity, history (undo), attribution, waiting deletes, and edits
 * a replica never sent before the cutover.
 *
 * Worker-safe: the room converts its container at load.
 */
import type { EngineApi, YDoc } from '../engine-api.js';
import { asEngineDoc } from '../structs.js';
import { bindEdytorDoc } from '../edytor-doc.js';
import { keepingReplaced } from '../incarnations.js';
import { PROTOCOL_VERSION, type GenerationRecord } from '../protocols/envelope.js';
import type { DocumentSemanticsConfig } from '../document.js';
import { defaultSemantics, facadeConfigOf } from '../semantics.js';
import type { JSONDoc } from '../../utils/json.js';

/** The schema generation this build converts from. */
export const PREVIOUS_SCHEMA = 4;

/** Whether container record `v` is generation 4's (`{engine, protocol, schema: 4}`). */
export const isPreviousGenerationRecord = (v: unknown): v is GenerationRecord =>
	typeof v === 'object' &&
	v !== null &&
	(v as GenerationRecord).engine === 'yjs-v14' &&
	(v as GenerationRecord).protocol === PROTOCOL_VERSION &&
	(v as GenerationRecord).schema === PREVIOUS_SCHEMA &&
	[undefined, 'v1', 'v2'].includes((v as GenerationRecord).storage);

/** A facade that reads (`toJSON`) and is let go (`dispose`). */
type Reader = { toJSON(): JSONDoc; dispose(): void };

export const bindGenerations = (Y: EngineApi) => {
	const docs = bindEdytorDoc(Y);
	/** A facade reading with `semantics` (the bundled kinds' by default). */
	const facadeWith =
		(semantics: DocumentSemanticsConfig = defaultSemantics) =>
		(doc: YDoc) =>
			docs.create(asEngineDoc(doc), facadeConfigOf(semantics));
	const generations = {
		isPreviousGenerationRecord,
		/**
		 * The visible document a state of generation 4 holds, as JSON: `updates`
		 * (v1 updates, or `{ v2 }` snapshots, in order) applied to a scratch
		 * document, read through `facadeOf` (a facade of this build, with the
		 * semantics the document is read with).
		 */
		previousJSON: (
			updates: ReadonlyArray<Uint8Array | { v2: Uint8Array }>,
			facadeOf: (doc: YDoc) => Reader
		): JSONDoc => {
			const doc = keepingReplaced(new Y.Doc());
			try {
				Y.transact(doc, () => {
					for (const u of updates)
						if (u instanceof Uint8Array) Y.applyUpdate(doc, u);
						else Y.applyUpdateV2(doc, u.v2);
				});
				const facade = facadeOf(doc);
				try {
					return facade.toJSON();
				} finally {
					facade.dispose();
				}
			} finally {
				doc.destroy();
			}
		},
		/**
		 * This generation's seed of `value` — the update a document seeds it
		 * with (deterministic: the same value writes the same update anywhere),
		 * read with `semantics`.
		 */
		seedOf: (value: JSONDoc, semantics?: DocumentSemanticsConfig): Uint8Array => {
			const doc = keepingReplaced(new Y.Doc());
			try {
				const facade = facadeWith(semantics)(doc);
				facade.seed(value.children, value.data);
				facade.dispose();
				return Y.encodeStateAsUpdate(doc);
			} finally {
				doc.destroy();
			}
		},
		/** {@link previousJSON} read with `semantics` (the bundled kinds' by default). */
		previousJSONWith: (
			updates: ReadonlyArray<Uint8Array | { v2: Uint8Array }>,
			semantics?: DocumentSemanticsConfig
		): JSONDoc => generations.previousJSON(updates, facadeWith(semantics))
	};
	return generations;
};
