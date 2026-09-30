/**
 * The host Worker's door to a document's Durable Object (a `DocumentRoom`,
 * or any object with `attachDocument`): authorize BEFORE the
 * upgrade, then forward a fresh request that carries only the verified
 * identity — every header the client sent (cookies, tokens, forged
 * `X-Edytor-*` values) is dropped. The room trusts these headers, so it
 * must be reachable only through this function.
 *
 * A denied dial is accepted, then closed with `4403` and a reason: a
 * browser sees an HTTP 403 at the upgrade only as `1006`, which the
 * provider cannot tell from a network failure; `4403` stops it dialing.
 * An expired credential is closed `4401` (`expired`): the provider redials
 * with its `params` read again, so a refreshed token gets in. A document
 * id the room cannot have (`validRoomId`: empty, `.` or `..`, over 256
 * characters, with a lone surrogate) is closed `4400`.
 */
import { CLOSE, validRoomId } from '../crdt/providers/room.js';
import { IDENTITY_HEADERS, closedSocket, parseReplica } from './DocumentRoom.js';

/** A namespace whose objects host a document (`DocumentRoom`, or any object with `attachDocument`). */
export type DocumentNamespace = {
	getByName(name: string): { fetch(request: Request): Promise<Response> };
};

/**
 * What the host verified. `userId` owns every Yjs client id the socket
 * writes under; `replica` is the client's `doc.clientID` (read it from a
 * query parameter with {@link requestedReplica}; omitted, the socket's
 * first presence entry binds it); `readOnly` refuses every write.
 */
export type DocumentIdentity = {
	userId: string;
	replica?: number | null;
	readOnly?: boolean;
};

/**
 * A credential that was valid but has expired: the dial is closed `4401`,
 * which the provider retries with its `params` read again.
 */
export type ExpiredCredential = { expired: true };

/**
 * The host's decision: an identity, `null` to refuse (close `4403`,
 * terminal), or `{ expired: true }` for an expired credential (close
 * `4401`, retried).
 */
export type AuthorizeDocumentSocket = (
	request: Request,
	documentId: string
) =>
	| DocumentIdentity
	| ExpiredCredential
	| null
	| Promise<DocumentIdentity | ExpiredCredential | null>;

/** The replica a client asked for in `?replica=<doc.clientID>` (or `param`), or `null`. */
export const requestedReplica = (request: Request, param = 'replica'): number | null =>
	parseReplica(new URL(request.url).searchParams.get(param));

export async function routeDocumentSocket(
	request: Request,
	rooms: DocumentNamespace,
	documentId: string,
	authorize: AuthorizeDocumentSocket
): Promise<Response> {
	if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
		return new Response('WebSocket upgrade required', { status: 426 });
	}
	if (!validRoomId(documentId)) {
		return closedSocket(CLOSE.invalidDocument, 'invalid document id');
	}
	const decision = await authorize(request, documentId);
	if (decision && 'expired' in decision && decision.expired === true) {
		return closedSocket(CLOSE.expired, 'expired');
	}
	const identity = decision && 'userId' in decision ? decision : null;
	const replica = identity?.replica ?? null;
	if (
		!identity ||
		typeof identity.userId !== 'string' ||
		!identity.userId ||
		identity.userId.length > 256 ||
		// No header, even percent-encoded, carries a lone surrogate.
		/\p{Cs}/u.test(identity.userId) ||
		(replica !== null && parseReplica(replica) === null)
	) {
		return closedSocket(CLOSE.denied, 'document access denied');
	}
	const headers = new Headers({
		Upgrade: 'websocket',
		[IDENTITY_HEADERS.user]: encodeURIComponent(identity.userId),
		[IDENTITY_HEADERS.access]: identity.readOnly ? 'read' : 'write'
	});
	if (replica !== null) headers.set(IDENTITY_HEADERS.replica, String(replica));
	return rooms.getByName(documentId).fetch(new Request(request.url, { method: 'GET', headers }));
}
