/**
 * Comment threads (decision D6): thread bodies live beside the document,
 * in the room's SQLite (`threads`, `comments`), never in the document; the
 * document holds only each thread's anchor, a `comment:<id>` mark over the
 * text it was made on. This module is the one owner of the rules every
 * store applies (what a valid request is, who may do what, the change it
 * records and its sequence number), of the socket's comment messages, and
 * of reading a thread's anchors from a document. Worker-safe and DOM-free:
 * the room (`edytor/cloudflare`), the default client and the memory client
 * share it.
 */
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';

/** The longest comment body, in UTF-16 code units. */
export const MAX_COMMENT_LENGTH = 10_000;
/** The longest quote a thread keeps of the text it was made on (longer ones are cut). */
export const MAX_QUOTE_LENGTH = 300;
/** Comments one thread holds at most (its first included). */
export const MAX_COMMENTS_PER_THREAD = 500;
/** Threads one document holds at most, resolved ones included. */
export const MAX_THREADS = 5_000;
/** The mark a thread's anchor is: `comment:<thread id>` (a key of its own per thread). */
export const COMMENT_MARK = 'comment';

/** One comment of a thread. */
export type ThreadComment = {
	id: string;
	/** The verified user who wrote it. */
	author: string;
	/** Plain text (line breaks kept). */
	body: string;
	/** ms since the epoch. */
	createdAt: number;
};

/** A comment thread: its first comment starts it, the others reply. */
export type CommentThread = {
	/** The thread's id, which its anchor mark names (`comment:<id>`). */
	id: string;
	/** The block it was started in (`null`: unknown). A hint: the anchor mark is the truth. */
	block: string | null;
	/** The text it was started on, as it read then (at most {@link MAX_QUOTE_LENGTH}). */
	quote: string;
	createdBy: string;
	createdAt: number;
	/** Who resolved it and when; `null` while it is open. */
	resolved: { by: string; at: number } | null;
	/** Oldest first; never empty. */
	comments: ThreadComment[];
	/** The sequence number of the last change to it (a later change has a greater one). */
	rev: number;
};

/** A request to a document's comments, by the user a store verified. */
export type CommentRequest =
	| {
			op: 'add';
			/** The new thread's id (the client's: its anchor mark names it). */
			thread: string;
			body: string;
			quote?: string;
			block?: string | null;
			/** The first comment's id (default: one the store makes). */
			comment?: string;
	  }
	| { op: 'reply'; thread: string; body: string; comment?: string }
	| { op: 'resolve'; thread: string }
	| { op: 'reopen'; thread: string }
	/** Without `comment`, the whole thread; a thread's first comment takes its thread with it. */
	| { op: 'delete'; thread: string; comment?: string };

/** Who asks: a verified user, read-only or not; a moderator may delete anyone's comment. */
export type CommentActor = { user: string; readOnly?: boolean; moderator?: boolean };

/** What one request changed (the room broadcasts it, `onComment` receives it). */
export type CommentChange = {
	/**
	 * `added` a thread, `replied` to one, `resolved` or `reopened` one,
	 * `deleted` a reply, or `removed` a whole thread (its anchor marks go
	 * with it).
	 */
	type: 'added' | 'replied' | 'resolved' | 'reopened' | 'deleted' | 'removed';
	/** The thread after the change; for `removed`, as it was. */
	thread: CommentThread;
	/** The comment added (`added`, `replied`) or deleted (`deleted`), else `null`. */
	comment: ThreadComment | null;
	/** Who made the change. */
	user: string;
	at: number;
	/** The change's sequence number in its document (the thread's new `rev`). */
	seq: number;
};

/** Why a request was refused (each an HTTP status: {@link COMMENT_STATUS}). */
export type CommentRefusal = 'invalid' | 'read-only' | 'forbidden' | 'missing' | 'exists' | 'full';

/** What a request did: `noop` when it changed nothing (resolving a resolved thread). */
export type CommentOutcome =
	| { status: 'applied'; change: CommentChange }
	| { status: 'noop'; thread: CommentThread }
	| { status: 'refused'; reason: CommentRefusal; message: string };

/** The HTTP status of each refusal. */
export const COMMENT_STATUS: Readonly<Record<CommentRefusal, number>> = Object.freeze({
	invalid: 400,
	'read-only': 403,
	forbidden: 403,
	missing: 404,
	exists: 409,
	full: 413
});

/** A thread or comment id: 1 to 64 of `A-Z a-z 0-9 _ -`. */
export const validCommentId = (id: unknown): id is string =>
	typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);

/** A fresh id (a thread's, a comment's): 16 random characters of the id alphabet. */
export const commentId = (): string => {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
};

const OPS = new Set(['add', 'reply', 'resolve', 'reopen', 'delete']);

/** A request read from untrusted JSON, or `null` when it is not one. */
export const parseCommentRequest = (value: unknown): CommentRequest | null => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	if (typeof v.op !== 'string' || !OPS.has(v.op) || typeof v.thread !== 'string') return null;
	const optional = (key: string) => v[key] === undefined || typeof v[key] === 'string';
	if (!optional('comment')) return null;
	switch (v.op) {
		case 'add':
			if (typeof v.body !== 'string' || !optional('quote')) return null;
			if (v.block !== undefined && v.block !== null && typeof v.block !== 'string') return null;
			return {
				op: 'add',
				thread: v.thread,
				body: v.body,
				...(v.quote === undefined ? {} : { quote: v.quote as string }),
				...(v.block === undefined ? {} : { block: v.block as string | null }),
				...(v.comment === undefined ? {} : { comment: v.comment as string })
			};
		case 'reply':
			if (typeof v.body !== 'string') return null;
			return {
				op: 'reply',
				thread: v.thread,
				body: v.body,
				...(v.comment === undefined ? {} : { comment: v.comment as string })
			};
		case 'delete':
			return {
				op: 'delete',
				thread: v.thread,
				...(v.comment === undefined ? {} : { comment: v.comment as string })
			};
		default:
			return { op: v.op as 'resolve' | 'reopen', thread: v.thread };
	}
};

/** What deciding a request reads of its store. */
export type CommentContext = {
	/** The thread the request names, as stored, or `null`. */
	thread: CommentThread | null;
	/** Threads the document holds (for {@link MAX_THREADS}). */
	threads: number;
	/** The clock (ms since the epoch). */
	now: number;
	/** The sequence number the change takes (the store's last one + 1). */
	seq: number;
	/** The longest body (default {@link MAX_COMMENT_LENGTH}; only lowered). */
	maxLength?: number;
	/** A fresh comment id (default {@link commentId}). */
	newId?: () => string;
};

const refuse = (reason: CommentRefusal, message: string): CommentOutcome => ({
	status: 'refused',
	reason,
	message
});

/** A body as stored: line endings `\n`, trailing white space dropped; `null` when nothing is left. */
const bodyOf = (body: string, max: number): string | CommentOutcome => {
	const text = body.replace(/\r\n?/g, '\n').replace(/\s+$/u, '');
	if (text.trim() === '') return refuse('invalid', 'empty comment');
	if (text.length > max) return refuse('invalid', `comment over ${max} characters`);
	return text;
};

/** A quote as stored: one line of white space collapsed, cut at {@link MAX_QUOTE_LENGTH}. */
const quoteOf = (quote: string | undefined): string =>
	(quote ?? '').replace(/\s+/gu, ' ').trim().slice(0, MAX_QUOTE_LENGTH);

/**
 * Decide `request` by `actor`: the one rule of every comment store.
 *
 * - A read-only actor changes nothing (`read-only`).
 * - `add` starts a thread under an id no thread holds (`exists`), with a
 *   first comment; `reply` adds one to a thread (`missing` without it).
 * - `resolve` and `reopen` are anyone's who may write (`noop` when the
 *   thread already is so).
 * - `delete` removes one comment, its author's or a moderator's
 *   (`forbidden`); the first comment, or no `comment`, removes the
 *   whole thread, its creator's or a moderator's.
 *
 * Writes nothing: the store applies the change it returns.
 */
export const decideComment = (
	request: CommentRequest,
	actor: CommentActor,
	context: CommentContext
): CommentOutcome => {
	if (!validCommentId(request.thread)) return refuse('invalid', 'invalid thread id');
	if (actor.readOnly) return refuse('read-only', 'read-only');
	const { thread, now: at, seq } = context;
	const max = Math.min(context.maxLength ?? MAX_COMMENT_LENGTH, MAX_COMMENT_LENGTH);
	const user = actor.user;
	const newComment = (body: string, id: string | undefined): ThreadComment | CommentOutcome => {
		const text = bodyOf(body, max);
		if (typeof text !== 'string') return text;
		if (id !== undefined && !validCommentId(id)) return refuse('invalid', 'invalid comment id');
		return { id: id ?? (context.newId ?? commentId)(), author: user, body: text, createdAt: at };
	};
	const applied = (
		type: CommentChange['type'],
		next: CommentThread,
		comment: ThreadComment | null = null
	): CommentOutcome => ({
		status: 'applied',
		change: { type, thread: next, comment, user, at, seq }
	});

	if (request.op === 'add') {
		if (thread !== null) return refuse('exists', 'thread exists');
		if (context.threads >= MAX_THREADS) return refuse('full', 'too many threads');
		if (request.block != null && (typeof request.block !== 'string' || request.block.length > 256))
			return refuse('invalid', 'invalid block id');
		const comment = newComment(request.body, request.comment);
		if ('status' in comment) return comment;
		return applied(
			'added',
			{
				id: request.thread,
				block: request.block ?? null,
				quote: quoteOf(request.quote),
				createdBy: user,
				createdAt: at,
				resolved: null,
				comments: [comment],
				rev: seq
			},
			comment
		);
	}
	if (thread === null) return refuse('missing', 'no such thread');
	switch (request.op) {
		case 'reply': {
			if (thread.comments.length >= MAX_COMMENTS_PER_THREAD)
				return refuse('full', 'too many comments');
			const comment = newComment(request.body, request.comment);
			if ('status' in comment) return comment;
			if (thread.comments.some(({ id }) => id === comment.id))
				return refuse('exists', 'comment exists');
			return applied(
				'replied',
				{ ...thread, comments: [...thread.comments, comment], rev: seq },
				comment
			);
		}
		case 'resolve':
			if (thread.resolved) return { status: 'noop', thread };
			return applied('resolved', { ...thread, resolved: { by: user, at }, rev: seq });
		case 'reopen':
			if (!thread.resolved) return { status: 'noop', thread };
			return applied('reopened', { ...thread, resolved: null, rev: seq });
		case 'delete': {
			const index =
				request.comment === undefined
					? 0
					: thread.comments.findIndex(({ id }) => id === request.comment);
			if (index < 0) return refuse('missing', 'no such comment');
			const comment = thread.comments[index]!;
			if (comment.author !== user && !actor.moderator)
				return refuse('forbidden', 'only its author deletes a comment');
			if (index === 0) return applied('removed', { ...thread, rev: seq });
			return applied(
				'deleted',
				{ ...thread, comments: thread.comments.filter((_, i) => i !== index), rev: seq },
				comment
			);
		}
	}
};

// ── Anchors ───────────────────────────────────────────────────────────

/** One run of text a thread's anchor mark covers: `length` units from `offset` of `block`. */
export type CommentRun = { block: string; offset: number; length: number };

/** What {@link commentAnchors} reads of a document (its facade). */
export type CommentAnchorSource = {
	/** The visible blocks, in document order. */
	order(): readonly string[];
	/** A block's content: text runs with their marks, inline atoms (one unit each). */
	contentItems(
		id: string
	): ReadonlyArray<
		{ kind: 'text'; text: string; marks?: Record<string, unknown> } | { kind: 'inline' }
	>;
};

/** The thread a mark key anchors (`comment:<id>` → `<id>`), or `null`. */
export const threadOfMark = (key: string): string | null => {
	const prefix = `${COMMENT_MARK}:`;
	if (!key.startsWith(prefix)) return null;
	const id = key.slice(prefix.length);
	return validCommentId(id) ? id : null;
};

/**
 * Every thread's anchor in `doc`: the runs of text its `comment:<id>` mark
 * covers, in document order (adjacent runs of one block joined). A split
 * or a merge moves the marked text, never copies it, so a thread keeps its
 * runs through both; a thread whose marked text was deleted has none.
 */
export const commentAnchors = (doc: CommentAnchorSource): Map<string, CommentRun[]> => {
	const anchors = new Map<string, CommentRun[]>();
	for (const block of doc.order()) {
		let offset = 0;
		for (const item of doc.contentItems(block)) {
			const length = item.kind === 'text' ? item.text.length : 1;
			if (item.kind === 'text' && item.marks) {
				for (const [key, value] of Object.entries(item.marks)) {
					if (value == null || value === false) continue;
					const thread = threadOfMark(key);
					if (thread === null) continue;
					const runs = anchors.get(thread) ?? [];
					const last = runs.at(-1);
					if (last && last.block === block && last.offset + last.length === offset)
						last.length += length;
					else runs.push({ block, offset, length });
					anchors.set(thread, runs);
				}
			}
			offset += length;
		}
	}
	return anchors;
};

// ── The socket's comment messages ─────────────────────────────────────

/** Client → room: start (or stop) hearing the document's comment changes. */
export const commentsSubscribe = 0;
/** Room → client: every thread, and the document's last sequence number (an answer to a subscribe). */
export const commentsSnapshot = 1;
/** Room → client: one change. */
export const commentsChange = 2;

/** The document's threads at sequence number `seq`. */
export type CommentSnapshot = { seq: number; threads: CommentThread[] };

/** A comment message, decoded. */
export type CommentMessage =
	| { type: 'subscribe'; on: boolean }
	| ({ type: 'snapshot' } & CommentSnapshot)
	| { type: 'change'; change: CommentChange };

export const writeCommentsSubscribe = (encoder: encoding.Encoder, on: boolean): void => {
	encoding.writeVarUint(encoder, commentsSubscribe);
	encoding.writeVarUint(encoder, on ? 1 : 0);
};

export const writeCommentsSnapshot = (encoder: encoding.Encoder, snapshot: CommentSnapshot) => {
	encoding.writeVarUint(encoder, commentsSnapshot);
	encoding.writeVarString(encoder, JSON.stringify(snapshot));
};

export const writeCommentsChange = (encoder: encoding.Encoder, change: CommentChange) => {
	encoding.writeVarUint(encoder, commentsChange);
	encoding.writeVarString(encoder, JSON.stringify(change));
};

/** Read one comment message (after its message type); throws on bytes that do not decode. */
export const readCommentsMessage = (decoder: decoding.Decoder): CommentMessage => {
	const type = decoding.readVarUint(decoder);
	if (type === commentsSubscribe)
		return { type: 'subscribe', on: decoding.readVarUint(decoder) === 1 };
	if (type === commentsSnapshot) {
		const snapshot = JSON.parse(decoding.readVarString(decoder)) as CommentSnapshot;
		return { type: 'snapshot', seq: snapshot.seq, threads: snapshot.threads };
	}
	if (type === commentsChange) {
		return { type: 'change', change: JSON.parse(decoding.readVarString(decoder)) as CommentChange };
	}
	throw new Error(`unknown comment message ${type}`);
};
