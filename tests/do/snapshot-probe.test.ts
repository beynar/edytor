/**
 * P8 — the room's snapshot probe: `GET <room>?snapshot`, authorized by
 * `routeDocumentSocket` like a dial, answers the room's document as JSON
 * (`documentSnapshot` on the client: `null` while the room stores
 * nothing); a denied user gets `403`, an expired one `401`. The JSON is the
 * room's live document, as a client syncing it shows it.
 */
import { SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { E, ORIGIN, RawClient, crdt, para, shape } from './client';

const server = `${ORIGIN.replace('https', 'wss')}/rooms`;
const fetchSelf = ((url: string) => SELF.fetch(url)) as typeof fetch;
describe('P8 · documentSnapshot', () => {
	it('null before anything is stored, then the document as JSON; 403 denied, 401 expired', async () => {
		const room = 'p8-snapshot';
		const ask = (user = 'ada') =>
			crdt.providers.documentSnapshot({ server, room, params: { user }, fetch: fetchSelf });
		expect(await ask()).toBe(null);
		const a = E.createDocument({
			value: { children: [para('p', 'one'), para('q', 'two')] },
			actor: { id: 'ada' }
		});
		const client = await RawClient.connect(room, a.doc, { user: 'ada', replica: a.doc.clientID });
		await vi.waitFor(() => expect(client.synced).toBe(true));
		a.transact(() => a.facade.insertText('p', 3, '!'));
		await vi.waitFor(async () => {
			const json = await ask();
			expect(json).not.toBe(null);
			expect(shape(json!)).toEqual(shape(a.facade.toJSON()));
		});
		await expect(ask('denied')).rejects.toThrow('403');
		await expect(ask('expired')).rejects.toThrow('401');
		// A read-only identity reads it too.
		const readOnly = await fetchSelf(`${ORIGIN}/rooms/${room}?snapshot=1&user=viewer&access=read`);
		expect(readOnly.status).toBe(200);
		client.close();
		a.destroy();
	});
});
