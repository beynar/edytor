/**
 * Sync protocol for the vendored v14 engine — based on
 * `@y/protocols@1.0.6-rc.1` `src/sync.js` (MIT © Kevin Jahns — see
 * `src/lib/crdt/vendor/yjs/LICENSE` for the matching upstream license),
 * with EdytorDoc-aware additions that make it no longer a verbatim port:
 * inbound applies refuse an update that writes a foreign schema stamp
 * (`applyRemote`) and are stamped with a non-null `remoteApplyOrigin` so
 * echo suppression + undo exclusion keep working.
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
 *   `readSyncMessage`) apply through the inbound refusal but report
 *   nothing, and `readSyncMessage` THROWS on an unknown message type. They
 *   exist for harnesses/custom transports; the shipped providers do not
 *   route room traffic through them.
 * - The path the providers use lives in `providers/room.ts`:
 *   `applyRemote` + per-type dispatch, so a refused payload never mutates
 *   the live doc and an unknown type is a reported drop, not a throw.
 *
 * Engine functions are injected (`bindSync(Y)`): `src/lib` never
 * runtime-imports the vendored `.js` (see `engine-api.ts`), so the caller
 * supplies the module — `import * as Y from 'edytor/crdt'` for package
 * consumers, or the vendored path in tests.
 */
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import { SCHEMA, SCHEMA_NAME, SCHEMA_VERSION } from '../edytor-doc.js';
import type { SchemaProblem } from '../admission.js';
import type { EngineApi, EngineDoc, YDoc } from '../engine-api.js';

export type SyncProtocol = ReturnType<typeof bindSync>;

type Id = { client: number; clock: number };
type Attr = { id: Id; deleted: boolean; parentSub?: string | null; left?: Attr | null };
/** A decoded update: its structs and its delete set. */
type Decoded = ReturnType<EngineApi['decodeUpdate']>;
/** An engine id set (a delete set). */
export type IdSet = Decoded['ds'];

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

/** Sync message subtypes (the varuint after `messageSync`). */
export const messageYjsSyncStep1 = 0;
export const messageYjsSyncStep2 = 1;
export const messageYjsUpdate = 2;

/**
 * Bind the sync protocol to a concrete engine module (the vendored v14 `Y`).
 */
export const bindSync = (Y: EngineApi) => {
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
	 * Read and apply structs + delete set to a doc — through the same
	 * inbound refusal as the providers ({@link applyRemote}), which report
	 * a refused stamp; this raw reader reports only decode/apply errors.
	 */
	const readSyncStep2 = (
		decoder: decoding.Decoder,
		doc: YDoc,
		transactionOrigin: unknown,
		errorHandler?: (error: Error) => unknown
	): void => {
		applyRemote(doc, decoding.readVarUint8Array(decoder), transactionOrigin, errorHandler);
	};

	/**
	 * The state-vector coverage test of the join rule: does the encoded
	 * state vector `sv` hold anything `doc` lacks?
	 */
	const lacks = (doc: YDoc, sv: Uint8Array): boolean => {
		const ours = Y.decodeStateVector(Y.encodeStateVector(doc));
		for (const [client, clock] of Y.decodeStateVector(sv)) {
			if ((ours.get(client) ?? 0) < clock) return true;
		}
		return false;
	};

	const writeUpdate = (encoder: encoding.Encoder, update: Uint8Array): void => {
		encoding.writeVarUint(encoder, messageYjsUpdate);
		encoding.writeVarUint8Array(encoder, update);
	};

	const readUpdate = readSyncStep2;

	/**
	 * Inbound refusal (R13, F8): the schema problem `parts` (decoded updates,
	 * judged together) would write, or `null`. The frame already proved its
	 * generation; this catches a same-generation writer forging the stamp —
	 * an attr item under the `meta` root whose value is not this build's
	 * (`v`, `schema`; any other key is foreign), or a stamp left without a
	 * live value: a live stamp deleted and not rewritten, or a new one
	 * written only deleted. An attr overwrite is parentless on the wire: its
	 * key is its origin's (the item it overwrites — in the store, or in
	 * `parts`). An item whose origin is in neither cannot integrate yet and
	 * is judged when it can (see {@link applyRemote}).
	 */
	const foreignStamp = (doc: YDoc, parts: Decoded[]): SchemaProblem | null => {
		const meta = (doc as unknown as EngineDoc).get(SCHEMA.roots.meta) as unknown as {
			_map: Map<string, Attr>;
		};
		const at = ({ client, clock }: Id) => `${client}:${clock}`;
		const deleted = ({ client, clock }: Id) => parts.some((p) => p.ds.has(client, clock));
		const keyOf = new Map<string, unknown>();
		for (const item of meta._map.values()) {
			for (let it: Attr | null | undefined = item; it; it = it.left)
				keyOf.set(at(it.id), it.parentSub);
		}
		const { version, schema } = SCHEMA.metaAttrs;
		const written = new Set<unknown>();
		const rewritten = new Set<unknown>();
		const structs = parts.flatMap((part) => part.structs);
		for (let grew = true; grew; ) {
			grew = false;
			for (const s of structs) {
				if (!(s instanceof Y.Item) || keyOf.has(at(s.id))) continue;
				const key =
					s.parent === SCHEMA.roots.meta ? s.parentSub : s.origin && keyOf.get(at(s.origin));
				if (key == null) continue;
				keyOf.set(at(s.id), key);
				grew = true;
				written.add(key);
				if (deleted(s.id)) continue;
				const value = (s.content as { arr?: unknown[] }).arr?.[0];
				if (key === version && value !== SCHEMA_VERSION) {
					return { kind: 'unsupported', version: value as number };
				}
				if (key !== version && (key !== schema || value !== SCHEMA_NAME)) {
					return { kind: 'foreign', version: SCHEMA_VERSION, schema: value };
				}
				rewritten.add(key);
			}
		}
		// A key that held or gets a stamp must keep a live one.
		for (const key of new Set([...meta._map.keys(), ...written])) {
			const item = meta._map.get(key as string);
			const live = item !== undefined && !item.deleted;
			const kept = live && !deleted(item.id);
			if ((live || written.has(key)) && !kept && !rewritten.has(key)) {
				return key === version
					? { kind: 'unversioned' }
					: { kind: 'foreign', version: SCHEMA_VERSION };
			}
		}
		return null;
	};

	/** What the engine holds pending on `doc` (structs and deletes waiting for a dependency). */
	const held = (doc: YDoc): Decoded[] => {
		const pending = [doc.store.pendingStructs?.update, doc.store.pendingDs];
		return pending.flatMap((bytes) => (bytes ? [Y.decodeUpdateV2(bytes)] : []));
	};

	/**
	 * Apply one inbound update (SyncStep2 / Update payload) to the live doc
	 * under a non-null remote origin — unless it writes a foreign schema
	 * stamp, which is refused before integration and returned as `problem`.
	 *
	 * Admission covers everything the apply can integrate: the update, and
	 * what the engine holds pending that the update may release. An update
	 * that passes alone but releases a pending forged stamp (a write that
	 * arrived before the item it overwrites) is applied after the pending
	 * store is discarded — structs and deletes, never integrated; their
	 * writers' honest parts come back on their next sync, as the state
	 * vector never covered them. The discarded problem is `discarded`.
	 *
	 * `applied === false` with no problem means the payload could not be
	 * decoded or integrated (reported through `errorHandler` + the console).
	 */
	const applyRemote = (
		doc: YDoc,
		update: Uint8Array,
		transactionOrigin: unknown,
		errorHandler?: (error: Error) => unknown
	): { applied: boolean; problem: SchemaProblem | null; discarded?: SchemaProblem } => {
		try {
			const own = Y.decodeUpdate(update);
			const problem = foreignStamp(doc, [own]);
			if (problem !== null) return { applied: false, problem };
			const pending = held(doc);
			const discarded = pending.length > 0 ? foreignStamp(doc, [own, ...pending]) : null;
			if (discarded !== null) {
				const store = doc.store;
				store.pendingStructs = null;
				store.pendingDs = null;
			}
			Y.applyUpdate(doc, update, transactionOrigin ?? remoteApplyOrigin);
			return discarded === null
				? { applied: true, problem: null }
				: { applied: true, problem: null, discarded };
		} catch (error) {
			if (errorHandler != null) errorHandler(error as Error);
			console.error('Caught error while handling a Yjs update', error);
			return { applied: false, problem: null };
		}
	};

	/**
	 * The store-before-ack body (`messageSaved`): `doc`'s state vector, then
	 * — when the acknowledged message carried deletes — the part of
	 * `deletes` that `doc` holds (applied, not pending), as an update with no
	 * structs. A server writes it only after it stored what `doc` integrated,
	 * so it acknowledges structs by state vector and deletes by id, and a
	 * deletion that advanced no clock is acknowledged too. A reader of the
	 * state vector alone ignores the second field; a body without it
	 * acknowledges no deletes.
	 */
	const writeSaved = (encoder: encoding.Encoder, doc: YDoc, deletes?: IdSet): void => {
		encoding.writeVarUint8Array(encoder, Y.encodeStateVector(doc));
		const pending = doc.store.pendingDs;
		const held = deletes && pending ? Y.diffIdSet(deletes, Y.decodeUpdateV2(pending).ds) : deletes;
		if (!held || held.isEmpty()) return;
		const body = new Y.UpdateEncoderV1();
		encoding.writeVarUint(body.restEncoder, 0); // no structs
		Y.writeIdSet(body, held);
		encoding.writeVarUint8Array(encoder, body.toUint8Array());
	};

	/** Read a {@link writeSaved} body: the state vector, and the acknowledged deletes (`null`: none). */
	const readSaved = (
		decoder: decoding.Decoder
	): { stateVector: Uint8Array; deletes: IdSet | null } => ({
		stateVector: decoding.readVarUint8Array(decoder),
		deletes: decoding.hasContent(decoder)
			? Y.decodeUpdate(decoding.readVarUint8Array(decoder)).ds
			: null
	});

	/**
	 * Read a sync message from `decoder`; writes any reply (SyncStep2) into
	 * `encoder`. Returns the decoded message type. Callers MUST gate the
	 * protocol-version envelope before invoking this (see `envelope.ts`).
	 * RAW: payloads apply through the inbound refusal (unreported) and an
	 * unknown message type THROWS — the shipped providers dispatch through
	 * `providers/room.ts` (`applyRemote` + reported drops) instead.
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
		applyRemote,
		lacks,
		writeSaved,
		readSaved
	};
};
