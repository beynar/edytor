/**
 * Sync protocol for the vendored v14 engine — based on
 * `@y/protocols@1.0.6-rc.1` `src/sync.js` (MIT © Kevin Jahns — see
 * `src/lib/crdt/vendor/yjs/LICENSE` for the matching upstream license),
 * with EdytorDoc-aware additions that make it no longer a verbatim port:
 * inbound applies are staged against the application-schema gate
 * (`applyUpdateStaged`/`canApplyDirect`) and stamped with a non-null
 * `remoteApplyOrigin` so echo suppression + undo exclusion keep working.
 *
 * Wire format (unchanged from y-protocols):
 *
 * ```
 *   varuint messageType | payload
 *   messageType 0 (SyncStep1):   varuint8array stateVector
 *   messageType 1 (SyncStep2):   varuint8array update
 *   messageType 2 (Update):      varuint8array update
 * ```
 *
 * The v14 engine emits V1 updates on `doc.on('update')` and decodes V1 via
 * `applyUpdate`, so this is byte-identical to the v13 sync protocol on the
 * wire. That does NOT mean v13 and v14 peers are interchangeable — the
 * provider layer (`providers/*`) wraps every message in the protocol-version
 * envelope (`protocols/envelope.ts`) so engines that do not speak v14 never
 * reach `readSyncMessage`.
 *
 * API boundary — two tiers:
 *
 * - RAW readers (`readSyncStep1`, `readSyncStep2`, `readUpdate`,
 *   `readSyncMessage`) apply payloads DIRECTLY to the live doc — no schema
 *   gate — and `readSyncMessage` THROWS on an unknown message type. They
 *   exist for harnesses/custom transports that gate themselves; the
 *   shipped providers do not route room traffic through them.
 * - The GATED path the providers actually use lives in
 *   `providers/room.ts`: `applyUpdateStaged` + per-type dispatch, so a
 *   refused payload never mutates the live doc and an unknown type is a
 *   reported drop rather than a throw.
 *
 * Engine functions are injected (`bindSync(Y)`): `src/lib` never
 * runtime-imports the vendored `.js` (see `engine-api.ts`), so the caller
 * supplies the module — `import * as Y from 'edytor/crdt'` for package
 * consumers, or the vendored path in tests.
 */
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import { SCHEMA } from '../edytor-doc.js';
// The gate vocabulary comes through the shared admission doorway (U8) —
// the transport layer's staged admission and the document layer's gate
// run the same ordered reads on the same definitions.
import { checkSchema, schemaVersion, type SchemaProblem } from '../admission.js';
import type { EngineApi, EngineDoc, YDoc } from '../engine-api.js';

export type SyncProtocol = ReturnType<typeof bindSync>;

/**
 * Fallback transaction origin for inbound remote applies when the caller
 * does not stamp one (the {@link bindSync} `transactionOrigin` parameter
 * is optional). Remote integration MUST always arrive under a non-null,
 * non-tracked origin:
 *
 * - history capture (`document.history` / `Y.UndoManager`) keeps
 *   untracked, non-local transactions out of the local undo stack — a
 *   `null` origin is ambiguous (it is also the untyped-local marker), so
 *   an explicit marker documents intent for `doc.on('update')`
 *   consumers; and
 * - provider echo suppression (`origin !== this` in the providers'
 *   update handlers) only works when applies carry an origin.
 *
 * The symbol is per-`bindSync` (per engine binding) and is also the
 * DEFAULT whenever `transactionOrigin` is `undefined`/`null` — stamping
 * is therefore a contract the protocol layer keeps even for callers that
 * pass nothing.
 */
const defaultRemoteApplyOrigin = () => Symbol('edytor-remote-apply');

/**
 * Bind the sync protocol to a concrete engine module (the vendored v14 `Y`).
 */
export const bindSync = (Y: EngineApi) => {
	const messageYjsSyncStep1 = 0;
	const messageYjsSyncStep2 = 1;
	const messageYjsUpdate = 2;
	const remoteApplyOrigin = defaultRemoteApplyOrigin();

	const writeSyncStep1 = (encoder: encoding.Encoder, doc: YDoc): void => {
		encoding.writeVarUint(encoder, messageYjsSyncStep1);
		const sv = Y.encodeStateVector(doc);
		encoding.writeVarUint8Array(encoder, sv);
	};

	const writeSyncStep2 = (
		encoder: encoding.Encoder,
		doc: YDoc,
		encodedStateVector?: Uint8Array
	): void => {
		encoding.writeVarUint(encoder, messageYjsSyncStep2);
		encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(doc, encodedStateVector));
	};

	/** Read SyncStep1 message and reply with SyncStep2. */
	const readSyncStep1 = (decoder: decoding.Decoder, encoder: encoding.Encoder, doc: YDoc): void =>
		writeSyncStep2(encoder, doc, decoding.readVarUint8Array(decoder));

	/**
	 * Read and apply structs + delete set to a doc. RAW reader — applies
	 * directly to the live doc with no schema gate (see the module header):
	 * providers route payloads through `applyUpdateStaged` instead.
	 */
	const readSyncStep2 = (
		decoder: decoding.Decoder,
		doc: YDoc,
		transactionOrigin: unknown,
		errorHandler?: (error: Error) => unknown
	): void => {
		try {
			// `?? remoteApplyOrigin` — inbound applies always carry a
			// non-null origin (see the contract at the top of this binding).
			Y.applyUpdate(
				doc,
				decoding.readVarUint8Array(decoder),
				transactionOrigin ?? remoteApplyOrigin
			);
		} catch (error) {
			if (errorHandler != null) errorHandler(error as Error);
			// This catches errors that are thrown by event handlers
			console.error('Caught error while handling a Yjs update', error);
		}
	};

	const writeUpdate = (encoder: encoding.Encoder, update: Uint8Array): void => {
		encoding.writeVarUint(encoder, messageYjsUpdate);
		encoding.writeVarUint8Array(encoder, update);
	};

	const readUpdate = readSyncStep2;

	/**
	 * Fast-path predicate for {@link applyUpdateStaged} (WU5 staging fast
	 * path — the gate-F1 F2 fix): returns true when applying `update`
	 * directly to `doc` is PROVABLY verdict-equivalent to staging it.
	 *
	 * `checkSchema` reads exactly three things — `meta.v`, `meta.schema`
	 * (attr items directly under the `meta` root) and `attrKeys()` on the
	 * `blocks` root (registry emptiness). Only parentSub items DIRECTLY
	 * under a root create/remove attr keys. In the wire format a struct's
	 * `parent` is a string exactly when it integrates under a root type
	 * (roots are not items, so an item ID can never resolve to one), and a
	 * parentSub item whose origin/rightOrigin is set encodes NEITHER parent
	 * NOR parentSub — integrate copies both from its left (or right)
	 * neighbour (`getMissing`). Attr overwrites are exactly that shape, so
	 * the scan resolves parentless structs through their origin chains —
	 * the same update's structs first, then the live store — mirroring the
	 * engine's own resolution. The merged verdict can therefore differ
	 * from the live verdict only when the update:
	 *
	 * - writes ANY item under the `meta` root (version/manifest writes and
	 *   rewrites, plus conservative cover for foreign non-key children), or
	 * - writes a keyed item under the `blocks` root while `meta.v` is
	 *   absent — the only state where registry empty→non-empty flips the
	 *   verdict (clean → `unversioned`). When `meta.v` is present the
	 *   registry's contents cannot affect the verdict, so remote block
	 *   creation fast-paths like every other content update, or
	 * - deletes a LIVE `meta` attr item (a remote undo of `init`, a crafted
	 *   attr delete) — checked by covering the update's delete set against
	 *   the live items' ids. `blocks`-root deletes are never checked here:
	 *   they can only flip registry emptiness, which matters only when
	 *   `meta.v` is absent — and absent-v + non-empty registry is already
	 *   `unversioned`, so a doc in that state never reaches the fast path
	 *   (the checkSchema gate below routes it to full staging), or
	 * - could let PENDING state integrate — a queued `pendingStructs`/
	 *   `pendingDs` tail may carry a schema write that lands as a
	 *   side-effect of this update resolving its missing deps. Staging is
	 *   required whenever pending state exists (rare — only while a peer's
	 *   causal deps are in flight), or
	 * - carries a parentless struct whose parent cannot be resolved here
	 *   (missing dep → the item pends, or a GC'd neighbour → it cannot
	 *   become an attr child; unprovable either way → stage).
	 *
	 * A doc already in a schema-problem state also stays on the staging
	 * path: its merged verdict must be judged per update (refuse, or heal
	 * when the merge resolves clean) exactly as before.
	 *
	 * Undecodable payloads return false — staging owns the corrupt-payload
	 * error path so its observable contract (errorHandler + console.error,
	 * `applied: false`, live doc untouched by decode failures) is byte-for-
	 * byte what it was before. The residual class a clean decode cannot
	 * exclude — a struct that parses but crashes `Item.integrate` — is the
	 * same hole the old path already had (scratch-succeeds/live-crashes):
	 * documented, not widened.
	 */
	const canApplyDirect = (doc: YDoc, update: Uint8Array): boolean => {
		type DecodedStruct = ReturnType<EngineApi['decodeUpdate']>['structs'][number];
		type StructId = { client: number; clock: number };
		type StoredStruct = { id: StructId; length: number };
		const engineDoc = doc as unknown as EngineDoc;
		if (checkSchema(engineDoc) !== null) return false;
		const store = engineDoc.store as
			| (NonNullable<EngineDoc['store']> & {
					clients?: Map<number, StoredStruct[]>;
			  })
			| undefined;
		if (store != null && (store.pendingStructs != null || store.pendingDs != null)) {
			return false;
		}
		let decoded: ReturnType<EngineApi['decodeUpdate']>;
		try {
			decoded = Y.decodeUpdate(update);
		} catch {
			return false;
		}
		const META = SCHEMA.roots.meta;
		const REGISTRY = SCHEMA.roots.registry;
		const metaRoot = engineDoc.get(META);
		const blocksRoot = engineDoc.get(REGISTRY);
		const versioned = schemaVersion(engineDoc) !== undefined;

		// The update's own structs, grouped by client and ascending clock —
		// origin chains are resolved through these first, then the live
		// store (an attr rewrite's left item is always pre-existing).
		const ownStructs = new Map<number, DecodedStruct[]>();
		for (const s of decoded.structs) {
			const arr = ownStructs.get(s.id.client) ?? [];
			arr.push(s);
			ownStructs.set(s.id.client, arr);
		}
		const containing = (structs: StoredStruct[] | undefined, clock: number) => {
			if (structs === undefined) return null;
			let lo = 0;
			let hi = structs.length - 1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				const s = structs[mid];
				if (clock < s.id.clock) hi = mid - 1;
				else if (clock >= s.id.clock + s.length) lo = mid + 1;
				else return s;
			}
			return null;
		};
		const findStruct = (id: StructId): StoredStruct | null =>
			containing(ownStructs.get(id.client), id.clock) ??
			containing(store?.clients?.get(id.client), id.clock);

		/**
		 * Effective root this struct integrates under + effective parentSub
		 * — mirrors `getMissing`: a parentless struct copies left.parent /
		 * left.parentSub (right's when no left), resolved recursively. A
		 * terminating struct's own parentSub is what the whole chain
		 * inherits. Returns `'unknown'` when a dep is unresolvable —
		 * callers stage, matching the engine's pending/unsure outcomes.
		 */
		const resolveRoot = (
			s: DecodedStruct
		): { root: 'meta' | 'blocks' | null; parentSub: unknown } | 'unknown' => {
			let cur: StoredStruct | DecodedStruct = s;
			const seen = new Set<unknown>();
			for (let hops = 0; hops < 128; hops++) {
				if (seen.has(cur)) return 'unknown';
				seen.add(cur);
				const p = (cur as { parent?: unknown }).parent;
				if (p != null) {
					const sub = (cur as { parentSub?: unknown }).parentSub;
					if (p === metaRoot || p === META) return { root: 'meta', parentSub: sub };
					if (p === blocksRoot || p === REGISTRY) return { root: 'blocks', parentSub: sub };
					// Any other parent — a different root name, an item ID,
					// or a nested YNode — can never become a schema attr.
					return { root: null, parentSub: sub };
				}
				const dep =
					(cur as { origin?: StructId | null }).origin ??
					(cur as { rightOrigin?: StructId | null }).rightOrigin;
				if (dep == null)
					return { root: null, parentSub: (cur as { parentSub?: unknown }).parentSub };
				const next = findStruct(dep);
				if (next == null) return 'unknown';
				cur = next;
			}
			return 'unknown';
		};

		for (const s of decoded.structs) {
			// Only Items carry parents — GC/Skip fill clock space only.
			if (!(s instanceof Y.Item)) continue;
			const resolved = resolveRoot(s);
			if (resolved === 'unknown') return false;
			if (resolved.root === 'meta') return false;
			if (!versioned && resolved.root === 'blocks' && resolved.parentSub != null) {
				return false;
			}
		}
		const metaItems = (
			metaRoot as unknown as {
				_map?: Map<string, { id: StructId; deleted: boolean }>;
			}
		)._map;
		if (metaItems !== undefined) {
			for (const item of metaItems.values()) {
				if (!item.deleted && decoded.ds.has(item.id.client, item.id.clock)) return false;
			}
		}
		return true;
	};

	/**
	 * The application-schema boundary for incoming remote updates
	 * (work-unit-3 hardening — see `docs/crdt-v14-providers.md` §boundary).
	 *
	 * `readSyncStep2`/`readUpdate` apply payloads directly to the live doc;
	 * this variant VALIDATES first: the update is merged into a throwaway
	 * staging doc seeded with the live doc's full state, and the merged
	 * `meta.v`/registry record is inspected through `checkSchema`. The update
	 * is integrated into the live doc ONLY when the merged result is clean.
	 *
	 * Why staging (and not per-message schema metadata): BroadcastChannel is
	 * connectionless — there is no handshake to negotiate a session schema,
	 * so every arriving update must be self-validating. Staging also gets the
	 * LWW semantics right for free: a peer's incremental update that carries
	 * no `meta.v` write keeps the staged doc at the live version and applies,
	 * while an update whose merge would move the doc to an unsupported or
	 * unversioned state is refused BEFORE it mutates the live document —
	 * which means it is also never persisted and never rebroadcast (both are
	 * `doc.on('update')`-driven).
	 *
	 * WU5 fast path: {@link canApplyDirect} proves per update whether the
	 * merged verdict can differ from the live one; ordinary content updates
	 * (keystrokes, moves, deletes, remote block creation on a versioned doc)
	 * apply directly at O(update) instead of paying the O(doc) scratch
	 * merge — ~17 ms → ~0.06 ms per inbound update on a 1,000-block doc.
	 * First-contact SyncStep2 full-state payloads are flagged by the scan
	 * (they carry `meta`/`blocks` root writes) and stay staged, exactly as
	 * before; a reconnect SyncStep2 that is a plain content diff fast-paths
	 * — the merged verdict is provably unchanged, so staging could only
	 * repeat the live verdict.
	 *
	 * Returns `{ applied, problem }`: `applied === false` means the update
	 * was refused (schema problem) or failed to apply (corrupt payload —
	 * reported through `errorHandler`); `problem` names the schema verdict
	 * so the caller can emit the structured signal.
	 */
	const applyUpdateStaged = (
		doc: YDoc,
		update: Uint8Array,
		transactionOrigin: unknown,
		errorHandler?: (error: Error) => unknown
	): { applied: boolean; problem: SchemaProblem | null; staged: boolean } => {
		// `?? remoteApplyOrigin` — inbound applies always carry a non-null
		// origin (see the contract at the top of this binding). The scratch
		// doc applies below stay originless: they never commit to a live
		// doc and have no update consumers.
		if (canApplyDirect(doc, update)) {
			try {
				Y.applyUpdate(doc, update, transactionOrigin ?? remoteApplyOrigin);
			} catch (error) {
				if (errorHandler != null) errorHandler(error as Error);
				console.error('Caught error while handling a Yjs update', error);
				return { applied: false, problem: null, staged: false };
			}
			return { applied: true, problem: null, staged: false };
		}
		let problem: SchemaProblem | null;
		try {
			const scratch = new Y.Doc();
			Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
			Y.applyUpdate(scratch, update);
			problem = checkSchema(scratch as unknown as EngineDoc);
		} catch (error) {
			if (errorHandler != null) errorHandler(error as Error);
			// Same visibility as readSyncStep2's catch — a refused/corrupt
			// payload is observable on the console channel too.
			console.error('Caught error while handling a Yjs update', error);
			return { applied: false, problem: null, staged: true };
		}
		if (problem !== null) {
			return { applied: false, problem, staged: true };
		}
		try {
			Y.applyUpdate(doc, update, transactionOrigin ?? remoteApplyOrigin);
		} catch (error) {
			if (errorHandler != null) errorHandler(error as Error);
			console.error('Caught error while handling a Yjs update', error);
			return { applied: false, problem: null, staged: true };
		}
		return { applied: true, problem: null, staged: true };
	};

	/**
	 * Read a sync message from `decoder`; writes any reply (SyncStep2) into
	 * `encoder`. Returns the decoded message type. Callers MUST gate the
	 * protocol-version envelope before invoking this (see `envelope.ts`).
	 * RAW/ungated: payloads apply directly to the live doc and an unknown
	 * message type THROWS — the shipped providers dispatch through
	 * `providers/room.ts` (staged apply + reported drops) instead.
	 */
	const readSyncMessage = (
		decoder: decoding.Decoder,
		encoder: encoding.Encoder,
		doc: YDoc,
		transactionOrigin: unknown,
		errorHandler?: (error: Error) => unknown
	): number => {
		const messageType = decoding.readVarUint(decoder);
		switch (messageType) {
			case messageYjsSyncStep1:
				readSyncStep1(decoder, encoder, doc);
				break;
			case messageYjsSyncStep2:
				readSyncStep2(decoder, doc, transactionOrigin, errorHandler);
				break;
			case messageYjsUpdate:
				readUpdate(decoder, doc, transactionOrigin, errorHandler);
				break;
			default:
				throw new Error('Unknown message type');
		}
		return messageType;
	};

	return {
		messageYjsSyncStep1,
		messageYjsSyncStep2,
		messageYjsUpdate,
		remoteApplyOrigin,
		writeSyncStep1,
		writeSyncStep2,
		readSyncStep1,
		readSyncStep2,
		writeUpdate,
		readUpdate,
		readSyncMessage,
		applyUpdateStaged
	};
};
