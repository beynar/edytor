/**
 * Phase 2, H12 — offline coverage through the room:
 *
 * - `lastUpdated` asks the room, over one authorized HTTP request through
 *   `routeDocumentSocket`, when it last stored a change (`null` before any);
 *   a denied user gets `403`;
 * - `prefetch` syncs a document's local store with its room once (both
 *   ways), waits until the room stored what it sent, then closes: a later
 *   offline open finds the room's content in the store.
 */
import 'fake-indexeddb/auto';
import { SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { E, ORIGIN, RawClient, SelfWebSocket, crdt, para, shape } from './client';

const server = `${ORIGIN.replace('https', 'wss')}/rooms`;
const fetchSelf = ((url: string) => SELF.fetch(url)) as typeof fetch;
describe('H12 · lastUpdated and prefetch', () => {
	it('lastUpdated: null before any change, then the time of the last stored change; 403 when denied', async () => {
		const room = 'h12-probe';
		const ask = (user = 'ada') =>
			crdt.providers.lastUpdated({ server, room, params: { user }, fetch: fetchSelf });
		expect(await ask()).toBe(null);
		const a = E.createDocument({ value: { children: [para('p', 'one')] }, actor: { id: 'ada' } });
		const client = await RawClient.connect(room, a.doc, { user: 'ada', replica: a.doc.clientID });
		await vi.waitFor(() => expect(client.synced).toBe(true));
		const before = Date.now();
		a.transact(() => a.facade.insertText('p', 0, 'x'));
		await vi.waitFor(async () => expect(await ask()).not.toBe(null));
		const at = (await ask())!;
		expect(at).toBeGreaterThanOrEqual(before - 1000);
		expect(at).toBeLessThanOrEqual(Date.now() + 1000);
		await expect(ask('denied')).rejects.toThrow('403');
		client.close();
		a.destroy();
	});

	it('prefetch: syncs the local store with the room both ways, then closes; offline, the store has it', async () => {
		const room = 'h12-prefetch';
		const author = E.createDocument({
			value: { children: [para('p', 'from the room')] },
			actor: { id: 'ada' }
		});
		const client = await RawClient.connect(room, author.doc, {
			user: 'ada',
			replica: author.doc.clientID
		});
		await vi.waitFor(() => expect(client.synced).toBe(true));
		// The room stores the seed Ada sends after she heard it: close once it acknowledged it.
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		client.close();

		const options = {
			server,
			room,
			params: { user: 'bob' },
			WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket
		};
		expect(await crdt.providers.prefetch(options)).toEqual({ updated: true });
		// Nothing new the second time.
		expect(await crdt.providers.prefetch(options)).toEqual({ updated: false });

		// Offline (no server): a document over the same store opens with the room's content.
		const offline = E.createDocument({ actor: { id: 'bob' } });
		offline.attachSync(crdt.providers.createIndexeddbSync(`edytor:${server}/${room}`));
		await vi.waitFor(() => expect(offline.ready).toBe(true));
		expect(shape(offline.facade.toJSON())).toEqual(shape(author.facade.toJSON()));
		offline.destroy();
		author.destroy();
	});

	it('prefetch rejects with the room refusal', async () => {
		await expect(
			crdt.providers.prefetch({
				server,
				room: 'h12-denied',
				params: { user: 'denied' },
				WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket
			})
		).rejects.toMatchObject({ code: 4403 });
	});
});
