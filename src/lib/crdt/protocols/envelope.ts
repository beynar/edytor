/**
 * Provider wire envelope — the generation gate.
 *
 * Every provider message (BroadcastChannel room traffic AND websocket
 * frames) is prefixed with one varuint GENERATION word before the
 * y-protocols message type:
 *
 * ```
 *   varuint GENERATION | varuint messageType | payload
 *   GENERATION = PROTOCOL_VERSION * 1000 + SCHEMA_VERSION   (14006 at schema 6)
 * ```
 *
 * The word names the whole generation — engine and wire (the protocol,
 * which implies the v14 engine) and the application schema — so a replica
 * integrates bytes only from writers of its own generation, and a schema
 * bump is a new generation (mixed-schema rooms partition). It is checked
 * before anything is decoded and is fail-closed in every direction: a v13
 * peer's first word is its message type (0..3), a pre-schema v14 peer's is
 * 14, another schema generation's is `14000 + schema`; each is dropped and
 * reported, and a v13 reader finds no handler for ours.
 *
 * IndexedDB containers carry the same generation in their `generation`
 * record (`{engine, protocol, schema}`), verified before any row applies.
 */
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import { SCHEMA_VERSION } from '../edytor-doc.js';

/**
 * Provider protocol generation. Chosen so it can never collide with a v13
 * message type word (0..3) at the same position.
 */
export const PROTOCOL_VERSION = 14;

/** The frame word a build of application schema `schema` writes. */
export const generationWord = (schema: number): number => PROTOCOL_VERSION * 1000 + schema;

/** This build's generation word. */
export const GENERATION = generationWord(SCHEMA_VERSION);

/**
 * Storage-generation prefix for the v14 IndexedDB databases: one database
 * per schema generation, so an earlier generation's store is left as it
 * was beside its successor (and never read).
 */
export const GENERATION_PREFIX = `edytor-v14-g${SCHEMA_VERSION}:`;

/** The IndexedDB name a v14 provider uses for logical document `name`. */
export const generationDbName = (name: string): string => GENERATION_PREFIX + name;

/**
 * Record written to the `custom` store marking a DB as this generation's.
 * Every row of a container holds an update in the engine's one encoding;
 * a snapshot row may be gzip-compressed (`crdt/storage.ts`).
 */
export type GenerationRecord = {
	engine: 'yjs-v14';
	protocol: number;
	schema: number;
};

export const GENERATION_KEY = 'generation';
/** This generation's record. */
export const GENERATION_RECORD: GenerationRecord = {
	engine: 'yjs-v14',
	protocol: PROTOCOL_VERSION,
	schema: SCHEMA_VERSION
};

/** Is `v` this generation's container record? Any other is refused, never read. */
export const isGenerationRecord = (v: unknown): v is GenerationRecord =>
	typeof v === 'object' &&
	v !== null &&
	(v as GenerationRecord).engine === GENERATION_RECORD.engine &&
	(v as GenerationRecord).protocol === GENERATION_RECORD.protocol &&
	(v as GenerationRecord).schema === SCHEMA_VERSION;

export class GenerationMismatchError extends Error {
	constructor(
		public readonly dbName: string,
		public readonly found: unknown
	) {
		super(
			`Stored document "${dbName}" is not a v14 document generation of this schema (found ${JSON.stringify(
				found
			)}). It is never applied — re-import the document from JSON.`
		);
		this.name = 'GenerationMismatchError';
	}
}

/** Tag an outgoing provider message with this build's generation word. */
export const writeProtocolVersion = (encoder: encoding.Encoder): void => {
	encoding.writeVarUint(encoder, GENERATION);
};

/** One provider frame: the generation word, the message type, then `write`'s payload. */
export const frame = (type: number, write: (encoder: encoding.Encoder) => void): Uint8Array =>
	encoding.encode((encoder) => {
		writeProtocolVersion(encoder);
		encoding.writeVarUint(encoder, type);
		write(encoder);
	});

/**
 * Length of a reply that carries nothing: the generation word plus the
 * mirrored message type. Only longer replies are sent — a bare header is a
 * truncated frame that throws in the receiver.
 */
export const BARE_REPLY_LENGTH =
	encoding.encode((e) => encoding.writeVarUint(e, GENERATION)).length + 1;

/**
 * Read and verify the generation word. Returns `true` iff the message is
 * this generation's and the caller may dispatch on the next varuint (the
 * message type). On `false` the caller MUST NOT read further or apply
 * anything.
 */
export const readProtocolVersion = (decoder: decoding.Decoder): boolean =>
	decoding.readVarUint(decoder) === GENERATION;
