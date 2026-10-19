/**
 * Attribution surface: the actor dictionary and the per-block records.
 *
 * The per-edit capture pipeline of earlier builds (immutable `a/<nonce>/<seq>` ContentMap records
 * written in a follow-up transaction per committed edit, projected onto
 * text runs) is REMOVED: ordinary editing performs no attribution
 * writes at all — one transaction/update per keystroke, no observer hook,
 * no per-edit durable record. The durable block-level model lives in
 * `block.ts` and is unaffected.
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
 *   Published with the replica's first write: inside the first local
 *   transaction that writes under its client id (the engine's
 *   `beforeCommit`, fork patch YP30), so a replica that only reads writes
 *   nothing, and every struct it writes travels with its binding. Readable
 *   through `actors`/`actorOf`. These records also travel inside `encode()`
 *   output, so `loadDocument` restores the dictionary without
 *   republishing.
 *
 *   LEGACY RECORDS — documents saved by early builds carry `a/` per-edit
 *   records under the same root. They are plain replicated state, preserved
 *   verbatim by `encode()`/sync (no GC of the records themselves); nothing
 *   reads them. This build never writes new `a/` records; old replicas that
 *   still do simply append more keys — convergence is the ordinary
 *   attribute-record merge.
 */
import type { EngineApi, EngineDoc } from '../engine-api.js';
import { ATTRIBUTION_ROOT } from '../schema.js';
import { writersOf } from '../text/model.js';
import { blockAttributionOf, type BlockAttribution } from './block.js';

/** Reserved replicated root for all attribution metadata (`SCHEMA.roots.attribution`). */
export { ATTRIBUTION_ROOT };

/**
 * Origin of the profile writes this module performs on its own
 * (`setProfile`; the binding joins the transaction of the replica's first
 * write, whatever its origin). Kept out of undo capture; tooling classifies
 * it as bookkeeping.
 */
export const ATTRIBUTION_ORIGIN = Symbol('edytor.attribution');

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
 * The document-level attribution surface. `actors`/`actorOf`/`block`
 * read replicated doc state directly — they resolve remote-applied
 * records identically and stay correct as old replicas append records.
 */
export type DocumentAttribution = {
	/**
	 * actorId → profile — the replicated actor dictionary (`u/` records): the
	 * actors whose replicas wrote, each published with its replica's first
	 * write (or `setProfile`).
	 */
	readonly actors: ReadonlyMap<string, ActorProfile>;
	/**
	 * Resolve an item's inserting replica (clientID) to an actor id (`c/`
	 * records). A replica's binding is written with its first write, so every
	 * client id that wrote a struct resolves; one that never wrote does not.
	 */
	actorOf(client: number): string | undefined;
	/**
	 * Re-publish the local actor's profile record (`u/<actorId>` — LWW), a
	 * write of this replica (its binding goes with it, as with any first
	 * write). Attribution is never relabeled: historical records keep the
	 * stable actor id; only the resolvable profile changes.
	 */
	setProfile(profile: ActorProfile): void;
	/**
	 * Compact per-block attribution for `blockId`
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

/** The actor each attached document's replica writes for (its attribution controller's). */
const localActors = new WeakMap<object, string>();

/**
 * The actor `doc`'s own replica writes for: its binding (`c/<clientID>`),
 * else, before its first write, the actor its attribution controller was
 * attached with (`undefined`: a raw doc). The provider's `saved` reads it.
 */
export const writerOf = (doc: EngineDoc): string | undefined => {
	// A raw doc without the root gets none (reading would create it).
	const bound = (doc as { share?: Map<string, unknown> }).share?.has(ATTRIBUTION_ROOT)
		? doc.get(ATTRIBUTION_ROOT).getAttr(`${CLIENT_PREFIX}${doc.clientID}`)
		: undefined;
	return typeof bound === 'string' && bound.length > 0 ? bound : localActors.get(doc);
};

const sanitizeProfile = (value: unknown): ActorProfile => {
	const v = (value ?? undefined) as { name?: unknown; color?: unknown } | undefined;
	const out: ActorProfile = {};
	if (typeof v?.name === 'string') out.name = v.name;
	if (typeof v?.color === 'string') out.color = v.color;
	return out;
};

/** The display profile of `actor`: its name and color, those it has. */
export const profileOf = (actor: AttributionActor): ActorProfile => ({
	...(actor.name !== undefined ? { name: actor.name } : {}),
	...(actor.color !== undefined ? { color: actor.color } : {})
});

/**
 * Bind the attribution service to a concrete engine — same injection
 * pattern as `bindEdytorDoc`/`bindDocument`. Lifecycle is owned by the
 * calling document: one controller per `EdytorDocument`, attached in the
 * constructor, released on destroy.
 */
export const bindAttribution = (_Y: EngineApi) => {
	/**
	 * Attach the actor dictionary to `doc` and return the read-through view.
	 * This replica's `c/`+`u/` records are written with its first write
	 * (`bind`, below), never at attach: a replica that only reads leaves the
	 * document as it found it.
	 */
	const attach = (doc: EngineDoc, opts: AttachOptions): AttributionController => {
		const actor = opts.actor;
		const root = doc.get(ATTRIBUTION_ROOT);
		let destroyed = false;
		/** The client id this replica's binding was written for (`null`: none yet). */
		let bound: number | null = null;

		/**
		 * The binding, inside the transaction of the replica's first write
		 * under its client id (and again for a new client id, fork patch
		 * YP15): `c/<clientID>`, and `u/<actorId>` when the stored profile
		 * differs (it is not rewritten at every reload). A binding the
		 * document already holds for the id (an attached doc, the room's
		 * rebinding) stands.
		 */
		const bind = (transaction: never): void => {
			const tr = transaction as {
				local: boolean;
				insertSet: { clients: Map<number, unknown> };
				changed: Map<unknown, Set<string | null>>;
			};
			if (destroyed || !tr.local) return;
			const client = doc.clientID;
			if (bound !== client && tr.insertSet.clients.has(client)) {
				bound = client;
				publish(tr);
			}
			// A suggestion writer this replica minted binds itself, written by itself (`sugg.writer.binding`).
			for (const writer of writersOf(doc))
				if (tr.insertSet.clients.has(writer) && !root.getAttr(`${CLIENT_PREFIX}${writer}`)) {
					doc.clientID = writer;
					try {
						publish(tr);
					} finally {
						doc.clientID = client;
					}
				}
		};
		/** This replica's binding (`c/<clientID>`), and its profile when the stored one differs. */
		const publish = (tr: { changed: Map<unknown, Set<string | null>> }): void => {
			const client = doc.clientID;
			if (root.getAttr(`${CLIENT_PREFIX}${client}`) !== undefined) return;
			root.setAttr(`${CLIENT_PREFIX}${client}`, actor.id);
			// A profile this transaction wrote (`setProfile`) stands.
			const key = `${ACTOR_PREFIX}${actor.id}`;
			if (tr.changed.get(root)?.has(key)) return;
			const next = profileOf(actor);
			const stored = sanitizeProfile(root.getAttr(key));
			if (stored.name !== next.name || stored.color !== next.color) root.setAttr(key, next);
		};
		doc.on('beforeCommit', bind);
		localActors.set(doc, actor.id);

		const setProfile = (profile: ActorProfile): void => {
			if (destroyed) return;
			doc.transact(() => {
				root.setAttr(`${ACTOR_PREFIX}${actor.id}`, sanitizeProfile(profile));
			}, ATTRIBUTION_ORIGIN);
		};

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
			// block records live on the `blockattr` root and `l` on
			// the block node — plain replicated reads, no observer needed.
			block: (blockId) => blockAttributionOf(doc, blockId)
		};

		return {
			view,
			setProfile,
			destroy: () => {
				destroyed = true;
				doc.off('beforeCommit', bind);
				if (localActors.get(doc) === actor.id) localActors.delete(doc);
			}
		};
	};

	return { attach };
};

export type AttributionBinding = ReturnType<typeof bindAttribution>;
