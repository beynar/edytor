/**
 * The version record and the deterministic seed (doc-level, facade-free).
 *
 * ── Deterministic seed ───────────────────────────────────────
 *
 *
 * `seed(doc, value)` applies ONE update built in a scratch doc whose writer
 * id is a hash of (generation, canonical seed JSON) in a low band below
 * 2^26: caller ids are kept, missing ids are derived from the hash and
 * position, ranks and incarnation nonces come from the rand seam seeded by
 * the hash. Peers seeding the same value therefore write the SAME items — a
 * late identical seed is a no-op and never erases an edit — while different
 * values union. A shared id resolves by registry LWW (the larger client id):
 * against a block a live replica (uint53 id) wrote, the seed loses; between
 * two different seeds, the larger hash wins and can replace a block edited
 * since (a known residual: never seed a changing snapshot beside a room).
 * An empty value seeds one `defaultType` block. The update is applied
 * with a non-local origin: never an undo step, no attribution stamp.
 * Seeding is explicit: reads never create or normalize state.
 */
import type { EngineApi, EngineDoc } from '../engine-api.js';
import type { PlacementModel, BlockSpec } from '../placement/model.js';
import type { BlockAttributionApi } from '../attribution/block.js';
import type { JsonObj } from './types.js';
import { hash32, setDocRand } from '../rand.js';
import { keepingReplaced } from '../incarnations.js';
import { asEngineDoc, asYDoc } from '../structs.js';
import { DOC_DATA_ROOT, SCHEMA } from '../schema.js';
import { dataLeaves, isObject, writeLeaves } from '../data.js';
import {
	jsonBlockToSpec,
	sanitizeSpec,
	sanitizeWireJson,
	sanitizeWireString,
	type JSONBlock
} from '../../utils/json.js';
import { isInitialized, META_KEY, registryEmpty, SCHEMA_NAME, SCHEMA_VERSION } from './gate.js';

/** Origin of the seed update's apply — non-local, like any integrated update. */
export const SEED_ORIGIN = Symbol('edytor:seed');

/** The version record and seed writers over the bound engine layers. */
export const bindSeed = (Y: EngineApi, M: PlacementModel, BA: BlockAttributionApi) => {
	/**
	 * Stamp the version record, absent only: never downgrade a higher
	 * version written by a newer peer — the version gate decides compatibility.
	 */
	const stamp = (doc: EngineDoc): void => {
		const meta = doc.get(META_KEY);
		if (meta.getAttr(SCHEMA.metaAttrs.version) !== undefined) return;
		meta.setAttr(SCHEMA.metaAttrs.version, SCHEMA_VERSION);
		meta.setAttr(SCHEMA.metaAttrs.schema, SCHEMA_NAME);
	};

	/**
	 * Restore definition (migration only): stamp the version
	 * record (absent only) and make `content` the whole document under its
	 * own ids, rewritten in place where they exist (the model's
	 * `restoreBlocks`). Writes no attribution.
	 */
	const restore = (doc: EngineDoc, content: BlockSpec[]): void =>
		doc.transact(() => {
			stamp(doc);
			M.restoreBlocks(doc, content.map(sanitizeSpec));
		});

	/**
	 * Stamp the version record (absent only) and, into an EMPTY registry,
	 * bulk-insert `content` — the local materializer: the seed's scratch
	 * doc, migration's rebuild and fixtures. Without `content` it seeds an
	 * unstamped empty doc (see {@link seed}). Idempotent otherwise. It
	 * writes no attribution (authored content goes through the ops).
	 */
	const init = (
		doc: EngineDoc,
		opts: { content?: BlockSpec[]; defaultType?: string } = {}
	): void => {
		const specs = (opts.content ?? []).map(sanitizeSpec);
		if (specs.length === 0 && registryEmpty(doc) && !isInitialized(doc)) {
			return seed(doc, [], opts.defaultType);
		}
		doc.transact(() => {
			stamp(doc);
			if (specs.length === 0 || !registryEmpty(doc)) return;
			// Bulk path: one sibling read + a local rank chain for the
			// whole batch. All-or-nothing: a dup spec id refuses the batch.
			if (!M.insertBlocks(doc, { parent: null, index: Number.MAX_SAFE_INTEGER }, specs)) {
				// Malformed initial content (e.g. a duplicated id) — fall back
				// to per-spec insertion so valid blocks still load.
				console.error(
					'[edytor-doc] initial content refused by bulk insert; retrying per-spec (duplicate block ids are skipped)'
				);
				for (const spec of specs) {
					M.insertBlock(doc, { parent: null, index: Number.MAX_SAFE_INTEGER }, spec);
				}
			}
		});
	};

	/**
	 * The deterministic seed update — see the module header.
	 * Every seeded block also gets an EMPTY `b/` record (no authorship) so
	 * later contributor adds land on one shared node.
	 */
	const seedUpdate = (
		value: JSONBlock[],
		defaultType = 'paragraph',
		data?: JsonObj
	): Uint8Array => {
		// Canonical form (object keys sorted, arrays in order): the hash AND
		// the build read it, so key order never splits one template.
		const sorted = (_: string, v: unknown) =>
			v && typeof v === 'object' && !Array.isArray(v)
				? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
				: v;
		const blocks: JSONBlock[] = JSON.parse(
			JSON.stringify(value.length > 0 ? value : [{ type: defaultType }], sorted)
		);
		// The document's data joins the hash only when it has some (seeds without it keep their
		// writer), in the canonical form too: the build writes its leaves in that key order.
		const own =
			isObject(data) && Object.keys(data).length > 0
				? (JSON.parse(JSON.stringify(sanitizeWireJson(data), sorted)) as JsonObj)
				: undefined;
		const hashed = own === undefined ? blocks : { data: own, blocks };
		// The writer lives in a low band, [1, 2^26): a registry race is won by
		// the larger client id and live replicas draw uint53 ids, so a seed
		// sharing a block id with live content loses to it but for a
		// live id below the band (~2^-27). Two different seeds collide on one
		// writer at ~2^-26. The band moved from the full 32 bits: an id-less
		// template seeded late into a document seeded by an older build
		// mints new ids and shows twice, once.
		const writer =
			hash32(`yjs-v14/${SCHEMA_NAME}@${SCHEMA_VERSION}:${JSON.stringify(hashed)}`) >>> 6 || 1;
		let n = 0;
		const mint = (prefix: string) => `${prefix}${writer.toString(36)}.${n++}`;
		const specs = blocks.map((block) => jsonBlockToSpec(block, false, mint));
		const raw = keepingReplaced(new Y.Doc());
		raw.clientID = writer;
		const scratch = asEngineDoc(raw);
		let rank = writer; // ranks from the rand seam, seeded by the hash (LCG)
		setDocRand(scratch, () => (rank = (Math.imul(rank, 1664525) + 1013904223) >>> 0) / 2 ** 32);
		init(scratch, { content: specs });
		const records = (spec: BlockSpec): void => {
			BA.ensureRecord(scratch, sanitizeWireString(spec.id));
			spec.children?.forEach(records);
		};
		scratch.transact(() => {
			specs.forEach(records);
			writeLeaves(scratch.get(DOC_DATA_ROOT), dataLeaves(own));
		});
		return Y.encodeStateAsUpdate(raw);
	};

	/** Apply the deterministic seed of `value` with the non-local {@link SEED_ORIGIN}. */
	const seed = (
		doc: EngineDoc,
		value: JSONBlock[] = [],
		defaultType?: string,
		data?: JsonObj
	): void => Y.applyUpdate(asYDoc(doc), seedUpdate(value, defaultType, data), SEED_ORIGIN);

	return { stamp, restore, init, seedUpdate, seed };
};
