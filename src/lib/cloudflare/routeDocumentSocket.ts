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
 *
 * A plain `GET <room>?lastUpdated` (no upgrade) is the room's probe (H12):
 * authorized the same way, it answers `{ lastUpdated }` as JSON (the room's
 * last stored change, ms since the epoch, or `null`), or `400`, `401` or
 * `403` as an HTTP status. `GET <room>?snapshot` (P8) answers
 * `{ lastUpdated, document }`, the document as JSON, the same way: a view
 * shows it while its own copy hydrates (`<Edytor snapshot>`).
 */
import { CLOSE, validRoomId } from '../crdt/providers/room.js';
import {
	HISTORY_HEADER,
	HISTORY_KEY_HEADER,
	IDENTITY_HEADERS,
	PROBE_HEADER,
	closedSocket,
	parseReplica
} from './DocumentRoom.js';

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

/** The HTTP status a probe (`lastUpdated`, `snapshot`) gets for each refusal a dial is closed with. */
const PROBE_STATUS: Record<number, number> = {
	[CLOSE.invalidDocument]: 400,
	[CLOSE.expired]: 401,
	[CLOSE.denied]: 403
};

/** The replica a client asked for in `?replica=<doc.clientID>` (or `param`), or `null`. */
export const requestedReplica = (request: Request, param = 'replica'): number | null =>
	parseReplica(new URL(request.url).searchParams.get(param));

/**
 * The host's decision: the verified identity, or `refuse`'s answer to the
 * dial or request it turns away (one refusal path for every route).
 */
const authorized = async (
	request: Request,
	documentId: string,
	authorize: AuthorizeDocumentSocket,
	refuse: (code: number, reason: string) => Response
): Promise<DocumentIdentity | Response> => {
	if (!validRoomId(documentId)) {
		return refuse(CLOSE.invalidDocument, 'invalid document id');
	}
	const decision = await authorize(request, documentId);
	if (decision && 'expired' in decision && decision.expired === true) {
		return refuse(CLOSE.expired, 'expired');
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
		return refuse(CLOSE.denied, 'document access denied');
	}
	return identity;
};

/** A refusal as an HTTP status (a probe, a history request). */
const statusOf = (code: number, reason: string): Response =>
	new Response(reason, { status: PROBE_STATUS[code] ?? 403 });

/** The verified identity as the headers the room trusts. */
const identityHeaders = (identity: DocumentIdentity): Headers => {
	const headers = new Headers({
		[IDENTITY_HEADERS.user]: encodeURIComponent(identity.userId),
		[IDENTITY_HEADERS.access]: identity.readOnly ? 'read' : 'write'
	});
	const replica = identity.replica ?? null;
	if (replica !== null) headers.set(IDENTITY_HEADERS.replica, String(replica));
	return headers;
};

/**
 * The host Worker's door to a document's version history (H11),
 * authorized as {@link routeDocumentSocket} authorizes a dial, forwarding
 * only the verified identity:
 *
 * - `GET <url>` → the versions, newest first (`listHistory`), as JSON;
 * - `GET <url>?key=<key>` → that version as JSON (`readHistory`), `404` when
 *   the room holds none;
 * - `POST <url>?restore=<key>` → restore it as a forward edit
 *   (`restoreHistory`, as the verified user), `404` when the room holds none;
 * - `POST <url>?undo` → undo the last restore (`undoRestore`).
 *
 * A refusal is an HTTP status: `400` (an invalid document id), `401`
 * (`{ expired: true }`), `403` (denied, or a read-only identity's
 * restore), `404` (the room keeps no history), `405` (another method).
 */
export async function routeDocumentHistory(
	request: Request,
	rooms: DocumentNamespace,
	documentId: string,
	authorize: AuthorizeDocumentSocket
): Promise<Response> {
	const query = new URL(request.url).searchParams;
	const op =
		request.method === 'GET'
			? query.has('key')
				? 'read'
				: 'list'
			: request.method === 'POST'
				? query.has('restore')
					? 'restore'
					: query.has('undo')
						? 'undo'
						: null
				: null;
	if (op === null) return new Response('method not allowed', { status: 405 });
	const identity = await authorized(request, documentId, authorize, statusOf);
	if (identity instanceof Response) return identity;
	if ((op === 'restore' || op === 'undo') && identity.readOnly) {
		return new Response('read-only', { status: 403 });
	}
	const headers = identityHeaders(identity);
	headers.set(HISTORY_HEADER, op);
	const key = op === 'read' ? query.get('key') : op === 'restore' ? query.get('restore') : null;
	try {
		if (key !== null) headers.set(HISTORY_KEY_HEADER, key);
	} catch {
		return new Response('no such version', { status: 404 }); // no header carries it: no key is one
	}
	return rooms.getByName(documentId).fetch(new Request(request.url, { method: 'GET', headers }));
}

export async function routeDocumentSocket(
	request: Request,
	rooms: DocumentNamespace,
	documentId: string,
	authorize: AuthorizeDocumentSocket
): Promise<Response> {
	// The probes: a plain GET, authorized like a dial, answered with JSON or
	// an HTTP status — `lastUpdated` (H12) and `snapshot` (P8, the document).
	const query = new URL(request.url).searchParams;
	const probe =
		request.method === 'GET' && request.headers.get('Upgrade') === null
			? query.has('snapshot')
				? 'snapshot'
				: query.has('lastUpdated')
					? 'lastUpdated'
					: null
			: null;
	if (
		probe === null &&
		(request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
	) {
		return new Response('WebSocket upgrade required', { status: 426 });
	}
	// One refusal path: a dial gets the close the provider reads, a probe its HTTP status.
	const refuse = (code: number, reason: string): Response =>
		probe !== null ? statusOf(code, reason) : closedSocket(code, reason);
	const identity = await authorized(request, documentId, authorize, refuse);
	if (identity instanceof Response) return identity;
	const headers = identityHeaders(identity);
	if (probe !== null) headers.set(PROBE_HEADER, probe);
	else headers.set('Upgrade', 'websocket');
	return rooms.getByName(documentId).fetch(new Request(request.url, { method: 'GET', headers }));
}
