/**
 * Sync protocol for the vendored v14 engine — verbatim port of
 * `@y/protocols@1.0.6-rc.1` `src/sync.js` (MIT © Kevin Jahns — see
 * `src/lib/crdt/vendor/yjs/LICENSE` for the matching upstream license),
 * proven byte-compatible by `vendor-tests/yjs/tests/sync-shim.js`.
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
 * Engine functions are injected (`bindSync(Y)`): `src/lib` never
 * runtime-imports the vendored `.js` (see `engine-api.ts`), so the caller
 * supplies the module — `import * as Y from 'edytor/crdt'` for package
 * consumers, or the vendored path in tests.
 */
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import type { EngineApi, YDoc } from '../engine-api.js';

export type SyncProtocol = ReturnType<typeof bindSync>;

/**
 * Bind the sync protocol to a concrete engine module (the vendored v14 `Y`).
 */
export const bindSync = (Y: EngineApi) => {
	const messageYjsSyncStep1 = 0;
	const messageYjsSyncStep2 = 1;
	const messageYjsUpdate = 2;

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

	/** Read and apply structs + delete set to a doc. */
	const readSyncStep2 = (
		decoder: decoding.Decoder,
		doc: YDoc,
		transactionOrigin: unknown,
		errorHandler?: (error: Error) => unknown
	): void => {
		try {
			Y.applyUpdate(doc, decoding.readVarUint8Array(decoder), transactionOrigin);
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
	 * Read a sync message from `decoder`; writes any reply (SyncStep2) into
	 * `encoder`. Returns the decoded message type. Callers MUST gate the
	 * protocol-version envelope before invoking this (see `envelope.ts`).
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
		writeSyncStep1,
		writeSyncStep2,
		readSyncStep1,
		readSyncStep2,
		writeUpdate,
		readUpdate,
		readSyncMessage
	};
};
