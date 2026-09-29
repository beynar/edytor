/**
 * `pnpm test:do` — the room's extension points on a subclass
 * (`tests/do/worker.ts` `HookedRoom`): `onLoad` retrieves, `onSave` mirrors
 * (on the alarm), `transact` edits on the server, `read` returns JSON.
 */
import { env } from 'cloudflare:workers';
import {
	SELF,
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject
} from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { HookedRoom, HostObject, PlainObject } from './worker';
import { ORIGIN, RawClient, shape } from './client';

declare global {
	namespace Cloudflare {
		interface Env {
			HOOKED: DurableObjectNamespace<HookedRoom>;
			PLAIN: DurableObjectNamespace<PlainObject>;
			HOST: DurableObjectNamespace<HostObject>;
		}
	}
}

const stubOf = (room: string) => env.HOOKED.getByName(room);
const inRoom = <T>(room: string, fn: (instance: HookedRoom) => T) =>
	runInDurableObject(stubOf(room), (instance: HookedRoom) => fn(instance));
const loaded = { children: [{ id: 'seed', type: 'paragraph', text: 'from onLoad' }] };

describe('room extension points', () => {
	for (const room of ['hooked-json', 'hooked-bytes']) {
		it(`onLoad seeds a fresh room before any socket is served (${room})`, async () => {
			const client = await RawClient.connect(room);
			await vi.waitFor(() => expect(shape(client.json())).toEqual(loaded));
			client.close();
			// Stored: the next start restores it instead of asking onLoad again.
			await evictDurableObject(stubOf(room));
			expect(await inRoom(room, (r) => r.origin.kind)).toBe('restored');
			expect(shape(await inRoom(room, (r) => r.read()))).toEqual(loaded);
		});
	}

	it('transact edits on the server: stored, broadcast, then mirrored by onSave', async () => {
		const room = 'hooked-edit';
		const client = await RawClient.connect(room);
		await vi.waitFor(() => expect(shape(client.json())).toEqual(loaded));

		const result = await inRoom(room, (r) =>
			r.transact((facade) => facade.insertText('seed', 0, 'server: '))
		);
		expect(result.status).toBe('applied');
		await vi.waitFor(() =>
			expect(shape(client.json()).children[0].text).toBe('server: from onLoad')
		);

		expect(await runDurableObjectAlarm(stubOf(room))).toBe(true);
		const mirrored = await runInDurableObject(stubOf(room), (_r: HookedRoom, state) =>
			state.storage.sql.exec<{ json: string; size: number }>('SELECT * FROM mirror').toArray()
		);
		expect(mirrored).toHaveLength(1);
		expect(shape(JSON.parse(mirrored[0].json)).children[0].text).toBe('server: from onLoad');
		expect(mirrored[0].size).toBeGreaterThan(0);
		client.close();

		await evictDurableObject(stubOf(room));
		expect(shape(await inRoom(room, (r) => r.read())).children[0].text).toBe('server: from onLoad');
	});

	it('an empty room: no save scheduled; transact seeds one block first', async () => {
		const room = 'hooked-empty';
		expect(await inRoom(room, (r) => r.origin.kind)).toBe('fresh');
		expect(await runDurableObjectAlarm(stubOf(room))).toBe(false);
		const text = await inRoom(room, (r) => {
			r.transact((facade) => facade.insertText(facade.listBlockIds()[0], 0, 'x'));
			return shape(r.read()).children.map((b) => b.text);
		});
		expect(text).toEqual(['x']);
	});
});

describe('attachDocument in any Durable Object', () => {
	it('a bare object: every handler installed, tables prefixed beside yours', async () => {
		const client = await RawClient.connect('plain-a');
		await vi.waitFor(() => expect(shape(client.json())).toEqual(loaded));
		const tables = await runInDurableObject(env.PLAIN.getByName('plain-a'), (_o, state) =>
			state.storage.sql
				.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
				.toArray()
				.map((t) => t.name)
		);
		expect(tables).toEqual(expect.arrayContaining(['edytor_rows', 'edytor_replicas']));
		expect(tables).not.toContain('rows');
		client.close();
	});

	it('an object with its own fetch, sockets and handlers delegates to the document', async () => {
		const room = 'host-a';
		const client = await RawClient.connect(room);
		await vi.waitFor(() => expect(shape(client.json())).toEqual(loaded));

		// The object's own socket, beside the document's: left to its handler.
		const echo = (await SELF.fetch(`${ORIGIN}/echo/${room}`, { headers: { Upgrade: 'websocket' } }))
			.webSocket!;
		echo.accept();
		const heard = new Promise((resolve) =>
			echo.addEventListener('message', (e) => resolve(e.data))
		);
		echo.send('hi');
		expect(await heard).toBe('echo:hi');

		const host = env.HOST.getByName(room);
		await runInDurableObject(host, (o: HostObject) =>
			o.document.transact((facade) => facade.insertText('seed', 0, 'host: '))
		);
		await vi.waitFor(() => expect(shape(client.json()).children[0].text).toBe('host: from onLoad'));

		// `alarm` was installed (the class has none): onSave mirrors.
		expect(await runDurableObjectAlarm(host)).toBe(true);
		const mirrored = await runInDurableObject(host, (_o, state) =>
			state.storage.sql.exec<{ json: string }>('SELECT json FROM mirror').toArray()
		);
		expect(shape(JSON.parse(mirrored[0].json)).children[0].text).toBe('host: from onLoad');
		echo.close();
		client.close();
	});
});
