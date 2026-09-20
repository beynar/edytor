/**
 * Provider wire envelope — the U07 version gate.
 *
 * Every provider message (BroadcastChannel room traffic AND websocket
 * frames) is prefixed with a varuint protocol-version word before the
 * y-protocols message type:
 *
 * ```
 *   varuint PROTOCOL_VERSION | varuint messageType | payload
 * ```
 *
 * `PROTOCOL_VERSION = 14` is deliberately outside the v13 message-type range
 * (0..3). The gate is fail-closed in BOTH directions:
 *
 * - A v13 peer's message starts with its message type (0|1|2|3); a v14
 *   reader decodes that as `version = 0..3 ≠ 14` and drops the message
 *   BEFORE `readSyncMessage` runs — v13 updates can never reach
 *   `applyUpdate` on a v14 doc.
 * - A v14 message starts with `14`; a v13 reader decodes it as message type
 *   14, finds no handler, and drops it ("Unable to compute message") —
 *   v14 updates can never reach a v13 doc either.
 *
 * The word is applied to every message type (sync, awareness, auth,
 * query-awareness): a shared room is a v14 room, not a mixed-protocol one.
 * Awareness payloads remain v13-shaped bytes *inside* the envelope, so a
 * future negotiated presence downgrade could reuse them — but by default a
 * v13 writer to a v14 room is ignored entirely (see docs/crdt-v14-providers).
 */
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';

/**
 * Provider protocol generation. Chosen so it can never collide with a v13
 * message type word (0..3) at the same position.
 */
export const PROTOCOL_VERSION = 14;

/** Storage-generation prefix for the v14 IndexedDB databases. */
export const GENERATION_PREFIX = 'edytor-v14:';

/** The IndexedDB name a v14 provider uses for logical document `name`. */
export const generationDbName = (name: string): string => GENERATION_PREFIX + name;

/** Record written to the `custom` store marking a DB as a v14 generation. */
export type GenerationRecord = {
	engine: 'yjs-v14';
	protocol: number;
};

export const GENERATION_KEY = 'generation';
export const GENERATION_RECORD: GenerationRecord = {
	engine: 'yjs-v14',
	protocol: PROTOCOL_VERSION
};

export class GenerationMismatchError extends Error {
	constructor(
		public readonly dbName: string,
		public readonly found: unknown
	) {
		super(
			`IndexedDB "${dbName}" is not a v14 document generation (found ${JSON.stringify(
				found
			)}). Legacy v13 generations are never applied to a v14 doc — run the migration path instead.`
		);
		this.name = 'GenerationMismatchError';
	}
}

/** Tag an outgoing provider message with the protocol-version word. */
export const writeProtocolVersion = (encoder: encoding.Encoder): void => {
	encoding.writeVarUint(encoder, PROTOCOL_VERSION);
};

/**
 * Read and verify the protocol-version word. Returns `true` iff the message
 * is a v14 provider message and the caller may dispatch on the next varuint
 * (the message type). On `false` the caller MUST NOT read further or apply
 * anything — this is the enforcement boundary for U07.3.
 */
export const readProtocolVersion = (decoder: decoding.Decoder): boolean => {
	return decoding.readVarUint(decoder) === PROTOCOL_VERSION;
};
