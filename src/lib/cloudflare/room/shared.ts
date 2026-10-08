/**
 * The room's shared constants and two helpers every room module reads:
 * the headers the router sets, the transaction origins, the socket tag,
 * the refusal caps and the comment defaults, `noTimers` and
 * `closedSocket`. A leaf: it imports nothing of the room, so the room's
 * modules read it without importing `DocumentRoom.ts` (which re-exports
 * every name here). Worker-safe.
 */

/**
 * Delete ranges the room keeps waiting for items it does not hold (a
 * relayer's delete of an author's edit a restore lost). Every update the
 * engine applies re-reads them, so they are capped.
 */
export const MAX_WAITING_DELETES = 1024;

/** Refusals kept in `refusals` (the newest); `refusalCounts` counts every one. */
export const MAX_REFUSALS = 100;

/** The header `routeDocumentSocket` sets on an authorized probe: `lastUpdated` or `snapshot`. */
export const PROBE_HEADER = 'X-Edytor-Probe';

/** The transaction origin of the room's own edits (`transact`, `onLoad` seeds). */
export const ROOM_ORIGIN = Symbol('edytor-room');

/** The transaction origin of a history restore: the room's restore history tracks it. */
export const RESTORE_ORIGIN = Symbol('edytor-restore');

/** The transaction origin of the room's purge: tracked by no history. */
export const PURGE_ORIGIN = Symbol('edytor-purge');

/** The header `routeDocumentHistory` sets on an authorized history request. */
export const HISTORY_HEADER = 'X-Edytor-History';

/** The version key of a history `read` or `restore` request. */
export const HISTORY_KEY_HEADER = 'X-Edytor-History-Key';

/** The header `routeDocumentComments` sets on an authorized comments request: `list` or `post`. */
export const COMMENTS_HEADER = 'X-Edytor-Comments';

/**
 * Headers carrying the identity `routeDocumentSocket` verified — never the
 * client's. The user id is percent-encoded (`encodeURIComponent`): a header
 * value is trimmed and cannot carry every character, and a user id is any
 * string.
 */
export const IDENTITY_HEADERS = {
	user: 'X-Edytor-User',
	replica: 'X-Edytor-Replica',
	access: 'X-Edytor-Access',
	/** When the credential expires, ms since the epoch (absent: never). */
	expires: 'X-Edytor-Expires'
} as const;

/**
 * An upgrade accepted and closed at once, so the client reads `code`: a
 * browser sees an HTTP error at the upgrade only as `1006`, which a
 * provider cannot tell from a network failure. Refuse a dial your Worker
 * turns away itself with it: the provider stops at `1008` or `4xxx`
 * (except `4401`, redialed), and redials after anything else (`CLOSE`,
 * `isRefusal` in `crdt/providers/room.ts`).
 */
export const closedSocket = (code: number, reason: string): Response => {
	const [client, server] = Object.values(new WebSocketPair());
	server.accept();
	server.close(code, reason);
	return new Response(null, { status: 101, webSocket: client });
};

/** Run an entry point with timers forbidden — a pending timer keeps a Durable Object from hibernating. */
export const noTimers = <T>(fn: () => T): T => {
	const g = globalThis as Record<string, unknown>;
	const saved = [g.setTimeout, g.setInterval];
	const forbidden = () => {
		throw new Error('room scheduled a timer (a Durable Object could not hibernate)');
	};
	g.setTimeout = forbidden;
	g.setInterval = forbidden;
	try {
		return fn();
	} finally {
		[g.setTimeout, g.setInterval] = saved;
	}
};

/** The bytes a room's comments hold at most, by default (4 MiB). */
export const DEFAULT_MAX_COMMENT_BYTES = 4 * 1024 * 1024;

/** Comment requests per second and user (or socket), by default. */
export const DEFAULT_MAX_COMMENT_REQUESTS_PER_SECOND = 2;

/** The tag of the document's sockets: other sockets of the object are left to you. */
export const SOCKET_TAG = 'edytor';
