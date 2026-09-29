/**
 * The host Worker's door to a document's Durable Object (a `DocumentRoom`,
 * or any object with `attachDocument`): authorize BEFORE the
 * upgrade, then forward a fresh request that carries only the verified
 * identity — every header the client sent (cookies, tokens, forged
 * `X-Edytor-*` values) is dropped. The room trusts these headers, so it
 * must be reachable only through this function.
 */
import { IDENTITY_HEADERS, parseReplica } from './DocumentRoom.js';

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

/** The host's decision: an identity, or `null` to refuse (403). */
export type AuthorizeDocumentSocket = (
	request: Request,
	documentId: string
) => DocumentIdentity | null | Promise<DocumentIdentity | null>;

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
	if (!documentId || documentId.length > 256) {
		return new Response('Invalid document identity', { status: 400 });
	}
	const identity = await authorize(request, documentId);
	const replica = identity?.replica ?? null;
	if (
		!identity ||
		typeof identity.userId !== 'string' ||
		!identity.userId ||
		identity.userId.length > 256 ||
		(replica !== null && parseReplica(replica) === null)
	) {
		return new Response('Document access denied', { status: 403 });
	}
	const headers = new Headers({
		Upgrade: 'websocket',
		[IDENTITY_HEADERS.user]: identity.userId,
		[IDENTITY_HEADERS.access]: identity.readOnly ? 'read' : 'write'
	});
	if (replica !== null) headers.set(IDENTITY_HEADERS.replica, String(replica));
	return rooms.getByName(documentId).fetch(new Request(request.url, { method: 'GET', headers }));
}
