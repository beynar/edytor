/**
 * The room's comment threads (`room.comments.*`: threads live beside the document, not in it): the
 * `threads` and `comments` tables, the requests `routeDocumentComments`
 * forwards and the RPC methods, the change broadcast to the sockets that
 * subscribed (`messageComments`), the removal of a removed thread's anchor
 * marks, and the `onComment` hook. The rules themselves (validation, who
 * may do what) are `crdt/protocols/comments.ts`, shared with the clients.
 */
import * as E from '../../crdt/protocol.js';
import {
	COMMENT_MARK,
	COMMENT_ROW_BYTES,
	COMMENT_STATUS,
	commentAnchors,
	decideComment,
	OVER_BYTE_QUOTA,
	parseCommentRequest,
	validCommentId,
	type ThreadComment,
	type CommentActor,
	type CommentChange,
	type CommentOutcome,
	type CommentRequest,
	type CommentSnapshot,
	type CommentThread
} from '../../crdt/protocols/comments.js';
import {
	DEFAULT_MAX_COMMENT_BYTES,
	DEFAULT_MAX_COMMENT_REQUESTS_PER_SECOND,
	SOCKET_TAG,
	noTimers,
	type Attachment,
	type SocketIdentity
} from '../DocumentRoom.js';
import { allowance, type Bucket } from './admission.js';
import { knob, type RoomContext } from './context.js';
import { decode } from './frames.js';

/** The `meta` key holding the comments' last sequence number. */
const SEQ_KEY = 'comments';

/** The largest request body `routeDocumentComments` forwards, in bytes. */
export const MAX_COMMENT_REQUEST_BYTES = 64 * 1024;

/** The users whose request rate the room tracks at once (the oldest is forgotten past it). */
const MAX_RATE_USERS = 1_000;

type ThreadRow = {
	id: string;
	block: string | null;
	quote: string;
	created_by: string;
	created_at: number;
	resolved_by: string | null;
	resolved_at: number | null;
	rev: number;
};
type CommentRow = { id: string; thread: string; author: string; body: string; created_at: number };

const threadOf = (row: ThreadRow, comments: ThreadComment[]): CommentThread => ({
	id: row.id,
	block: row.block,
	quote: row.quote,
	createdBy: row.created_by,
	createdAt: row.created_at,
	resolved:
		row.resolved_by === null
			? null
			: { by: row.resolved_by, at: row.resolved_at ?? row.created_at },
	comments,
	rev: row.rev
});

const commentOf = (row: CommentRow): ThreadComment => ({
	id: row.id,
	author: row.author,
	body: row.body,
	createdAt: row.created_at
});

export class RoomComments {
	private ready = false;
	/** Each verified user's HTTP request allowance (memory: a wake refills it). */
	private readonly users = new Map<string, Bucket>();
	/** Each socket's comment message allowance. */
	private readonly sockets = new WeakMap<WebSocket, Bucket>();

	constructor(private readonly room: RoomContext) {}

	/** Comments are on unless the room's `comments` option is `false`. */
	get enabled(): boolean {
		return this.room.options.comments !== false;
	}

	private ensure() {
		if (this.ready) return;
		const { sql, tables } = this.room;
		sql.exec(
			`CREATE TABLE IF NOT EXISTS ${tables.threads} (
				id TEXT PRIMARY KEY,
				block TEXT,
				quote TEXT NOT NULL,
				created_by TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				resolved_by TEXT,
				resolved_at INTEGER,
				rev INTEGER NOT NULL
			)`
		);
		sql.exec(
			`CREATE TABLE IF NOT EXISTS ${tables.comments} (
				id TEXT NOT NULL,
				thread TEXT NOT NULL,
				author TEXT NOT NULL,
				body TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (thread, id)
			)`
		);
		this.ready = true;
	}

	/**
	 * The comments' last sequence number (`0`: none yet): the one `meta`
	 * keeps, and never below a stored thread's `rev` (a generation cutover
	 * empties `meta` but keeps the threads), so a change always numbers past
	 * every thread a client holds.
	 */
	private seq(): number {
		const { sql, tables } = this.room;
		const kept =
			sql
				.exec<{ value: number }>(`SELECT value FROM ${tables.meta} WHERE key = ?`, SEQ_KEY)
				.toArray()[0]?.value ?? 0;
		const newest =
			sql.exec<{ rev: number | null }>(`SELECT MAX(rev) AS rev FROM ${tables.threads}`).one().rev ??
			0;
		return Math.max(kept, newest);
	}

	/** One thread as stored, or `null`. */
	private read(id: string): CommentThread | null {
		const { sql, tables } = this.room;
		const row = sql
			.exec<ThreadRow>(`SELECT * FROM ${tables.threads} WHERE id = ?`, id)
			.toArray()[0];
		if (!row) return null;
		const comments = sql
			.exec<CommentRow>(`SELECT * FROM ${tables.comments} WHERE thread = ? ORDER BY rowid`, id)
			.toArray()
			.map(commentOf);
		return threadOf(row, comments);
	}

	/**
	 * The bytes the comments hold, as the byte quota counts them
	 * (`commentBytes`: each body and quote in UTF-8, plus a row's cost).
	 */
	private bytes(): number {
		const { sql, tables } = this.room;
		const comments = sql
			.exec<{
				bytes: number | null;
				n: number;
			}>(`SELECT SUM(LENGTH(CAST(body AS BLOB))) AS bytes, COUNT(*) AS n FROM ${tables.comments}`)
			.one();
		const quotes =
			sql
				.exec<{
					bytes: number | null;
				}>(`SELECT SUM(LENGTH(CAST(quote AS BLOB))) AS bytes FROM ${tables.threads}`)
				.one().bytes ?? 0;
		return (comments.bytes ?? 0) + quotes + comments.n * COMMENT_ROW_BYTES;
	}

	/**
	 * Whether `key` (a user over HTTP, a socket) is within the comment
	 * rate; past it the room notes it (`comments`, `quota: 'rate'`).
	 */
	private allow<K>(
		buckets: { get(key: K): Bucket | undefined; set(key: K, bucket: Bucket): unknown },
		key: K,
		user: string
	): boolean {
		const room = this.room;
		const limit = limitsOf(room).maxRequestsPerSecond;
		if (allowance(buckets, key, limit, room.clock())) return true;
		room.note({ reason: 'comments', detail: { user, quota: 'rate', limit } });
		return false;
	}

	/** Every thread, oldest first, with the last sequence number. */
	list(): CommentSnapshot {
		if (!this.enabled) return { seq: 0, threads: [] };
		return noTimers(() => {
			this.ensure();
			const { sql, tables } = this.room;
			const comments = new Map<string, ThreadComment[]>();
			for (const row of sql
				.exec<CommentRow>(`SELECT * FROM ${tables.comments} ORDER BY rowid`)
				.toArray()) {
				const list = comments.get(row.thread) ?? [];
				list.push(commentOf(row));
				comments.set(row.thread, list);
			}
			const threads = sql
				.exec<ThreadRow>(`SELECT * FROM ${tables.threads} ORDER BY created_at, rowid`)
				.toArray()
				.map((row) => threadOf(row, comments.get(row.id) ?? []));
			return { seq: this.seq(), threads };
		});
	}

	/** Store `change` (one SQLite transaction with its sequence number). */
	private store(change: CommentChange) {
		const { sql, tables, ctx } = this.room;
		const { thread, comment, seq } = change;
		ctx.storage.transactionSync(() => {
			switch (change.type) {
				case 'added':
					sql.exec(
						`INSERT INTO ${tables.threads} (id, block, quote, created_by, created_at, resolved_by, resolved_at, rev) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
						thread.id,
						thread.block,
						thread.quote,
						thread.createdBy,
						thread.createdAt,
						seq
					);
					break;
				case 'removed':
					sql.exec(`DELETE FROM ${tables.threads} WHERE id = ?`, thread.id);
					sql.exec(`DELETE FROM ${tables.comments} WHERE thread = ?`, thread.id);
					break;
				default:
					sql.exec(
						`UPDATE ${tables.threads} SET resolved_by = ?, resolved_at = ?, rev = ? WHERE id = ?`,
						thread.resolved?.by ?? null,
						thread.resolved?.at ?? null,
						seq,
						thread.id
					);
			}
			if (comment && (change.type === 'added' || change.type === 'replied')) {
				sql.exec(
					`INSERT INTO ${tables.comments} (id, thread, author, body, created_at) VALUES (?, ?, ?, ?, ?)`,
					comment.id,
					thread.id,
					comment.author,
					comment.body,
					comment.createdAt
				);
			}
			if (comment && change.type === 'deleted') {
				sql.exec(
					`DELETE FROM ${tables.comments} WHERE thread = ? AND id = ?`,
					thread.id,
					comment.id
				);
			}
			sql.exec(`INSERT OR REPLACE INTO ${tables.meta} (key, value) VALUES (?, ?)`, SEQ_KEY, seq);
		});
	}

	/**
	 * One request by `actor` (`room.comments.request`): decided by the
	 * shared rules, stored, sent to every socket that subscribed, its
	 * anchor marks removed when it removed a thread; then `onComment`.
	 */
	async apply(request: CommentRequest, actor: CommentActor): Promise<CommentOutcome> {
		const room = this.room;
		if (!this.enabled) return { status: 'refused', reason: 'missing', message: 'no comments' };
		const outcome = noTimers((): CommentOutcome => {
			this.ensure();
			const { sql, tables } = room;
			const thread = validCommentId(request.thread) ? this.read(request.thread) : null;
			const threads =
				request.op === 'add'
					? sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tables.threads}`).one().n
					: 0;
			const maxBytes = limitsOf(room).maxBytes;
			const decided = decideComment(request, actor, {
				thread,
				threads,
				now: room.clock(),
				seq: this.seq() + 1,
				maxLength: commentsOptions(room).maxLength,
				bytes: request.op === 'add' || request.op === 'reply' ? this.bytes() : undefined,
				maxBytes
			});
			if (decided.status === 'refused' && decided.message === OVER_BYTE_QUOTA)
				room.note({
					reason: 'comments',
					detail: { user: actor.user, quota: 'bytes', limit: maxBytes }
				});
			if (decided.status !== 'applied') return decided;
			this.store(decided.change);
			this.broadcast(decided.change);
			if (decided.change.type === 'removed') this.removeAnchors(decided.change.thread.id);
			room.log({
				edytor: 'comment',
				type: decided.change.type,
				thread: decided.change.thread.id,
				user: actor.user
			});
			return decided;
		});
		if (outcome.status === 'applied') {
			const hook = commentsOptions(room).onComment;
			try {
				await hook?.(outcome.change);
			} catch (error) {
				room.log({ edytor: 'fault', reason: 'internal', detail: `onComment: ${String(error)}` });
			}
		}
		return outcome;
	}

	/** A removed thread's anchor: its marks leave the document, as one room transaction. */
	private removeAnchors(id: string) {
		const room = this.room;
		if (room.live === null || room.busy) return;
		try {
			const runs = commentAnchors(room.facade).get(id);
			if (!runs?.length) return;
			const mark = `${COMMENT_MARK}:${id}`;
			room.transact((facade) => {
				for (const run of [...runs].reverse())
					facade.unsetMark(run.block, run.offset, run.length, mark);
			});
		} catch (error) {
			room.log({ edytor: 'fault', reason: 'internal', detail: `comment anchor: ${String(error)}` });
		}
	}

	/** Send `change` to every socket that subscribed. */
	private broadcast(change: CommentChange) {
		const room = this.room;
		const bytes = E.frame(E.messageComments, (e) => E.writeCommentsChange(e, change));
		for (const ws of room.ctx.getWebSockets(SOCKET_TAG)) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			if ((ws.deserializeAttachment() as Attachment | null)?.comments !== true) continue;
			try {
				room.send(ws, bytes);
				room.counters.fanOut.messages++;
				room.counters.fanOut.bytes += bytes.length;
			} catch {
				// a socket that died mid-broadcast gets its close event
			}
		}
	}

	/**
	 * A socket's comment message (`messageComments`): a subscribe marks its
	 * attachment (it survives hibernation) and is answered with every
	 * thread; an unsubscribe clears it. Any other comment message from a
	 * client is malformed. A subscribe while subscribed answers nothing; a
	 * socket's comment messages past the comment rate are dropped (its
	 * subscription unchanged), the socket stays.
	 */
	onMessage(ws: WebSocket, attachment: Attachment, decoder: E.Decoder) {
		const room = this.room;
		const message = decode(() => E.readCommentsMessage(decoder));
		if (message.type !== 'subscribe') {
			return room.refuse(ws, { reason: 'malformed', detail: `comment message ${message.type}` });
		}
		if (!this.allow(this.sockets, ws, attachment.user)) return;
		const was = attachment.comments === true;
		ws.serializeAttachment({ ...attachment, comments: message.on } satisfies Attachment);
		if (!message.on || was) return;
		const snapshot = this.list();
		room.send(
			ws,
			E.frame(E.messageComments, (e) => E.writeCommentsSnapshot(e, snapshot))
		);
	}

	// ── Over HTTP (`routeDocumentComments`) ─────────────────────────────

	/**
	 * One forwarded request: `list` (every thread, with the last sequence
	 * number), or `post` (a JSON {@link CommentRequest}: the outcome as
	 * JSON, a refusal as its HTTP status). `404` when comments are off.
	 */
	async request(op: string, identity: SocketIdentity, body: string): Promise<Response> {
		if (!this.enabled) return new Response('no comments', { status: 404 });
		const users = this.users;
		if (!users.has(identity.user) && users.size >= MAX_RATE_USERS)
			users.delete(users.keys().next().value!);
		if (!this.allow(users, identity.user, identity.user))
			return new Response('too many comment requests', { status: 429 });
		try {
			if (op === 'list') return Response.json(this.list());
			if (op !== 'post') return new Response('unknown request', { status: 400 });
			let json: unknown;
			try {
				json = JSON.parse(body);
			} catch {
				return new Response('invalid request', { status: 400 });
			}
			const request = parseCommentRequest(json);
			if (request === null) return new Response('invalid request', { status: 400 });
			const outcome = await this.apply(request, {
				user: identity.user,
				readOnly: identity.readOnly
			});
			if (outcome.status === 'refused')
				return new Response(outcome.message, { status: COMMENT_STATUS[outcome.reason] });
			return Response.json(outcome);
		} catch (error) {
			this.room.note({ reason: 'internal', detail: `comments: ${String(error)}` });
			return new Response('room unavailable', { status: 503 });
		}
	}
}

/** The room's `comments` option, resolved (`false`: none). */
const commentsOptions = (room: RoomContext) => {
	const options = room.options.comments;
	return options === false || options === undefined ? {} : options;
};

/** The room's comment quotas, defaults applied. */
const limitsOf = (room: RoomContext) => {
	const options = commentsOptions(room);
	return {
		maxBytes: knob(options.maxBytes, DEFAULT_MAX_COMMENT_BYTES, 128 * 1024 * 1024),
		maxRequestsPerSecond: knob(
			options.maxRequestsPerSecond,
			DEFAULT_MAX_COMMENT_REQUESTS_PER_SECOND,
			1_000
		)
	};
};
