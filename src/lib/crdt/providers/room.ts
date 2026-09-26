/**
 * Room protocol — the transport-agnostic half of the two providers (S1).
 *
 * Both providers join one BroadcastChannel room per document and speak the
 * same enveloped protocol (`protocols/envelope.ts`): the version word, the
 * message-type dispatch, the gated `messageSync` handler, and the
 * awareness publish/query flow are identical between them — this module is
 * their ONE owner. The providers keep only their transport edges:
 * websocket.ts owns the socket lifecycle and the synced-handshake settle
 * window; indexeddb.ts owns the persistence stores.
 *
 * `bindRoomProtocol(syncProtocol, behavior)` is bound once per provider
 * class; the returned handle takes the provider instance on every call.
 * Real per-provider differences stay in the behavior hooks:
 *
 * - `broadcast` — ws sends room traffic on its socket AND the BC channel;
 *   idb's room traffic is BC-only.
 * - `onSyncApplied` — only ws derives `synced` from the SyncStep2
 *   handshake (the `syncSettleMs` ambiguity window); idb's `synced` is the
 *   local-hydration claim made by its own `connectBc` wrapper.
 * - `handlers` — ws adds `messageAuth` (the auth reply exists only on a
 *   server socket — a BC room has no authority to deny).
 *
 * The `failed` emission is the terminal half of the sync contract (D4):
 * exactly once, only while the provider can never reach `synced`.
 */
import * as bc from 'lib0-v14/broadcastchannel';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import {
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	type Awareness,
	type AwarenessUpdate
} from '../protocols/awareness.js';
import type { SyncProtocol } from '../protocols/sync.js';
import {
	PROTOCOL_VERSION,
	readProtocolVersion,
	writeProtocolVersion
} from '../protocols/envelope.js';
// Gate vocabulary via the shared admission doorway (U8) — see admission.ts.
import { checkSchema, SchemaMismatchError, type SchemaProblem } from '../admission.js';
import type { EngineDoc, YDoc } from '../engine-api.js';

export const messageSync = 0;
export const messageAwareness = 1;
export const messageAuth = 2;
export const messageQueryAwareness = 3;

export type ProtocolMismatch = { expected: number; found: number | null };

/**
 * Schema-gate signal detail — emitted on `'schema-mismatch'` (and mirrored
 * through `'message-error'` carrying the {@link SchemaMismatchError}) when a
 * doc's replicated state violates the schema gate:
 *
 * - `unversioned` — replicated registry content without `meta.v` (rogue or
 *   legacy write). The update is QUARANTINED: not persisted, not broadcast,
 *   and never applied to a hydrating doc.
 * - `unsupported` — `meta.v` names a version this build does not speak.
 *   The update is REFUSED at the staging boundary: never applied to the
 *   live doc, never persisted, never rebroadcast (work-unit-3 boundary —
 *   see docs/crdt-v14-providers.md §application-schema boundary).
 */
export type SchemaMismatchDetail = { docName: string; problem: SchemaProblem };

/**
 * What the schema gate needs of a host — the standalone idb helpers
 * (`fetchUpdates`/`storeState`, typed on `IdbPersistenceLike`) satisfy this
 * without being full providers. `emit` is declared in method syntax on
 * purpose: the providers' `ObservableV2.emit` is a generic method whose
 * per-event args carry the concrete provider type — method-style
 * declarations keep the assignability bivariant so `[detail, unknown]`
 * call sites still satisfy it.
 */
export type SchemaGateHost = {
	doc: YDoc;
	/** Last signaled schema-gate state key — dedupes 'schema-mismatch' emits. */
	_schemaGateKey?: string | null;
	emit?(event: 'schema-mismatch', args: [SchemaMismatchDetail, unknown]): void;
	emit?(event: 'message-error', args: [unknown, unknown]): void;
};

/**
 * Emit the schema-gate signal pair: structured `'schema-mismatch'` detail
 * plus the same condition as a {@link SchemaMismatchError} on the generic
 * `'message-error'` channel (so the error channel alone observes every
 * failure mode).
 */
export const emitSchemaProblem = (
	host: SchemaGateHost,
	docName: string,
	problem: SchemaProblem
): void => {
	host.emit?.('schema-mismatch', [{ docName, problem }, host]);
	host.emit?.('message-error', [new SchemaMismatchError(docName, problem), host]);
};

/**
 * Schema gate (gate-2 attack 1a). Two regimes:
 *
 * - `unversioned` — replicated registry content with no `meta.v`. The
 *   update is QUARANTINED: callers must not persist it, broadcast it, or
 *   apply it into a hydrating doc. An uninitialized doc can still carry
 *   engine-level state (a completely untouched doc reads clean — `null`).
 * - `unsupported` — `meta.v` names a version this build does not speak.
 *   Remote updates are REFUSED at the staging boundary before they mutate
 *   the live doc; outbound writes from a doc already in this state are
 *   equally quarantined.
 *
 * Doc-state transitions emit once per problem-state transition — the
 * `kind:version` key dedupes repeat reports of the same state.
 */
export const gateSchema = (host: SchemaGateHost, docName: string): SchemaProblem | null => {
	const problem = checkSchema(host.doc as unknown as EngineDoc);
	const key = problem === null ? null : `${problem.kind}:${problem.version ?? '?'}`;
	if (key !== (host._schemaGateKey ?? null)) {
		host._schemaGateKey = key;
		if (problem !== null) emitSchemaProblem(host, docName, problem);
	}
	return problem;
};

/** What the terminal `failed` signal needs of a host. */
export type FailSignalHost = {
	readonly synced: boolean;
	_failedEmitted?: boolean;
	emit?(event: 'failed', args: [unknown, unknown]): void;
};

/**
 * Terminal `'failed'` emission (the sync-failure contract — D4): fires at
 * most once per provider, only while it can never reach `synced` —
 * destroy-before-sync, a persistence load failure / refused hydration, or
 * a permission-denied auth verdict. Never after `synced === true`, never
 * on a transient (reconnectable) disconnect — those are suppressed here
 * and at the call sites.
 */
export const emitFailed = (host: FailSignalHost, error: unknown): void => {
	if (host._failedEmitted || host.synced) return;
	host._failedEmitted = true;
	host.emit?.('failed', [error, host]);
};

/** One dispatch-table entry: decode `decoder`, write any reply into `encoder`. */
export type RoomMessageHandler<P> = (
	encoder: encoding.Encoder,
	decoder: decoding.Decoder,
	provider: P,
	emitSynced: boolean
) => void;

/** The provider surface the room protocol drives. */
export type RoomProvider<P> = {
	doc: YDoc;
	awareness: Awareness;
	bcconnected: boolean;
	readonly synced: boolean;
	/** Dispatch table — assigned from the bound room handle at construction. */
	messageHandlers: Record<number, RoomMessageHandler<P>>;
	_bcSubscriber: (data: ArrayBuffer, origin: unknown) => void;
	_schemaGateKey?: string | null;
	_failedEmitted?: boolean;
	emit?(event: 'schema-mismatch', args: [SchemaMismatchDetail, unknown]): void;
	emit?(event: 'message-error', args: [unknown, unknown]): void;
	emit?(event: 'protocol-mismatch', args: [ProtocolMismatch, unknown]): void;
	emit?(event: 'failed', args: [unknown, unknown]): void;
};

/** Per-provider hooks — the real differences between the two transports. */
export type RoomBehavior<P> = {
	/** Logical document/room name for `SchemaMismatchDetail` + errors. */
	docName(provider: P): string;
	/** The BroadcastChannel room the provider syncs on. */
	roomChannel(provider: P): string;
	/**
	 * Provider-originated room traffic: ws sends on the socket AND the BC
	 * channel; idb publishes on the BC channel only.
	 */
	broadcast(provider: P, buf: Uint8Array): void;
	/** Extra dispatch entries beyond sync/query-awareness/awareness (ws: auth). */
	handlers?: Record<number, RoomMessageHandler<P>>;
	/**
	 * Post-dispatch hook for an evaluated sync payload (SyncStep2/Update).
	 * ws derives the `synced` handshake + settle window from it; idb leaves
	 * it unset — its `synced` claim is the local-hydration semantic in its
	 * own `connectBc` wrapper.
	 */
	onSyncApplied?(provider: P, syncMessageType: number, applied: boolean, emitSynced: boolean): void;
};

/**
 * Bind the shared room protocol for one provider class. The returned
 * handle owns: message dispatch (`readMessage`/`messageHandlers`), the
 * gated sync handler, awareness message flow, the BC subscriber + the
 * connect/disconnect sequences, and the schema-gate/`failed` helpers.
 */
export const bindRoomProtocol = <P extends RoomProvider<P>>(
	syncProtocol: SyncProtocol,
	behavior: RoomBehavior<P>
) => {
	const gate = (provider: P): SchemaProblem | null =>
		gateSchema(provider, behavior.docName(provider));
	const emitProblem = (provider: P, problem: SchemaProblem): void =>
		emitSchemaProblem(provider, behavior.docName(provider), problem);

	const messageHandlers: Record<number, RoomMessageHandler<P>> = {
		[messageSync]: (encoder, decoder, provider, emitSynced) => {
			encoding.writeVarUint(encoder, messageSync);
			const syncMessageType = decoding.readVarUint(decoder);
			if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
				// State-vector request → reply with our state — but only when
				// our own doc passes the schema boundary: a doc in a
				// schema-problem state must not ship its state to the room.
				if (gate(provider) === null) {
					syncProtocol.readSyncStep1(decoder, encoder, provider.doc);
				}
				return;
			}
			if (
				syncMessageType === syncProtocol.messageYjsSyncStep2 ||
				syncMessageType === syncProtocol.messageYjsUpdate
			) {
				// Staging boundary: the payload is merged into a scratch doc
				// seeded with live state and only integrated when the merged
				// schema record is clean — a refused update never mutates
				// the live doc, is never persisted, never rebroadcast. A
				// corrupt payload inside a VALID v14 envelope surfaces
				// through 'message-error' (gate-2 contract).
				const update = decoding.readVarUint8Array(decoder);
				const { applied, problem } = syncProtocol.applyUpdateStaged(
					provider.doc,
					update,
					provider,
					(error) => provider.emit?.('message-error', [error, provider])
				);
				if (problem !== null) {
					// Refused — reported exactly once per refused payload here;
					// the live doc was untouched so there is nothing to re-gate.
					emitProblem(provider, problem);
				} else if (applied) {
					// The staged verdict was clean, but the live apply could
					// have integrated pending structs carrying a schema write —
					// the one case the post-apply recheck still owns (D24).
					gate(provider);
				}
				behavior.onSyncApplied?.(provider, syncMessageType, applied, emitSynced);
				return;
			}
			// Unknown sync subtype inside a valid envelope — observable.
			provider.emit?.('message-error', [
				new Error(`Unknown sync message type ${syncMessageType}`),
				provider
			]);
		},
		[messageQueryAwareness]: (encoder, _decoder, provider) => {
			encoding.writeVarUint(encoder, messageAwareness);
			encoding.writeVarUint8Array(
				encoder,
				encodeAwarenessUpdate(provider.awareness, Array.from(provider.awareness.getStates().keys()))
			);
		},
		[messageAwareness]: (_encoder, decoder, provider) => {
			applyAwarenessUpdate(provider.awareness, decoding.readVarUint8Array(decoder), provider);
		},
		...behavior.handlers
	};

	/**
	 * Decode one room message. The protocol-version word is verified before
	 * anything else — a foreign message (v13 writer, corrupt frame) is
	 * dropped and reported; its payload is never decoded.
	 */
	const readMessage = (provider: P, buf: Uint8Array, emitSynced: boolean): encoding.Encoder => {
		const decoder = decoding.createDecoder(buf);
		const encoder = encoding.createEncoder();
		if (!readProtocolVersion(decoder)) {
			provider.emit?.('protocol-mismatch', [
				{ expected: PROTOCOL_VERSION, found: buf.length > 0 ? buf[0] : null },
				provider
			]);
			return encoder;
		}
		writeProtocolVersion(encoder);
		const messageType = decoding.readVarUint(decoder);
		const messageHandler = provider.messageHandlers[messageType];
		if (messageHandler) {
			messageHandler(encoder, decoder, provider, emitSynced);
		} else {
			// Fail closed + observable: a VALID v14 envelope carrying a
			// message type no handler claims is still surfaced — protocol
			// skew (a newer peer, a buggy peer) must not be silent
			// (gate-2 attack 1c).
			provider.emit?.('message-error', [
				new Error(`Unknown v14 message type ${messageType}`),
				provider
			]);
		}
		return encoder;
	};

	/**
	 * The BC subscriber: decode a room message, publish a reply only when
	 * the handler actually wrote one. `> 2`: the version envelope makes an
	 * empty reply 2 bytes (version word + mirrored message type), not 1 as
	 * upstream — publishing the bare header produces a truncated frame that
	 * throws in the receiver's readSyncMessage.
	 */
	const bcSubscriber = (provider: P) => {
		return (data: ArrayBuffer, origin: unknown): void => {
			if (origin !== provider) {
				try {
					const encoder = readMessage(provider, new Uint8Array(data), false);
					if (encoding.length(encoder) > 2) {
						bc.publish(behavior.roomChannel(provider), encoding.toUint8Array(encoder), provider);
					}
				} catch (error) {
					// lib0 delivers same-tab publishes synchronously — a malformed
					// message must not propagate into the publisher's call stack
					// (it would surface as a load/connect failure on the peer).
					// Drop it and report instead.
					provider.emit?.('message-error', [error, provider]);
				}
			}
		};
	};

	/**
	 * Local awareness change → room publish. Shared by both providers;
	 * `behavior.broadcast` decides the transports (ws socket + BC / BC only).
	 */
	const awarenessUpdateHandler = (provider: P) => {
		return ({ added, updated, removed }: AwarenessUpdate, _origin: unknown): void => {
			const changedClients = added.concat(updated).concat(removed);
			const encoder = encoding.createEncoder();
			writeProtocolVersion(encoder);
			encoding.writeVarUint(encoder, messageAwareness);
			encoding.writeVarUint8Array(
				encoder,
				encodeAwarenessUpdate(provider.awareness, changedClients)
			);
			behavior.broadcast(provider, encoding.toUint8Array(encoder));
		};
	};

	/**
	 * Encode a local doc update as a sync message and broadcast it to the
	 * room. Callers gate first — a schema-problem doc's updates never leave.
	 */
	const broadcastUpdate = (provider: P, update: Uint8Array): void => {
		const encoder = encoding.createEncoder();
		writeProtocolVersion(encoder);
		encoding.writeVarUint(encoder, messageSync);
		syncProtocol.writeUpdate(encoder, update);
		behavior.broadcast(provider, encoding.toUint8Array(encoder));
	};

	/**
	 * Join the room: subscribe the BC channel and publish SyncStep1 + the
	 * gated SyncStep2 + QueryAwareness + local awareness state. Claiming
	 * `synced` is NOT decided here — ws derives it from the handshake
	 * reply; idb's wrapper claims it (suppressed by its refusal latch).
	 */
	const connectBc = (provider: P): void => {
		const channel = behavior.roomChannel(provider);
		if (!provider.bcconnected) {
			bc.subscribe(channel, provider._bcSubscriber);
			provider.bcconnected = true;
		}
		// Sync initial state — the state-vector request.
		const encoderSync = encoding.createEncoder();
		writeProtocolVersion(encoderSync);
		encoding.writeVarUint(encoderSync, messageSync);
		syncProtocol.writeSyncStep1(encoderSync, provider.doc);
		bc.publish(channel, encoding.toUint8Array(encoderSync), provider);

		// Schema boundary: a doc in a schema-problem state must not ship its
		// state to the room — SyncStep2 is the full-state publish.
		if (gate(provider) === null) {
			const encoderState = encoding.createEncoder();
			writeProtocolVersion(encoderState);
			encoding.writeVarUint(encoderState, messageSync);
			syncProtocol.writeSyncStep2(encoderState, provider.doc);
			bc.publish(channel, encoding.toUint8Array(encoderState), provider);
		}

		// Sync awareness state
		const encoderAwarenessQuery = encoding.createEncoder();
		writeProtocolVersion(encoderAwarenessQuery);
		encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness);
		bc.publish(channel, encoding.toUint8Array(encoderAwarenessQuery), provider);

		const encoderAwarenessState = encoding.createEncoder();
		writeProtocolVersion(encoderAwarenessState);
		encoding.writeVarUint(encoderAwarenessState, messageAwareness);
		encoding.writeVarUint8Array(
			encoderAwarenessState,
			encodeAwarenessUpdate(provider.awareness, [provider.doc.clientID])
		);
		bc.publish(channel, encoding.toUint8Array(encoderAwarenessState), provider);
	};

	/**
	 * Leave the room: notify peers with an awareness removal (routed through
	 * `behavior.broadcast` — ws also sends it on the socket), then
	 * unsubscribe the BC channel.
	 */
	const disconnectBc = (provider: P): void => {
		const encoder = encoding.createEncoder();
		writeProtocolVersion(encoder);
		encoding.writeVarUint(encoder, messageAwareness);
		encoding.writeVarUint8Array(
			encoder,
			encodeAwarenessUpdate(provider.awareness, [provider.doc.clientID], new Map())
		);
		behavior.broadcast(provider, encoding.toUint8Array(encoder));

		if (provider.bcconnected) {
			bc.unsubscribe(behavior.roomChannel(provider), provider._bcSubscriber);
			provider.bcconnected = false;
		}
	};

	return {
		messageHandlers,
		readMessage,
		bcSubscriber,
		awarenessUpdateHandler,
		broadcastUpdate,
		connectBc,
		disconnectBc,
		gateSchema: gate,
		emitSchemaProblem: emitProblem,
		emitFailed: (provider: P, error: unknown) => emitFailed(provider, error)
	};
};
