/**
 * The comments client: what the comments plugin asks of a document's
 * comment threads. Any object with `list` and `send` is a client (an RPC
 * binding, a server route of your own, a stub in tests); `subscribe`, when
 * it has one, delivers the changes other people make. Two are shipped:
 *
 * - {@link createCommentsClient}, the requests `routeDocumentComments`
 *   answers, with the room's changes heard on the document's own socket
 *   (the websocket sync of the same room);
 * - {@link createMemoryCommentsClient}, threads kept in memory under the
 *   same rules as the room's (tests, demos, a document without a room).
 */
import { assertRoomId } from '../../crdt/providers/room.js';
import { providers } from '../../crdt/providers/bound.js';
import {
	COMMENT_MARK,
	COMMENT_STATUS,
	commentAnchors,
	decideComment,
	type CommentActor,
	type CommentAnchorSource,
	type CommentChange,
	type CommentMessage,
	type CommentRequest,
	type CommentSnapshot,
	type CommentThread
} from '../../crdt/protocols/comments.js';

/** What a request did: `applied` (the change) or `noop` (the thread, unchanged). */
export type CommentResult =
	| { status: 'applied'; change: CommentChange }
	| { status: 'noop'; thread: CommentThread };

/** What a client's `subscribe` delivers: every thread (at a (re)connect), or one change. */
export type CommentFeed = Exclude<CommentMessage, { type: 'subscribe' }>;

/** A document's comment threads, as the comments plugin reads and writes them. */
export type CommentsClient = {
	/** Every thread, with the document's last sequence number. */
	list(): Promise<CommentSnapshot>;
	/**
	 * One request (add, reply, resolve, reopen, delete) as the client's
	 * user. A refusal throws a {@link CommentRequestError}.
	 */
	send(request: CommentRequest): Promise<CommentResult>;
	/** Hear the changes anyone makes (and every thread again after a reconnect). Answers the unsubscribe. */
	subscribe?(listener: (message: CommentFeed) => void): () => void;
	/**
	 * The document a view shows, given by the comments plugin when it
	 * mounts: a client whose store has no document of its own (the memory
	 * client) removes a removed thread's anchor marks from it. A room does
	 * that itself: the default client ignores it.
	 */
	attach?(document: CommentDocument): (() => void) | void;
};

/** What a client reads and writes of a document: its blocks' content, and a mark removal. */
export type CommentDocument = CommentAnchorSource & {
	unsetMark(block: string, offset: number, length: number, mark: string): unknown;
	transact<T>(fn: () => T): T;
};

/** Options of {@link createCommentsClient}. */
export type CommentsClientOptions = {
	/**
	 * The base URL of the comments route: requests go to `<server>/<room>`,
	 * the room percent-encoded as one path segment (`ws:`/`wss:` read as
	 * `http:`/`https:`).
	 */
	server: string;
	/** The document's id. */
	room: string;
	/**
	 * The websocket sync's server URL (the `server` of `<Edytor>` or
	 * `createWebsocketSync`), whose socket hears the room's changes. Default:
	 * `server` read as `ws:`/`wss:`.
	 */
	socket?: string;
	/** Query parameters sent with each request (a token): an object, or a function read at every request. */
	params?: Record<string, string> | (() => Record<string, string>);
	/** The fetch to use (default the global one). */
	fetch?: typeof fetch;
};

/** A comments request the server refused: `status` is its HTTP status (`400`, `403`, `404`, `409`…). */
export class CommentRequestError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = 'CommentRequestError';
		this.status = status;
	}
}

/**
 * The default {@link CommentsClient}: the requests `routeDocumentComments`
 * answers (`GET <url>` lists, `POST <url>` sends a request as JSON), and
 * the room's changes heard on the socket of the document's websocket sync
 * (`subscribe`: while a listener is subscribed, that socket asks the room
 * for them). Throws a `TypeError` at once for a room id no request can
 * carry.
 */
export const createCommentsClient = (options: CommentsClientOptions): CommentsClient => {
	assertRoomId(options.room);
	const server = options.server.replace(/\/+$/, '');
	const base = `${server.replace(/^ws/, 'http')}/${encodeURIComponent(options.room)}`;
	const socket = (options.socket ?? server.replace(/^http/, 'ws')).replace(/\/+$/, '');

	const request = async (method: 'GET' | 'POST', body?: unknown): Promise<unknown> => {
		const url = new URL(base);
		const params = typeof options.params === 'function' ? options.params() : options.params;
		for (const [name, value] of Object.entries(params ?? {})) url.searchParams.set(name, value);
		const response = await (options.fetch ?? fetch)(url.toString(), {
			method,
			...(body === undefined
				? {}
				: { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new CommentRequestError(
				response.status,
				`comments of ${options.room}: ${response.status} ${text}`.trim()
			);
		}
		return response.json();
	};

	return {
		list: () => request('GET') as Promise<CommentSnapshot>,
		send: (comment) => request('POST', comment) as Promise<CommentResult>,
		subscribe: (listener) =>
			providers.watchComments(socket, options.room, (message) => {
				if (message.type !== 'subscribe') listener(message);
			})
	};
};

/** Options of {@link createMemoryCommentsClient}. */
export type MemoryCommentsClientOptions = {
	/** The user its requests are made as. */
	user: string;
	/** May delete anyone's comment. */
	moderator?: boolean;
	/** The clock (default `Date.now`). */
	now?: () => number;
};

/** A memory client, and a sibling sharing its threads as another user (`as`). */
export type MemoryCommentsClient = CommentsClient & {
	/** A client of the same threads, as `user`: what one makes, the other hears. */
	as(user: string, options?: { moderator?: boolean }): MemoryCommentsClient;
};

type MemoryStore = {
	threads: Map<string, CommentThread>;
	seq: number;
	listeners: Set<(message: CommentFeed) => void>;
	documents: CommentDocument[];
};

/**
 * Comment threads kept in memory, under the rules the room applies
 * (`decideComment`): for tests, demos and a document without a room. Its
 * siblings (`as(user)`) share the threads; each change reaches every
 * subscriber, asynchronously as over a network. A removed thread's anchor
 * marks leave the last document a plugin attached.
 */
export const createMemoryCommentsClient = (
	options: MemoryCommentsClientOptions
): MemoryCommentsClient => {
	const store: MemoryStore = { threads: new Map(), seq: 0, listeners: new Set(), documents: [] };
	return memoryClient(store, options);
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const memoryClient = (
	store: MemoryStore,
	options: MemoryCommentsClientOptions
): MemoryCommentsClient => {
	const actor: CommentActor = { user: options.user, moderator: options.moderator };
	const now = options.now ?? Date.now;
	return {
		list: async () => clone({ seq: store.seq, threads: [...store.threads.values()] }),
		send: async (request) => {
			const outcome = decideComment(request, actor, {
				thread: store.threads.get(request.thread) ?? null,
				threads: store.threads.size,
				now: now(),
				seq: store.seq + 1
			});
			if (outcome.status === 'refused')
				throw new CommentRequestError(COMMENT_STATUS[outcome.reason], outcome.message);
			if (outcome.status === 'noop') return clone(outcome);
			const { change } = outcome;
			store.seq = change.seq;
			if (change.type === 'removed') {
				store.threads.delete(change.thread.id);
				removeAnchors(store.documents.at(-1), change.thread.id);
			} else store.threads.set(change.thread.id, change.thread);
			for (const listener of [...store.listeners])
				queueMicrotask(() => listener({ type: 'change', change: clone(change) }));
			return clone(outcome);
		},
		subscribe: (listener) => {
			store.listeners.add(listener);
			const snapshot = clone({ seq: store.seq, threads: [...store.threads.values()] });
			queueMicrotask(() => {
				if (store.listeners.has(listener)) listener({ type: 'snapshot', ...snapshot });
			});
			return () => void store.listeners.delete(listener);
		},
		attach: (document) => {
			store.documents.push(document);
			return () => {
				const at = store.documents.lastIndexOf(document);
				if (at >= 0) store.documents.splice(at, 1);
			};
		},
		as: (user, more) => memoryClient(store, { ...options, user, moderator: more?.moderator })
	};
};

/** A removed thread's anchor marks leave `document`, in one transaction. */
const removeAnchors = (document: CommentDocument | undefined, id: string) => {
	const runs = document && commentAnchors(document).get(id);
	if (!document || !runs?.length) return;
	document.transact(() => {
		for (const run of [...runs].reverse())
			document.unsetMark(run.block, run.offset, run.length, `${COMMENT_MARK}:${id}`);
	});
};
