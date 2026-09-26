/**
 * Public surface of the attribution service. `block.ts` is U1 — the
 * compact per-block records (`b/<blockId>` + the block-node `l` attr)
 * written inside the owning facade op's transaction. `attribution.ts`
 * is U2 — the actor dictionary (`u/`/`c/`) plus inert reads over
 * pre-existing `a/` per-edit records written by retired builds.
 */
export {
	ATTRIBUTION_ORIGIN,
	ATTRIBUTION_ROOT,
	bindAttribution,
	type ActorProfile,
	type AttributionActor,
	type AttributionBinding,
	type AttributionController,
	type DocumentAttribution
} from './attribution.js';

export {
	bindBlockAttribution,
	blockAttributionOf,
	blockRecordsOf,
	BLOCK_ATTR_ROOT,
	LAST_CHANGED_ATTR,
	type ActorId,
	type BlockAttribution,
	type BlockAttributionApi,
	type BlockRecord
} from './block.js';
