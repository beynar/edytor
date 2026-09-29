/**
 * Auth protocol — port of `@y/protocols@1.0.6-rc.1` `src/auth.js`
 * (MIT © Kevin Jahns — see `src/lib/crdt/vendor/yjs/LICENSE`).
 *
 * Upstream's protocol is a single "permission denied" reply (a refused
 * write, with a reason); the edytor room adds a read-only notice (no
 * payload) that it sends a read-only socket when it joins — a statement of
 * access, not a refusal. The upstream engine import was JSDoc-only. Here
 * the doc parameter is `unknown` and simply forwarded to the handler — no
 * engine dependency at all.
 */
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';

export const messagePermissionDenied = 0;

export const writePermissionDenied = (encoder: encoding.Encoder, reason: string): void => {
	encoding.writeVarUint(encoder, messagePermissionDenied);
	encoding.writeVarString(encoder, reason);
};

/** The socket may read but not write: sent when it joins, before any write is refused. */
export const messageReadOnly = 1;

export const writeReadOnly = (encoder: encoding.Encoder): void => {
	encoding.writeVarUint(encoder, messageReadOnly);
};

export type PermissionDeniedHandler = (ydoc: unknown, reason: string) => void;

/**
 * Decode one auth payload. Returns the auth message subtype so the caller
 * can surface unknown subtypes — a valid envelope carrying an auth type we
 * do not speak is protocol skew, and this stack's contract is that skew is
 * reported, not silently dropped (same rule as unknown sync subtypes).
 */
export const readAuthMessage = (
	decoder: decoding.Decoder,
	y: unknown,
	permissionDeniedHandler: PermissionDeniedHandler,
	readOnlyHandler?: (ydoc: unknown) => void
): number => {
	const authMessageType = decoding.readVarUint(decoder);
	switch (authMessageType) {
		case messagePermissionDenied:
			permissionDeniedHandler(y, decoding.readVarString(decoder));
			break;
		case messageReadOnly:
			// Unclaimed, it is returned like any subtype the caller does not speak.
			readOnlyHandler?.(y);
	}
	return authMessageType;
};
