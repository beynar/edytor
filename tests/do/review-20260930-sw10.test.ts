/**
 * Wave 10 sweep (2026-09-30) — the route's identity, in workerd:
 *
 * - SW10-server-1: `routeDocumentSocket` hands the verified user to the room
 *   in the `X-Edytor-User` header. A header value loses its surrounding
 *   whitespace, so `' ada'` reached the room as `'ada'` — another user,
 *   whose client ids it then shared — and no header carries a lone
 *   surrogate faithfully. The header now
 *   carries the id percent-encoded: every user id of 1 to 256 characters
 *   reaches the room verbatim, and one with a lone surrogate, which no
 *   encoding carries, is an invalid identity (`4403`).
 *
 * Expected values are hand-authored from the dials each test performs.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { routeDocumentSocket, type DocumentRoom } from '../../src/lib/cloudflare/index.js';
import { ORIGIN, dialResponse } from './client';

const attachmentsOf = (room: string) =>
	runInDurableObject(env.ROOM.getByName(room), (_r: DocumentRoom, state) =>
		state.getWebSockets().map((ws) => (ws.deserializeAttachment() as { user: string }).user)
	);

const closeOf = (ws: WebSocket) =>
	new Promise<{ code: number; reason: string }>((resolve) =>
		ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }))
	);

describe('SW10-server-1 · every user id reaches the room verbatim', () => {
	const users = ['李雷', 'Zoë', 'ada 😀', ' ada', 'ada ', '50%off', 'a%41b', 'x'.repeat(256)];

	it.each(users)('the room binds %j as it was verified', async (user) => {
		const room = `identity-${encodeURIComponent(user).slice(0, 40)}`;
		const response = await dialResponse(room, { user });
		expect(response.status).toBe(101);
		const ws = response.webSocket!;
		ws.accept();
		expect(await attachmentsOf(room)).toEqual([user]);
		ws.close();
	});

	it('a user id with a lone surrogate is an invalid identity (4403)', async () => {
		// A query string cannot carry one either, so `authorize` returns it.
		let reached = false;
		const rooms = {
			getByName() {
				reached = true;
				throw new Error('never');
			}
		};
		const request = new Request(`${ORIGIN}/rooms/x`, { headers: { Upgrade: 'websocket' } });
		const response = await routeDocumentSocket(request, rooms, 'x', () => ({
			userId: 'ada\uD83D'
		}));
		const ws = response.webSocket!;
		ws.accept();
		expect(await closeOf(ws)).toEqual({ code: 4403, reason: 'document access denied' });
		expect(reached).toBe(false);
	});
});
