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

export const readAuthMessage = (
	decoder: decoding.Decoder,
	y: unknown,
	permissionDeniedHandler: PermissionDeniedHandler
): void => {
	switch (decoding.readVarUint(decoder)) {
		case messagePermissionDenied:
			permissionDeniedHandler(y, decoding.readVarString(decoder));
	}
};
