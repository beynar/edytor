/**
 * The soak's staging Worker (`bench/soak/worker.ts`, WU-16) never fails
 * open: deployed without `SOAK_TOKEN` it refuses every route (an operator
 * route `403`, a socket closed `4403`); with it, an operator route needs the
 * token as an `Authorization: Bearer` header (never `?token=`, which would
 * land in request logs) and a socket dial as `?token=`. Only `/health`
 * answers without it. `local.ts` (Miniflare only) opens the routes itself.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import soak, { routeSoak, type Env } from '../../bench/soak/worker';

const ROOMS = (env as unknown as { ROOM: Env['ROOM'] }).ROOM;
const base = 'https://soak.example';
const as = (token?: string): Env => ({ ROOM: ROOMS, SOAK_TOKEN: token }) as Env;
const fetchSoak = (url: string, init: RequestInit, token?: string) =>
	soak.fetch(new Request(`${base}${url}`, init), as(token));

/** The close code of a socket a route answered (`closedSocket`), or `null` when it answered no socket. */
const closeCode = async (response: Response): Promise<number | null> => {
	const socket = response.webSocket;
	if (response.status !== 101 || !socket) return null;
	const closed = new Promise<number>((resolve) =>
		socket.addEventListener('close', (event) => resolve(event.code))
	);
	socket.accept();
	return closed;
};
const upgrade = { headers: { upgrade: 'websocket' } };
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('soak worker: the token gate', () => {
	it('without SOAK_TOKEN, every route but /health is refused, whatever the request carries', async () => {
		expect(await (await fetchSoak('/health', {})).text()).toBe('ready');
		for (const action of ['metrics', 'json']) {
			expect((await fetchSoak(`/rooms/r/${action}`, bearer('anything'))).status).toBe(403);
			expect((await fetchSoak(`/rooms/r/${action}?token=anything`, {})).status).toBe(403);
		}
		for (const action of ['compact', 'fault?kind=append', 'abort', 'evict']) {
			expect((await fetchSoak(`/rooms/r/${action}`, { method: 'POST' })).status).toBe(403);
		}
		expect(await closeCode(await fetchSoak('/rooms/r?user=u1&token=x', upgrade))).toBe(4403);
	});

	it('with SOAK_TOKEN, an operator route needs the bearer header, and a query token is not enough', async () => {
		const token = 'staging-secret';
		// GET on a POST route: past the gate, refused by method.
		expect((await fetchSoak('/rooms/r/compact', bearer(token), token)).status).toBe(405);
		expect((await fetchSoak('/rooms/r/compact', bearer('wrong'), token)).status).toBe(403);
		expect((await fetchSoak('/rooms/r/compact', bearer(`${token}x`), token)).status).toBe(403);
		expect((await fetchSoak(`/rooms/r/compact?token=${token}`, {}, token)).status).toBe(403);
		expect((await fetchSoak('/rooms/r/compact', {}, token)).status).toBe(403);
	});

	it('with SOAK_TOKEN, a socket dial without the right ?token= is closed 4403', async () => {
		const token = 'staging-secret';
		expect(await closeCode(await fetchSoak('/rooms/r?user=u1', upgrade, token))).toBe(4403);
		expect(await closeCode(await fetchSoak('/rooms/r?user=u1&token=no', upgrade, token))).toBe(
			4403
		);
	});

	it('local.ts opens the routes only through `open` (Miniflare, no token set)', async () => {
		const response = await routeSoak(new Request(`${base}/rooms/r/compact`), as(), {
			open: true
		});
		expect(response?.status).toBe(405);
	});
});
