/**
 * The default history client: the HTTP requests `routeDocumentHistory`
 * answers (site `server/history#over-http`) and how it reads each answer.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { HistoryEntry, RestoreResult } from '$lib/cloudflare/index.js';
import {
	createHistoryClient,
	HistoryRequestError,
	type HistoryRestoreResult,
	type HistoryVersion
} from '$lib/collaboration/history/client.js';

type Call = { url: URL; method: string };

/** A fetch answering `answer(call)`, recording each call. */
const stub = (answer: (call: Call) => Response) => {
	const calls: Call[] = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = { url: new URL(String(input)), method: init?.method ?? 'GET' };
		calls.push(call);
		return answer(call);
	}) as typeof globalThis.fetch;
	return { calls, fetch };
};

const version: HistoryVersion = {
	key: 'history/doc%201/2026-10-06-am',
	date: '2026-10-06',
	slot: 'am',
	bytes: 120,
	blocks: 3,
	editors: ['ada'],
	more: 0,
	at: Date.UTC(2026, 9, 6, 10),
	expiresAt: null
};

describe('createHistoryClient', () => {
	it('lists the versions with GET <server>/<room>, the room percent-encoded, with the params', async () => {
		const { calls, fetch } = stub(() => Response.json([version]));
		const client = createHistoryClient({
			server: 'https://app.example/history/',
			room: 'doc 1/a',
			params: { token: 't' },
			fetch
		});
		expect(await client.list()).toEqual([version]);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.method).toBe('GET');
		expect(calls[0]!.url.pathname).toBe('/history/doc%201%2Fa');
		expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ token: 't' });
	});

	it('reads the params again at every request when they are a function', async () => {
		const { calls, fetch } = stub(() => Response.json([]));
		let token = 'one';
		const client = createHistoryClient({
			server: 'https://app.example/history',
			room: 'doc',
			params: () => ({ token }),
			fetch
		});
		await client.list();
		token = 'two';
		await client.list();
		expect(calls.map((call) => call.url.searchParams.get('token'))).toEqual(['one', 'two']);
	});

	it('takes a ws(s) server as its http(s) twin', async () => {
		const { calls, fetch } = stub(() => Response.json([]));
		await createHistoryClient({ server: 'wss://app.example/history', room: 'doc', fetch }).list();
		expect(calls[0]!.url.origin).toBe('https://app.example');
	});

	it('reads a version with GET ?key=, and answers null for a 404', async () => {
		const doc = { children: [{ type: 'paragraph', id: 'a', content: [{ text: 'then' }] }] };
		const { calls, fetch } = stub(({ url }) =>
			url.searchParams.get('key') === version.key
				? Response.json(doc)
				: new Response('no such version', { status: 404 })
		);
		const client = createHistoryClient({
			server: 'https://app.example/history',
			room: 'doc',
			fetch
		});
		expect(await client.read(version.key)).toEqual(doc);
		expect(await client.read('history/doc/2020-01-01-am')).toBeNull();
		expect(calls.map((call) => call.method)).toEqual(['GET', 'GET']);
	});

	it('restores with POST ?restore=, a 404 answering refused', async () => {
		const { calls, fetch } = stub(({ url }) =>
			url.searchParams.get('restore') === version.key
				? Response.json({ status: 'applied', key: version.key, rewritten: 1 })
				: new Response('no such version', { status: 404 })
		);
		const client = createHistoryClient({
			server: 'https://app.example/history',
			room: 'doc',
			fetch
		});
		expect(await client.restore(version.key)).toEqual({
			status: 'applied',
			key: version.key,
			rewritten: 1
		});
		expect(await client.restore('gone')).toEqual({ status: 'refused', key: 'gone' });
		expect(calls.map((call) => call.method)).toEqual(['POST', 'POST']);
	});

	it('undoes the last restore with POST ?undo', async () => {
		const { calls, fetch } = stub(() => Response.json({ status: 'applied' }));
		const client = createHistoryClient({
			server: 'https://app.example/history',
			room: 'doc',
			fetch
		});
		expect(await client.undo()).toEqual({ status: 'applied' });
		expect(calls[0]!.method).toBe('POST');
		expect(calls[0]!.url.searchParams.has('undo')).toBe(true);
	});

	it('throws a HistoryRequestError with the status on a refusal', async () => {
		const { fetch } = stub(() => new Response('read-only', { status: 403 }));
		const client = createHistoryClient({
			server: 'https://app.example/history',
			room: 'doc',
			fetch
		});
		const error = await client.restore(version.key).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(HistoryRequestError);
		expect((error as HistoryRequestError).status).toBe(403);
		expect((error as HistoryRequestError).message).toContain('read-only');
		await expect(client.list()).rejects.toMatchObject({ status: 403 });
		await expect(client.undo()).rejects.toMatchObject({ status: 403 });
	});

	it('refuses a room id no request can carry, at construction', () => {
		expect(() =>
			createHistoryClient({ server: 'https://app.example/history', room: '..' })
		).toThrow(TypeError);
	});

	it("reads the room's own answers: HistoryEntry and RestoreResult", () => {
		expectTypeOf<HistoryEntry>().toExtend<HistoryVersion>();
		expectTypeOf<RestoreResult>().toExtend<HistoryRestoreResult>();
	});
});
