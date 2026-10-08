/**
 * Comment threads, client side (WU-34, decision D6; contract rows
 * `comment.*` and `room.comments.rules` of `docs/editor-delete-contract.md`,
 * site `plugins/comments` and `server/comments`):
 *
 * - the one rule every store applies (`decideComment`);
 * - a thread's anchor read from a document (`commentAnchors`), through a
 *   split and a merge;
 * - a client's merged copy (`CommentThreads`): the newest change wins,
 *   whatever order answers, changes and snapshots arrive in;
 * - the default client's requests and the memory client.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	commentAnchors,
	decideComment,
	parseCommentRequest,
	readCommentsMessage,
	writeCommentsChange,
	type CommentChange,
	type CommentThread
} from '$lib/crdt/protocols/comments.js';
import { frame } from '$lib/crdt/protocols/envelope.js';
import { createDecoder, readVarUint } from 'lib0-v14/decoding';
import { readProtocolVersion } from '$lib/crdt/protocols/envelope.js';
import { messageComments } from '$lib/crdt/providers/room.js';
import { CommentThreads } from '$lib/collaboration/comments/threads.js';
import {
	CommentRequestError,
	createCommentsClient,
	createMemoryCommentsClient
} from '$lib/collaboration/comments/client.js';
import { createDocument } from '$lib/crdt/index.js';

const ctx = (thread: CommentThread | null = null, seq = 1) => ({
	thread,
	threads: thread ? 1 : 0,
	now: 1000,
	seq,
	newId: () => 'c-new'
});

const started = (): CommentThread => {
	const outcome = decideComment(
		{ op: 'add', thread: 't1', body: 'First', quote: '  the\n quick  fox ', block: 'p1' },
		{ user: 'ada' },
		ctx()
	);
	if (outcome.status !== 'applied') throw new Error(outcome.status);
	return outcome.change.thread;
};

describe('decideComment — the rule of every store', () => {
	it('add starts a thread with its first comment; the quote is one trimmed line', () => {
		expect(started()).toEqual({
			id: 't1',
			block: 'p1',
			quote: 'the quick fox',
			createdBy: 'ada',
			createdAt: 1000,
			resolved: null,
			comments: [{ id: 'c-new', author: 'ada', body: 'First', createdAt: 1000 }],
			rev: 1
		});
	});

	it('refuses: read-only, a bad id, an empty or long body, a taken id, a missing thread', () => {
		const thread = started();
		const reason = (outcome: ReturnType<typeof decideComment>) =>
			outcome.status === 'refused' ? outcome.reason : outcome.status;
		const add = (body: string, id = 't2') => ({ op: 'add' as const, thread: id, body });
		expect(reason(decideComment(add('x'), { user: 'cy', readOnly: true }, ctx()))).toBe(
			'read-only'
		);
		expect(reason(decideComment(add('x', 'a b'), { user: 'ada' }, ctx()))).toBe('invalid');
		expect(reason(decideComment(add(' \n '), { user: 'ada' }, ctx()))).toBe('invalid');
		expect(reason(decideComment(add('x'.repeat(10_001)), { user: 'ada' }, ctx()))).toBe('invalid');
		expect(reason(decideComment(add('x'), { user: 'ada' }, { ...ctx(), maxLength: 3 }))).toBe(
			'applied'
		);
		expect(reason(decideComment(add('long'), { user: 'ada' }, { ...ctx(), maxLength: 3 }))).toBe(
			'invalid'
		);
		expect(reason(decideComment(add('x', 't1'), { user: 'ada' }, ctx(thread)))).toBe('exists');
		expect(
			reason(decideComment({ op: 'reply', thread: 'nope', body: 'x' }, { user: 'ada' }, ctx()))
		).toBe('missing');
	});

	it('resolve and reopen are anyone’s; a repeat is a noop', () => {
		const thread = started();
		const resolved = decideComment(
			{ op: 'resolve', thread: 't1' },
			{ user: 'bob' },
			ctx(thread, 2)
		);
		expect(resolved).toMatchObject({
			status: 'applied',
			change: {
				type: 'resolved',
				user: 'bob',
				thread: { resolved: { by: 'bob', at: 1000 }, rev: 2 }
			}
		});
		const after = (resolved as { change: CommentChange }).change.thread;
		expect(decideComment({ op: 'resolve', thread: 't1' }, { user: 'ada' }, ctx(after, 3))).toEqual({
			status: 'noop',
			thread: after
		});
		expect(decideComment({ op: 'reopen', thread: 't1' }, { user: 'ada' }, ctx(thread, 3))).toEqual({
			status: 'noop',
			thread
		});
	});

	it('delete: its author or a moderator; the first comment removes the thread', () => {
		const thread = started();
		const replied = decideComment(
			{ op: 'reply', thread: 't1', body: 'Second', comment: 'r1' },
			{ user: 'bob' },
			ctx(thread, 2)
		) as { change: CommentChange };
		const two = replied.change.thread;
		expect(two.comments.map((c) => c.id)).toEqual(['c-new', 'r1']);
		const del = (comment: string | undefined, actor: { user: string; moderator?: boolean }) =>
			decideComment({ op: 'delete', thread: 't1', comment }, actor, ctx(two, 3));
		expect(del('r1', { user: 'ada' })).toMatchObject({ status: 'refused', reason: 'forbidden' });
		expect(del('r1', { user: 'bob' })).toMatchObject({
			status: 'applied',
			change: { type: 'deleted', comment: { id: 'r1' }, thread: { comments: [{ id: 'c-new' }] } }
		});
		expect(del(undefined, { user: 'bob' })).toMatchObject({ reason: 'forbidden' });
		expect(del('c-new', { user: 'ada' })).toMatchObject({ change: { type: 'removed' } });
		expect(del(undefined, { user: 'mod', moderator: true })).toMatchObject({
			change: { type: 'removed', user: 'mod' }
		});
		expect(del('zz', { user: 'ada' })).toMatchObject({ reason: 'missing' });
	});

	it('parses only well-formed requests', () => {
		expect(parseCommentRequest({ op: 'add', thread: 't', body: 'x', extra: 1 })).toEqual({
			op: 'add',
			thread: 't',
			body: 'x'
		});
		expect(parseCommentRequest({ op: 'add', thread: 't' })).toBeNull();
		expect(parseCommentRequest({ op: 'resolve', thread: 3 })).toBeNull();
		expect(parseCommentRequest({ op: 'reply', thread: 't', body: 'x', comment: 4 })).toBeNull();
		expect(parseCommentRequest([])).toBeNull();
		expect(parseCommentRequest({ op: 'delete', thread: 't', comment: 'c' })).toEqual({
			op: 'delete',
			thread: 't',
			comment: 'c'
		});
	});

	it('a change travels as one `messageComments` frame', () => {
		const change: CommentChange = {
			type: 'added',
			thread: started(),
			comment: started().comments[0]!,
			user: 'ada',
			at: 1000,
			seq: 1
		};
		const bytes = frame(messageComments, (e) => writeCommentsChange(e, change));
		const decoder = createDecoder(bytes);
		expect(readProtocolVersion(decoder)).toBe(true);
		expect(readVarUint(decoder)).toBe(messageComments);
		expect(readCommentsMessage(decoder)).toEqual({ type: 'change', change });
	});
});

describe('comment.anchor — a thread is the runs its mark covers', () => {
	const doc = () =>
		createDocument({
			value: {
				children: [
					{ id: 'a', type: 'paragraph', content: [{ text: 'the quick brown fox' }] },
					{ id: 'b', type: 'paragraph', content: [{ text: 'jumps over' }] }
				]
			}
		});

	it('across blocks, in document order; overlapping threads keep their own runs', () => {
		const document = doc();
		const { facade } = document;
		facade.setMark('a', 4, 15, 'comment:t1', { id: 't1' });
		facade.setMark('b', 0, 5, 'comment:t1', { id: 't1' });
		facade.setMark('a', 10, 9, 'comment:t2', { id: 't2' });
		const anchors = commentAnchors(facade);
		expect(anchors.get('t1')).toEqual([
			{ block: 'a', offset: 4, length: 15 },
			{ block: 'b', offset: 0, length: 5 }
		]);
		expect(anchors.get('t2')).toEqual([{ block: 'a', offset: 10, length: 9 }]);
		document.destroy();
	});

	it('survives a split and a merge (the text moves, never copied)', () => {
		const document = doc();
		const { facade } = document;
		facade.setMark('a', 4, 11, 'comment:t1', { id: 't1' }); // "quick brown"
		facade.splitBlock('a', 10, 'a2'); // "the quick " | "brown fox"
		expect(commentAnchors(facade).get('t1')).toEqual([
			{ block: 'a', offset: 4, length: 6 },
			{ block: 'a2', offset: 0, length: 5 }
		]);
		facade.mergeBlocks('a2', 'a');
		expect(commentAnchors(facade).get('t1')).toEqual([{ block: 'a', offset: 4, length: 11 }]);
		// Text typed right after it stays out of it (`exclusive`).
		facade.insertText('a', 15, '!');
		expect(commentAnchors(facade).get('t1')).toEqual([{ block: 'a', offset: 4, length: 11 }]);
		// Its text deleted, a thread has no anchor.
		facade.deleteText('a', 4, 11);
		expect(commentAnchors(facade).get('t1')).toBeUndefined();
		document.destroy();
	});
});

describe('CommentThreads — the newest change wins', () => {
	const thread = (rev: number, body = `v${rev}`): CommentThread => ({
		...started(),
		comments: [{ id: 'c', author: 'ada', body, createdAt: 0 }],
		rev
	});
	const change = (type: CommentChange['type'], seq: number): CommentChange => ({
		type,
		thread: thread(seq),
		comment: null,
		user: 'ada',
		at: 0,
		seq
	});

	it('an older answer never undoes a newer change; a removal stays', () => {
		const threads = new CommentThreads();
		expect(threads.apply(change('added', 1))).toBe(true);
		expect(threads.apply(change('replied', 3))).toBe(true);
		expect(threads.apply(change('resolved', 2))).toBe(false);
		expect(threads.put(thread(2))).toBe(false);
		expect(threads.get('t1')?.rev).toBe(3);
		expect(threads.apply(change('removed', 4))).toBe(true);
		expect(threads.apply(change('replied', 3))).toBe(false);
		expect(threads.get('t1')).toBeUndefined();
		expect(threads.seq).toBe(4);
	});

	it('a snapshot drops what it lacks unless a later change made it', () => {
		const threads = new CommentThreads();
		threads.apply(change('added', 1));
		threads.apply({ ...change('added', 6), thread: { ...thread(6), id: 'late' } });
		expect(threads.snapshot({ seq: 5, threads: [] })).toBe(true);
		expect(threads.list().map((t) => t.id)).toEqual(['late']);
	});
});

describe('createCommentsClient — over HTTP', () => {
	it('GET lists, POST sends JSON; a refusal throws with its status', async () => {
		const calls: Array<{ url: string; method: string; body?: string }> = [];
		const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body as string });
			if (init?.method === 'POST')
				return JSON.parse(String(init.body)).op === 'reply'
					? new Response('no such thread', { status: 404 })
					: Response.json({ status: 'noop', thread: started() });
			return Response.json({ seq: 0, threads: [] });
		}) as typeof globalThis.fetch;
		const client = createCommentsClient({
			server: 'wss://rooms.example/comments/',
			room: 'doc 1',
			params: () => ({ token: 't' }),
			fetch
		});
		expect(await client.list()).toEqual({ seq: 0, threads: [] });
		expect(await client.send({ op: 'resolve', thread: 't1' })).toMatchObject({ status: 'noop' });
		const refused = await client.send({ op: 'reply', thread: 'x', body: 'y' }).catch((e) => e);
		expect(refused).toBeInstanceOf(CommentRequestError);
		expect(refused.status).toBe(404);
		expect(calls.map(({ url, method }) => [method, url])).toEqual([
			['GET', 'https://rooms.example/comments/doc%201?token=t'],
			['POST', 'https://rooms.example/comments/doc%201?token=t'],
			['POST', 'https://rooms.example/comments/doc%201?token=t']
		]);
		expect(JSON.parse(calls[1]!.body!)).toEqual({ op: 'resolve', thread: 't1' });
	});

	it('refuses a room id no request can carry', () => {
		expect(() => createCommentsClient({ server: 'https://x', room: '..' })).toThrow(TypeError);
	});
});

describe('createMemoryCommentsClient', () => {
	it('siblings share the threads; each change reaches every subscriber', async () => {
		const ada = createMemoryCommentsClient({ user: 'ada', now: () => 5 });
		const bob = ada.as('bob');
		const heard: unknown[] = [];
		bob.subscribe!((message) => heard.push(message));
		await vi.waitFor(() => expect(heard).toEqual([{ type: 'snapshot', seq: 0, threads: [] }]));
		const added = await ada.send({ op: 'add', thread: 'm1', body: 'Hi' });
		expect(added.status).toBe('applied');
		await vi.waitFor(() => expect(heard.length).toBe(2));
		expect(heard[1]).toEqual({ type: 'change', change: (added as { change: unknown }).change });
		await expect(bob.send({ op: 'delete', thread: 'm1' })).rejects.toMatchObject({ status: 403 });
		expect((await bob.list()).threads.map((t) => t.createdBy)).toEqual(['ada']);
	});

	it('a removed thread’s anchor marks leave the attached document', async () => {
		const document = createDocument({
			value: { children: [{ id: 'a', type: 'paragraph', content: [{ text: 'hello' }] }] }
		});
		const client = createMemoryCommentsClient({ user: 'ada' });
		client.attach!(document.facade);
		await client.send({ op: 'add', thread: 'm1', body: 'x' });
		document.facade.setMark('a', 0, 5, 'comment:m1', { id: 'm1' });
		expect(commentAnchors(document.facade).get('m1')).toHaveLength(1);
		await client.send({ op: 'delete', thread: 'm1' });
		expect(commentAnchors(document.facade).get('m1')).toBeUndefined();
		expect(document.facade.blockText('a')).toBe('hello');
		document.destroy();
	});
});
