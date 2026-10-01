/**
 * `pnpm test:do` — block and document properties (0.1.0-next.6) through the
 * shipped room: data leaves are ordinary map entries, so two users' edits of
 * different keys are both stored, relayed and restored, `onSave` mirrors the
 * document's data in its JSON and `onLoad` seeds it.
 */
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import type { HookedRoom } from './worker';
import { E, RawClient, para, readFacade } from './client';

const stubOf = (room: string) => env.ROOM.getByName(room);
const hookedOf = (room: string) => env.HOOKED.getByName(room);
const serverJSON = (room: string) =>
	runInDurableObject(stubOf(room), (instance: Room) => {
		if (instance.doc === null) throw instance.failure ?? new Error('no doc');
		return readFacade(instance.doc, (facade) => facade.toJSON());
	});
const seeded = (actor: string) =>
	E.createDocument({
		value: { children: [para('p1', 'hello')] },
		actor: { id: actor },
		history: { captureTimeout: 0 }
	});
const applied = (result: { status: string }) => expect(result.status).toBe('applied');

describe('properties through the room', () => {
	it("two users' keys of one block and of the document: both stored, relayed and restored", async () => {
		const room = 'props-two-users';
		const [a, b] = [seeded('ada'), seeded('bob')];
		const ca = await RawClient.connect(room, a.doc, { user: 'ada', replica: a.doc.clientID });
		const cb = await RawClient.connect(room, b.doc, { user: 'bob', replica: b.doc.clientID });
		await vi.waitFor(() => expect(ca.synced && cb.synced).toBe(true));
		applied(a.facade.patchData('p1', [{ path: ['title'], value: 'Ada' }]));
		applied(b.facade.patchData('p1', [{ path: ['done'], value: true }]));
		applied(a.facade.patchData(null, [{ path: ['owner'], value: 'ada' }]));
		applied(b.facade.patchData(null, [{ path: ['tags'], value: ['x'] }]));
		const block = { title: 'Ada', done: true };
		const doc = { owner: 'ada', tags: ['x'] };
		for (const facade of [a.facade, b.facade])
			await vi.waitFor(() => {
				expect(facade.blockDataOf('p1')).toEqual(block);
				expect(facade.docData()).toEqual(doc);
			});
		await vi.waitFor(async () => {
			const json = await serverJSON(room);
			expect(json.data).toEqual(doc);
			expect(json.children[0].data).toEqual(block);
		});
		expect(ca.denied).toEqual([]);
		expect(cb.denied).toEqual([]);
		ca.close();
		cb.close();
		await evictDurableObject(stubOf(room));
		const restored = await serverJSON(room);
		expect(restored.data).toEqual(doc);
		expect(restored.children[0].data).toEqual(block);
		a.destroy();
		b.destroy();
	});

	it('a read-only socket’s data patch is denied and never stored', async () => {
		const room = 'props-read-only';
		const a = seeded('ada');
		const ca = await RawClient.connect(room, a.doc, { user: 'ada', replica: a.doc.clientID });
		await vi.waitFor(() => expect(ca.synced).toBe(true));
		const reader = E.createDocument({ value: { children: [] }, actor: { id: 'eve' } });
		const cr = await RawClient.connect(room, reader.doc, { user: 'eve', access: 'read' });
		await vi.waitFor(() => expect(reader.facade.blockText('p1')).toBe('hello'));
		reader.facade.patchData(null, [{ path: ['title'], value: 'Eve' }]);
		await vi.waitFor(() => expect(cr.denied).toEqual(['read-only']));
		expect((await serverJSON(room)).data).toBeUndefined();
		ca.close();
		cr.close();
		a.destroy();
		reader.destroy();
	});

	it('onLoad seeds the document data; transact patches it; onSave mirrors it', async () => {
		const room = 'hooked-data';
		const client = await RawClient.connect(room);
		await vi.waitFor(() => expect(client.json().data).toEqual({ title: 'Loaded', meta: { v: 1 } }));
		const result = await runInDurableObject(hookedOf(room), (r: HookedRoom) =>
			r.transact((facade) => facade.patchData(null, [{ path: ['meta', 'w'], value: 2 }]))
		);
		expect(result.status).toBe('applied');
		const expected = { title: 'Loaded', meta: { v: 1, w: 2 } };
		await vi.waitFor(() => expect(client.json().data).toEqual(expected));
		expect(await runDurableObjectAlarm(hookedOf(room))).toBe(true);
		const mirrored = await runInDurableObject(hookedOf(room), (_r: HookedRoom, state) =>
			state.storage.sql.exec<{ json: string }>('SELECT json FROM mirror').toArray()
		);
		expect(JSON.parse(mirrored.at(-1)!.json).data).toEqual(expected);
		client.close();
	});
});
