/**
 * Auth protocol — port of `@y/protocols@1.0.6-rc.1` `src/auth.js`
 * (MIT © Kevin Jahns — see `src/lib/crdt/vendor/yjs/LICENSE`).
 *
 * The protocol is a single "permission denied" reply; the upstream engine
 * import was JSDoc-only. Here the doc parameter is `unknown` and simply
 * forwarded to the handler — no engine dependency at all.
 */
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';

export const messagePermissionDenied = 0;

export const writePermissionDenied = (encoder: encoding.Encoder, reason: string): void => {
	encoding.writeVarUint(encoder, messagePermissionDenied);
	encoding.writeVarString(encoder, reason);
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
	permissionDeniedHandler: PermissionDeniedHandler
): number => {
	const authMessageType = decoding.readVarUint(decoder);
	switch (authMessageType) {
		case messagePermissionDenied:
			permissionDeniedHandler(y, decoding.readVarString(decoder));
	}
	return authMessageType;
};
