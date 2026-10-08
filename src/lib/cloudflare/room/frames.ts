/**
 * The frames the room sends, and the decoding of the client's: a throw
 * while reading the client's bytes is theirs (`malformed`), never the
 * room's.
 */
import { READ_ONLY_DENIAL } from '../../crdt/protocols/auth.js';
import * as E from '../../crdt/protocol.js';
import type { AwarenessEntry } from '../../crdt/protocol.js';
import type { YDoc } from '../../crdt/index.js';
import { sync, type Decoded } from './context.js';
import { withoutPending } from './updates.js';

/** The client's bytes do not decode: the only `malformed` refusal. */
export class MalformedFrame extends Error {}

/** Decode the client's bytes: a throw is theirs (`malformed`), not the room's. */
export const decode = <T>(read: () => T): T => {
	try {
		return read();
	} catch (error) {
		throw new MalformedFrame(String(error));
	}
};

/** An awareness frame carrying `entries` — no `Awareness` instance involved. */
export const presenceFrame = (entries: AwarenessEntry[]): Uint8Array =>
	E.frame(E.messageAwareness, (e) => E.writeVarUint8Array(e, E.writeAwarenessEntries(entries)));

/**
 * The store-before-ack frame, sent only once what `doc` holds is stored:
 * its state vector, and the message's `deletes` the room stored (see
 * `Admission.storedDeletes`).
 */
export const savedFrame = (doc: YDoc, deletes?: Decoded['ds']): Uint8Array =>
	E.frame(E.messageSaved, (e) => sync.writeSaved(e, doc, deletes, null));

export const step1Frame = (doc: YDoc): Uint8Array =>
	E.frame(E.messageSync, (e) => sync.writeSyncStep1(e, doc));

export const updateFrame = (update: Uint8Array): Uint8Array =>
	E.frame(E.messageSync, (e) => sync.writeUpdate(e, update));

/** The read-only notice at the join: a state, not a refusal. */
export const readOnlyFrame = (): Uint8Array => E.frame(E.messageAuth, (e) => E.writeReadOnly(e));

/** The denial of a read-only socket's write: it stays, and still syncs. */
export const readOnlyDenialFrame = (): Uint8Array =>
	E.frame(E.messageAuth, (e) => E.writePermissionDenied(e, READ_ONLY_DENIAL));

/** A Step2 of what the room STORED: the engine's pending store (never stored) is left out. */
export const storedStep2 = (doc: YDoc, sv: Uint8Array): Uint8Array =>
	withoutPending(doc, () => E.frame(E.messageSync, (e) => sync.writeSyncStep2(e, doc, sv)));
