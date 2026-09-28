/**
 * U2 — legacy attribution surface: actor dictionary + inert reads over
 * pre-existing per-edit records.
 *
 * The U6 capture pipeline (immutable `a/<nonce>/<seq>` ContentMap records
 * written in a follow-up transaction per committed edit, projected onto
 * text runs by U7) is REMOVED: ordinary editing performs no attribution
 * writes at all — one transaction/update per keystroke, no observer hook,
 * no per-edit durable record. The durable block-level model lives in
 * `block.ts` (U1) and is unaffected.
 *
 * What this module still owns:
 *
 *   ACTOR DICTIONARY — the replicated `u/`/`c/` records remain the
 *   document's durable actor surface:
 *
 *     `c/<replicaClientID>`  → actor id — replica→actor binding.
 *     `u/<actorId>`          → profile `{name?, color?}` — one record per
 *                              stable application actor, referenced by id.
 *
 *   Published once per attach (inside an `ATTRIBUTION_ORIGIN`
 *   transaction) and readable through `actors`/`actorOf`. These records
 *   also travel inside `encode()` output, so `loadDocument` restores the
 *   dictionary without republishing.
 *
 *   LEGACY RECORDS — documents saved by pre-U2 builds carry `a/` records
 *   under the same root. They are plain replicated state: preserved
 *   verbatim by `encode()`/sync and readable through `legacy()`, which
 *   decodes and merges them with the native `decodeContentMap` codecs.
 *   This build never writes new `a/` records; old replicas that still do
 *   simply append more keys — reads stay total and convergence is the
 *   ordinary attribute-record merge.
 *
 *   RETENTION — `a/` state is retained as long as it exists in the
 *   document (no GC of the records themselves); `live()`/renderer
 *   projections are gone, and the engine no longer ships concrete
 *   renderers (UPSTREAM.md P8) — consumers that need a rendered view over
 *   legacy records implement the engine's `AbstractRenderer` over the
 *   `ContentMap` `legacy()` returns and pass it to `toDelta({renderer})`.
 */
import type { EngineApi, EngineDoc } from '../engine-api.js';
import type * as Engine from '../vendor/yjs/dts/index.js';
import { ATTRIBUTION_ROOT } from '../schema.js';
import { cloneJson, type JSONBlock } from '../../utils/json.js';
import {
	blockAttributionOf,
	lineageOf,
	lineageWatermarkOf,
	type BlockAttribution
} from './block.js';

/** Reserved replicated root for all attribution metadata (`SCHEMA.roots.attribution`). */
export { ATTRIBUTION_ROOT };

/**
 * Origin of every metadata write this module performs (`u/`/`c/`
 * dictionary publishes only — U2 retired per-edit record writes). Kept
 * out of undo capture; tooling classifies it as bookkeeping.
 */
export const ATTRIBUTION_ORIGIN = Symbol('edytor.attribution');

const RECORD_PREFIX = 'a/'; // legacy immutable per-transaction ContentMap records
const ACTOR_PREFIX = 'u/'; // actorId → profile records
const CLIENT_PREFIX = 'c/'; // replica clientID → actorId records

/** The stable application-level author identity (mirrors `DocumentActor`). */
export type AttributionActor = {
	id: string;
	name?: string;
	color?: string;
};

/** Replicated actor profile record payload (`u/` values). */
export type ActorProfile = {
	name?: string;
	color?: string;
};

/**
 * The document-level attribution surface. `actors`/`actorOf`/`legacy`
 * read replicated doc state directly — they resolve remote-applied
 * records identically and stay correct as old replicas append records.
 */
export type DocumentAttribution = {
	/** actorId → profile — the replicated actor dictionary (`u/` records). */
	readonly actors: ReadonlyMap<string, ActorProfile>;
	/** Resolve an item's inserting replica (clientID) to an actor id (`c/` records). */
	actorOf(client: number): string | undefined;
	/**
	 * Re-publish the local actor's profile record (`u/<actorId>` — LWW).
	 * Attribution is never relabeled: historical records keep the stable
	 * actor id; only the resolvable profile changes.
	 */
	setProfile(profile: ActorProfile): void;
	/**
	 * U2 — merged read over the pre-existing `a/` records written by the
	 * retired per-edit capture pipeline: `{inserts, deletes}` IdMaps in
	 * the native ContentMap shape, decoded fresh per call. Returns `null`
	 * when the document carries no legacy records. For a rendered history
	 * view, implement the engine's `AbstractRenderer` over it (the engine
	 * ships no concrete renderer — UPSTREAM.md P8); the ordinary
	 * runs/projection surface does not consult it.
	 */
	legacy(): Engine.ContentMap | null;
	/**
	 * U1 — compact per-block attribution for `blockId`
	 * (`{createdBy, contributors, lastChangedBy}` — durable actor ids,
	 * never replica clientIDs), or `undefined` for system/foreign blocks
	 * that carry no record. O(1) per call; reads replicated state directly
	 * so remote-applied attribution resolves identically.
	 *
	 * `contributors` is block-identity LINEAGE — actors who committed an
	 * edit addressing this block id, plus the pre-split snapshot a
	 * split/merge copies to siblings. It is not authorship of the text
	 * currently rendered in the block: a concurrent split can carry an
	 * actor's atoms into a sibling the actor never addressed. Do not
	 * present it as "written by" for visible text.
	 */
	block(blockId: string): BlockAttribution | undefined;
	/**
	 * Opt-in bounded lineage ring for `blockId` — the block's subtree
	 * snapshots captured just BEFORE displacing events: another actor's
	 * first write (an `l` handoff), a delete, or an undo/redo touching the
	 * block. Oldest → newest, capped at the document's configured
	 * `lineage.depth`; `undefined` when the block carries no record (and
	 * empty when the feature is off or nothing has been displaced yet).
	 *
	 * The cap is enforced HERE, at read: concurrent appends under
	 * partition can transiently store `depth + n` entries (the
	 * append-side trim only sees the writer's own ring) until the
	 * replicated watermark trim converges the stored ring — this view
	 * never returns more than `depth`. A replica configured `depth: 0`
	 * (writes off) instead sees the ring's own retention bound — the
	 * deepest depth any surviving entry's writer used.
	 *
	 * Each entry's `block` is a deep-copied `JSONBlock` — restoring an
	 * entry is an ordinary `setBlock`-class edit (which itself lands a
	 * new entry, displacing the state it overwrote). Entries on a dead
	 * block stay readable here — the record survives deletion — but a
	 * reincarnated block id starts a FRESH ring: old history never
	 * contaminates the new incarnation.
	 */
	history(blockId: string): BlockLineageEntry[] | undefined;
};

/** A public lineage entry — the expanded form of the compact wire record. */
export type BlockLineageEntry = {
	/** The displaced owner (absent when the block was unattributed at capture). */
	actor?: string;
	/** The actor whose edit displaced the state (or whose undo/redo touched the block). */
	by: string;
	/**
	 * Ring position at append — a display aid only. It can REPEAT (a trim
	 * rewinds the position counter, and concurrent replicas assign the
	 * same position independently): never an entry id — array order is
	 * the truth.
	 */
	seq: number;
	/** Wall-clock capture time — display only, never ordering. */
	time?: number;
	/** The displaced subtree snapshot (deep-copied — safe to keep/mutate). */
	block: JSONBlock;
};

export type AttributionController = {
	/** The public read surface handed to `EdytorDocument.attribution`. */
	readonly view: DocumentAttribution;
	/** Re-publish the local actor's profile record (`u/<actorId>` LWW). */
	setProfile(profile: ActorProfile): void;
	/** Release the controller; `setProfile` becomes a no-op. Reads stay live. */
	destroy(): void;
};

type AttachOptions = {
	actor: AttributionActor;
};

const sanitizeProfile = (value: unknown): ActorProfile => {
	const v = (value ?? undefined) as { name?: unknown; color?: unknown } | undefined;
	const out: ActorProfile = {};
	if (typeof v?.name === 'string') out.name = v.name;
	if (typeof v?.color === 'string') out.color = v.color;
	return out;
};

const profileOf = (actor: AttributionActor): ActorProfile => ({
	...(actor.name !== undefined ? { name: actor.name } : {}),
	...(actor.color !== undefined ? { color: actor.color } : {})
});

/**
 * Bind the attribution service to a concrete engine — same injection
 * pattern as `bindEdytorDoc`/`bindDocument`. Lifecycle is owned by the
 * calling document: one controller per `EdytorDocument`, attached in the
 * constructor, released on destroy.
 */
export const bindAttribution = (Y: EngineApi) => {
	/**
	 * Attach the actor dictionary to `doc`: publishes this replica's
	 * `c/`+`u/` records and returns the read-through view. No listeners —
	 * ordinary edits perform no attribution work (U2).
	 */
	const attach = (doc: EngineDoc, opts: AttachOptions): AttributionController => {
		const actor = opts.actor;
		const root = doc.get(ATTRIBUTION_ROOT);
		let destroyed = false;

		const setProfile = (profile: ActorProfile): void => {
			if (destroyed) return;
			doc.transact(() => {
				root.setAttr(`${ACTOR_PREFIX}${actor.id}`, sanitizeProfile(profile));
			}, ATTRIBUTION_ORIGIN);
		};

		doc.transact(() => {
			root.setAttr(`${CLIENT_PREFIX}${doc.clientID}`, actor.id);
			// `u/` is rewritten only when the stored profile actually differs —
			// `c/<clientID>` is always fresh per attach (new clientID) but the
			// profile item + tombstone shouldn't regrow on every reload.
			const next = profileOf(actor);
			const stored = sanitizeProfile(root.getAttr(`${ACTOR_PREFIX}${actor.id}`));
			if (stored.name !== next.name || stored.color !== next.color) {
				root.setAttr(`${ACTOR_PREFIX}${actor.id}`, next);
			}
		}, ATTRIBUTION_ORIGIN);

		const view: DocumentAttribution = {
			get actors() {
				const out = new Map<string, ActorProfile>();
				for (const key of root.attrKeys()) {
					if (!key.startsWith(ACTOR_PREFIX)) continue;
					out.set(key.slice(ACTOR_PREFIX.length), sanitizeProfile(root.getAttr(key)));
				}
				return out;
			},
			actorOf: (client) => {
				const value = root.getAttr(`${CLIENT_PREFIX}${client}`);
				return typeof value === 'string' && value.length > 0 ? value : undefined;
			},
			setProfile,
			legacy: () => {
				const inserts = Y.createIdMap();
				const deletes = Y.createIdMap();
				let found = false;
				for (const key of root.attrKeys()) {
					if (!key.startsWith(RECORD_PREFIX)) continue;
					const value = root.getAttr(key);
					if (!(value instanceof Uint8Array)) continue;
					let change: Engine.ContentMap;
					try {
						change = Y.decodeContentMap(value);
					} catch {
						continue; // malformed record — skip, never poison the merged map
					}
					Y.insertIntoIdMap(inserts, change.inserts);
					Y.insertIntoIdMap(deletes, change.deletes);
					found = true;
				}
				return found ? Y.createContentMap(inserts, deletes) : null;
			},
			// U1: `b/<id>` records live on the `blockattr` root and `l` on
			// the block node — plain replicated reads, no observer needed.
			block: (blockId) => blockAttributionOf(doc, blockId),
			// Opt-in ring (`lineage.depth`): read the record's list items
			// capped at the ring's watermark — the max depth of surviving
			// entries, identical to the bound appends and the receive-side
			// trim enforce, so every replica reads the SAME ring for the
			// same stored state regardless of its own `lineage.depth`.
			// (Concurrent appends can store a transient excess until the
			// trim converges it.) Deep-copy each entry — the stored `j`
			// snapshot is shared replicated state and must not be mutable
			// through this view.
			history: (blockId) => {
				const entries = lineageOf(doc, blockId);
				if (entries === undefined) return undefined;
				const cap = lineageWatermarkOf(entries);
				const visible = entries.length > cap ? entries.slice(entries.length - cap) : entries;
				return visible.map((e) => ({
					...(e.a !== undefined ? { actor: e.a } : {}),
					by: e.by,
					seq: e.s,
					...(e.t !== undefined ? { time: e.t } : {}),
					block: cloneJson(e.j) as JSONBlock
				}));
			}
		};

		return {
			view,
			setProfile,
			destroy: () => {
				destroyed = true;
			}
		};
	};

	return { attach };
};

export type AttributionBinding = ReturnType<typeof bindAttribution>;
