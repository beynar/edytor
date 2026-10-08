/**
 * Comment threads in the room (WU-34, decision D6). Rows `room.comments.*`
 * of `docs/editor-delete-contract.md` and the site's `server/comments`:
 *
 * - the rules (`room.comments.rules`): who adds, replies, resolves,
 *   reopens and deletes, and each refusal's HTTP status;
 * - the store (`room.comments.store`): the `threads` and `comments` tables
 *   and the sequence number in `meta`, kept across a restart;
 * - the socket (`room.comments.socket`): a subscribe is answered with
 *   every thread, then each change reaches the sockets that subscribed
 *   (and only them), through the shipped provider's `watchComments` too;
 * - the anchor (`room.comments.anchor`): a removed thread's `comment:<id>`
 *   marks leave the document, relayed to every client;
 * - the hook (`room.comments.hook`): `onComment` hears each change, and a
 *   throw from it leaves the change standing.
 *
 * Expected values come from the contract rows and the site pages.
 */
import { env } from 'cloudflare:workers';
import { SELF, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type {
	CommentChange,
	CommentMessage,
	CommentSnapshot,
	CommentThread
} from '../../src/lib/crdt/protocol.js';
import { E, ORIGIN, RawClient, SelfWebSocket, crdt, para, readFacade } from './client';
import type { CommentRoom } from './worker';

declare global {
	namespace Cloudflare {
		interface Env {
			COMMENTS: DurableObjectNamespace<CommentRoom>;
		}
	}
}

const stub = (room: string) => env.COMMENTS.getByName(room);
const inRoom = <T>(room: string, fn: (r: CommentRoom, state: DurableObjectState) => T) =>
	runInDurableObject(stub(room), (r: CommentRoom, state) => fn(r, state));

type Who = { user?: string; access?: 'read' | 'write' };

const url = (room: string, who: Who = {}) => {
	const query = new URLSearchParams();
	if (who.user) query.set('user', who.user);
	if (who.access) query.set('access', who.access);
	return `${ORIGIN}/comments/${encodeURIComponent(room)}${query.size ? `?${query}` : ''}`;
};

const list = async (room: string, who: Who = { user: 'ada' }) => {
	const response = await SELF.fetch(url(room, who));
	expect(response.status).toBe(200);
	return (await response.json()) as CommentSnapshot;
};

const post = (room: string, body: unknown, who: Who = { user: 'ada' }) =>
	SELF.fetch(url(room, who), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});

/** POST and read the outcome (`200` expected). */
const ok = async (room: string, body: unknown, who: Who = { user: 'ada' }) => {
	const response = await post(room, body, who);
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()) as
		| { status: 'applied'; change: CommentChange }
		| { status: 'noop'; thread: CommentThread };
};

const changeOf = async (room: string, body: unknown, who: Who = { user: 'ada' }) => {
	const outcome = await ok(room, body, who);
	expect(outcome.status).toBe('applied');
	return (outcome as { change: CommentChange }).change;
};

const add = (room: string, thread: string, body = 'Is this right?', who: Who = { user: 'ada' }) =>
	changeOf(room, { op: 'add', thread, body, quote: 'the quick fox', block: 'p1' }, who);

describe('room.comments.rules — over HTTP', () => {
	it('a thread starts with its first comment, by the verified user', async () => {
		const room = 'comments-rules-add';
		expect(await list(room)).toEqual({ seq: 0, threads: [] });
		const change = await add(room, 't1');
		expect(change).toMatchObject({
			type: 'added',
			user: 'ada',
			seq: 1,
			comment: { author: 'ada', body: 'Is this right?' },
			thread: {
				id: 't1',
				block: 'p1',
				quote: 'the quick fox',
				createdBy: 'ada',
				resolved: null,
				rev: 1
			}
		});
		expect(change.thread.comments).toEqual([change.comment]);
		const { seq, threads } = await list(room, { user: 'bob' });
		expect(seq).toBe(1);
		expect(threads).toEqual([change.thread]);
	});

	it('anyone who may write replies, resolves and reopens; a repeat is a noop', async () => {
		const room = 'comments-rules-flow';
		await add(room, 't1');
		const reply = await changeOf(
			room,
			{ op: 'reply', thread: 't1', body: '  Yes.\r\nSure  ' },
			{ user: 'bob' }
		);
		expect(reply).toMatchObject({ type: 'replied', seq: 2, comment: { author: 'bob' } });
		// Line endings are `\n`, trailing white space dropped (leading kept).
		expect(reply.comment!.body).toBe('  Yes.\nSure');
		expect(reply.thread.comments.map((c) => c.author)).toEqual(['ada', 'bob']);
		const resolved = await changeOf(room, { op: 'resolve', thread: 't1' }, { user: 'bob' });
		expect(resolved.type).toBe('resolved');
		expect(resolved.thread.resolved).toEqual({ by: 'bob', at: resolved.at });
		const again = await ok(room, { op: 'resolve', thread: 't1' });
		expect(again).toEqual({ status: 'noop', thread: resolved.thread });
		const reopened = await changeOf(room, { op: 'reopen', thread: 't1' });
		expect(reopened).toMatchObject({ type: 'reopened', seq: 4, thread: { resolved: null } });
		expect((await ok(room, { op: 'reopen', thread: 't1' })).status).toBe('noop');
	});

	it('a comment is deleted by its author; the first comment takes its thread', async () => {
		const room = 'comments-rules-delete';
		await add(room, 't1');
		const reply = await changeOf(room, { op: 'reply', thread: 't1', body: 'No' }, { user: 'bob' });
		const id = reply.comment!.id;
		expect((await post(room, { op: 'delete', thread: 't1', comment: id })).status).toBe(403);
		const deleted = await changeOf(
			room,
			{ op: 'delete', thread: 't1', comment: id },
			{ user: 'bob' }
		);
		expect(deleted).toMatchObject({ type: 'deleted', comment: { id, author: 'bob' } });
		expect(deleted.thread.comments.map((c) => c.author)).toEqual(['ada']);
		// Another user's thread: refused; its creator's: removed.
		expect((await post(room, { op: 'delete', thread: 't1' }, { user: 'bob' })).status).toBe(403);
		const removed = await changeOf(room, { op: 'delete', thread: 't1' });
		expect(removed).toMatchObject({ type: 'removed', comment: null, thread: { id: 't1' } });
		expect((await list(room)).threads).toEqual([]);
		expect((await post(room, { op: 'reply', thread: 't1', body: 'x' })).status).toBe(404);
		expect((await post(room, { op: 'delete', thread: 't1' })).status).toBe(404);
	});

	it('refusals are HTTP statuses: 400, 403, 404, 405, 409, 413, 401', async () => {
		const room = 'comments-rules-refusals';
		await add(room, 't1');
		const status = async (body: unknown, who?: Who) => (await post(room, body, who)).status;
		expect(await status('{not json')).toBe(400);
		expect(await status({ op: 'add', thread: 't2' })).toBe(400); // no body
		expect(await status({ op: 'add', thread: 't2', body: '   ' })).toBe(400); // empty
		expect(await status({ op: 'add', thread: 'not an id!', body: 'x' })).toBe(400);
		expect(await status({ op: 'add', thread: 't2', body: 'x'.repeat(10_001) })).toBe(400);
		expect(await status({ op: 'move', thread: 't1' })).toBe(400);
		expect(await status({ op: 'add', thread: 't1', body: 'again' })).toBe(409);
		expect(await status({ op: 'reply', thread: 'nope', body: 'x' })).toBe(404);
		expect(await status({ op: 'delete', thread: 't1', comment: 'nope' })).toBe(404);
		expect(await status({ op: 'resolve', thread: 't1' }, { user: 'cy', access: 'read' })).toBe(403);
		expect(await status({ op: 'resolve', thread: 't1' }, { user: 'denied' })).toBe(403);
		expect(await status({ op: 'resolve', thread: 't1' }, { user: 'expired' })).toBe(401);
		const big = JSON.stringify({ op: 'add', thread: 't3', body: 'x', quote: 'q'.repeat(70_000) });
		expect(await status(big)).toBe(413);
		expect((await SELF.fetch(url(room, { user: 'ada' }), { method: 'PUT' })).status).toBe(405);
		// A read-only identity lists.
		expect((await list(room, { user: 'cy', access: 'read' })).threads.map((t) => t.id)).toEqual([
			't1'
		]);
		// Nothing refused changed anything.
		expect((await list(room)).seq).toBe(1);
	});

	it('a room with comments off answers 404', async () => {
		const room = 'comments-off-room';
		expect((await SELF.fetch(url(room, { user: 'ada' }))).status).toBe(404);
		expect((await post(room, { op: 'add', thread: 't1', body: 'x' })).status).toBe(404);
	});
});

describe('room.comments.store', () => {
	it('threads and comments are rows of `threads` and `comments`, kept across a restart', async () => {
		const room = 'comments-store-restart';
		await add(room, 't1');
		await changeOf(room, { op: 'reply', thread: 't1', body: 'two' }, { user: 'bob' });
		await add(room, 't2', 'other');
		const before = await list(room);
		const tables = await inRoom(room, (_r, state) =>
			state.storage.sql
				.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
				.toArray()
				.map(({ name }) => name)
		);
		expect(tables).toEqual(expect.arrayContaining(['threads', 'comments']));
		const meta = await inRoom(
			room,
			(_r, state) =>
				state.storage.sql
					.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'comments'")
					.one().value
		);
		expect(meta).toBe(3);
		await evictDurableObject(stub(room));
		expect(await list(room)).toEqual(before);
		expect(before.threads.map((t) => [t.id, t.comments.length, t.rev])).toEqual([
			['t1', 2, 2],
			['t2', 1, 3]
		]);
	});

	it('a change numbers past every stored thread, `meta` emptied too (a generation cutover)', async () => {
		const room = 'comments-store-seq';
		await add(room, 't1');
		await changeOf(room, { op: 'reply', thread: 't1', body: 'two' }, { user: 'bob' });
		await inRoom(room, (_r, state) =>
			state.storage.sql.exec("DELETE FROM meta WHERE key = 'comments'")
		);
		const next = await changeOf(room, { op: 'resolve', thread: 't1' });
		expect(next.seq).toBe(3);
		expect((await list(room)).seq).toBe(3);
	});

	it('over RPC: `comment` as a verified user, a moderator deletes anyone’s comment', async () => {
		const room = 'comments-store-rpc';
		const added = await stub(room).comment(
			{ op: 'add', thread: 'r1', body: 'from rpc' },
			{ user: 'ada' }
		);
		expect(added.status).toBe('applied');
		expect(await stub(room).comment({ op: 'delete', thread: 'r1' }, { user: 'bob' })).toMatchObject(
			{ status: 'refused', reason: 'forbidden' }
		);
		expect(
			await stub(room).comment({ op: 'delete', thread: 'r1' }, { user: 'mod', moderator: true })
		).toMatchObject({ status: 'applied', change: { type: 'removed', user: 'mod' } });
		expect(await stub(room).listComments()).toEqual({ seq: 2, threads: [] });
	});
});

describe('room.comments.socket', () => {
	it('a subscribed socket hears every thread, then each change; another socket nothing', async () => {
		const room = 'comments-socket-feed';
		await add(room, 't1');
		const listener = await RawClient.connect(room, undefined, { user: 'bob' });
		const quiet = await RawClient.connect(room, undefined, { user: 'cy' });
		await vi.waitFor(() => expect(listener.synced && quiet.synced).toBe(true));
		listener.subscribeComments();
		await vi.waitFor(() => expect(listener.comments.length).toBe(1));
		const [snapshot] = listener.comments as Array<Extract<CommentMessage, { type: 'snapshot' }>>;
		expect(snapshot.type).toBe('snapshot');
		expect(snapshot.seq).toBe(1);
		expect(snapshot.threads.map((t) => t.id)).toEqual(['t1']);
		const reply = await changeOf(room, { op: 'reply', thread: 't1', body: 'heard?' });
		await vi.waitFor(() => expect(listener.comments.length).toBe(2));
		expect(listener.comments[1]).toEqual({ type: 'change', change: reply });
		// Unsubscribed, it hears nothing more.
		listener.subscribeComments(false);
		await vi.waitFor(async () =>
			expect(
				await inRoom(room, (_r, state) =>
					state
						.getWebSockets()
						.map((ws) => (ws.deserializeAttachment() as { comments?: boolean }).comments)
				)
			).not.toContain(true)
		);
		await changeOf(room, { op: 'resolve', thread: 't1' });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(listener.comments.length).toBe(2);
		expect(quiet.comments).toEqual([]);
		expect(quiet.closed).toBeNull();
		listener.close();
		quiet.close();
	});

	it('a read-only socket subscribes too; another comment message is malformed', async () => {
		const room = 'comments-socket-read';
		const reader = await RawClient.connect(room, undefined, { user: 'cy', access: 'read' });
		await vi.waitFor(() => expect(reader.readOnly).toBe(true));
		reader.subscribeComments();
		await vi.waitFor(() =>
			expect(reader.comments).toEqual([{ type: 'snapshot', seq: 0, threads: [] }])
		);
		const forger = await RawClient.connect(room, undefined, { user: 'eve' });
		forger.send(
			E.frame(E.messageComments, (e) => E.writeCommentsSnapshot(e, { seq: 99, threads: [] }))
		);
		await vi.waitFor(() => expect(forger.closed?.code).toBe(1008));
		reader.close();
	});

	it('the shipped provider subscribes while a room has a listener (`watchComments`)', async () => {
		const room = 'comments-socket-provider';
		const server = `${ORIGIN.replace('https', 'wss')}/rooms`;
		const document = E.createDocument({ value: { children: [para('p', 'hi')] } });
		const heard: CommentMessage[] = [];
		const unwatch = crdt.providers.watchComments(server, room, (message) => heard.push(message));
		const provider = new crdt.providers.WebsocketProvider(server, room, document.doc, {
			awareness: document.awareness,
			WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
			disableBc: true,
			params: { user: 'ada' }
		});
		await vi.waitFor(() => expect(heard).toEqual([{ type: 'snapshot', seq: 0, threads: [] }]));
		const change = await add(room, 'w1');
		await vi.waitFor(() => expect(heard.at(-1)).toEqual({ type: 'change', change }));
		// The last listener gone, the room is told to stop.
		unwatch();
		await vi.waitFor(async () =>
			expect(
				await inRoom(room, (_r, state) =>
					state
						.getWebSockets()
						.some((ws) => (ws.deserializeAttachment() as { comments?: boolean }).comments)
				)
			).toBe(false)
		);
		provider.destroy();
		document.destroy();
	});
});

describe('room.comments.anchor', () => {
	it('a removed thread’s `comment:<id>` marks leave the document, on every client', async () => {
		const room = 'comments-anchor-remove';
		const author = E.createDocument({
			value: { children: [para('p1', 'the quick fox')] },
			actor: { id: 'ada' }
		});
		const ada = await RawClient.connect(room, author.doc, {
			user: 'ada',
			replica: author.doc.clientID
		});
		await vi.waitFor(() => expect(ada.synced).toBe(true));
		await add(room, 'a1');
		author.facade.setMark('p1', 4, 5, 'comment:a1', { id: 'a1' });
		const marked = () =>
			readFacade(author.doc, (facade) =>
				facade
					.contentItems('p1')
					.flatMap((item) =>
						item.kind === 'text' && item.marks?.['comment:a1'] ? [item.text] : []
					)
			);
		expect(marked()).toEqual(['quick']);
		await vi.waitFor(async () =>
			expect(
				await inRoom(room, (r) =>
					JSON.stringify(r.read().children[0]!.content).includes('comment:a1')
				)
			).toBe(true)
		);
		await changeOf(room, { op: 'delete', thread: 'a1' });
		expect(
			await inRoom(room, (r) => JSON.stringify(r.read().children[0]!.content).includes('comment:'))
		).toBe(false);
		await vi.waitFor(() => expect(marked()).toEqual([]));
		expect(readFacade(author.doc, (facade) => facade.blockText('p1'))).toBe('the quick fox');
		ada.close();
		author.destroy();
	});
});

describe('room.comments.hook', () => {
	it('`onComment` hears each change once stored', async () => {
		const room = 'comments-hook-heard';
		const added = await add(room, 'h1');
		const replied = await changeOf(
			room,
			{ op: 'reply', thread: 'h1', body: 'hi' },
			{ user: 'bob' }
		);
		expect(await inRoom(room, (r) => r.heard())).toEqual([added, replied]);
	});

	it('a throw from `onComment` is logged; the change stands', async () => {
		const room = 'comments-throw-hook';
		const added = await add(room, 'h1');
		expect(added.type).toBe('added');
		expect((await list(room)).threads.map((t) => t.id)).toEqual(['h1']);
	});
});
