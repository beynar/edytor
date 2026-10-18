/**
 * `attr.binding.first-write` and `room.attribution.trust`
 * (`docs/editor-delete-contract.md`): a replica's binding (`c/<clientID>`)
 * goes with its first write, so the room stores nothing for a socket that
 * only reads, and the binding of a writer arrives in its first frame. For
 * writers the room's rules hold as before:
 *
 * - a socket that syncs, shares presence and leaves without writing adds no
 *   record: the stored rows and the room's state are what they were;
 * - a writer's first frame carries its binding, which the room stores with
 *   it; a reconnect writes none again; a reload binds its new client id with
 *   its own first write, and its `saved` counts what the session before it
 *   wrote offline;
 * - a first frame the validator denies is undone, and its binding stands;
 * - a binding to another actor (an anonymous document) is rebound to the
 *   verified user at that first frame (`attribution-trust.test.ts` holds the
 *   other trust rows).
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import { E, ORIGIN, RawClient, SelfWebSocket, Y, crdt, para, readFacade } from './client';
import type { LockedRoom } from './worker';

declare global {
	namespace Cloudflare {
		interface Env {
			LOCKED: DurableObjectNamespace<LockedRoom>;
		}
	}
}

const SLOW = { timeout: 20_000, interval: 25 };

const stubOf = (room: string) =>
	(room.startsWith('locked-')
		? env.LOCKED.getByName(room)
		: env.ROOM.getByName(room)) as DurableObjectStub<Room>;
const inRoom = <T>(room: string, fn: (r: Room, state: DurableObjectState) => T) =>
	runInDurableObject(stubOf(room), (r: Room, state) => fn(r, state));

/** The room's rows, as stored. */
const rowsOf = (room: string) =>
	inRoom(room, (_r, state) =>
		state.storage.sql
			.exec<{
				seq: number;
				kind: string;
				size: number;
			}>('SELECT seq, kind, length(bytes) AS size FROM rows ORDER BY seq')
			.toArray()
	);

type Attrs = { getAttr(key: string): unknown; attrKeys(): IterableIterator<string> };
const bindingIn = (room: string, client: number) =>
	inRoom(
		room,
		(r) => (r.doc!.get('attribution') as unknown as Attrs).getAttr(`c/${client}`) ?? null
	);
/** The items the room holds under the attribution root's `c/<client>` key, live or not. */
const bindingItems = (room: string, client: number) =>
	inRoom(
		room,
		(r) =>
			(r.doc!.store.clients.get(client) ?? []).filter(
				(s) => (s as { parentSub?: string }).parentSub === `c/${client}`
			).length
	);
const roomText = (room: string, id: string) =>
	inRoom(room, (r) => readFacade(r.doc!, (f) => f.blockText(id)));

describe('attr.binding.first-write · the room and a replica that only reads', () => {
	it('a socket that syncs, shares presence and leaves without writing stores nothing', async () => {
		const room = 'first-write-reader';
		const ada = E.createDocument({ value: { children: [para('p', '')] }, actor: { id: 'ada' } });
		const writer = await RawClient.connect(room, ada.doc, {
			user: 'ada',
			replica: ada.doc.clientID
		});
		ada.transact(() => ada.facade.insertText('p', 0, 'hello'));
		await vi.waitFor(() => expect(writer.stored()).toBe(true), SLOW);
		writer.close();
		const rows = await rowsOf(room);
		const state = await inRoom(room, (r) => Y.encodeStateAsUpdate(r.doc!));
		// A page that only reads: it loads, syncs, shares a caret, leaves.
		const bob = E.loadDocument(state, { actor: { id: 'bob' } });
		const reader = await RawClient.connect(room, bob.doc, {
			user: 'bob',
			replica: bob.doc.clientID
		});
		await vi.waitFor(() => expect(reader.synced).toBe(true), SLOW);
		reader.setPresence(bob.doc.clientID, 1, { actor: { id: 'bob' }, selections: {} });
		bob.history;
		bob.facade.toJSON();
		bob.endHistory();
		await vi.waitFor(() => expect(reader.acks.length).toBeGreaterThan(0), SLOW);
		reader.close();
		expect(bob.doc.store.clients.has(bob.doc.clientID)).toBe(false);
		expect(await rowsOf(room)).toEqual(rows);
		expect(await inRoom(room, (r) => Y.encodeStateAsUpdate(r.doc!))).toEqual(state);
		expect(await bindingIn(room, bob.doc.clientID)).toBe(null);
		ada.destroy();
		bob.destroy();
	});

	it('the first frame carries the binding; a reconnect writes none again; a reload binds its own id', async () => {
		const room = 'first-write-writer';
		const ada = E.createDocument({ value: { children: [para('p', '')] }, actor: { id: 'ada' } });
		const id = ada.doc.clientID;
		const tab = await RawClient.connect(room, ada.doc, { user: 'ada', replica: id });
		await vi.waitFor(() => expect(tab.synced).toBe(true), SLOW);
		expect(await bindingIn(room, id)).toBe(null);
		const before = (await rowsOf(room)).length;
		ada.transact(() => ada.facade.insertText('p', 0, 'one'));
		await vi.waitFor(() => expect(tab.stored()).toBe(true), SLOW);
		// One frame, one record: the edit and its binding.
		expect((await rowsOf(room)).length).toBe(before + 1);
		expect(await bindingIn(room, id)).toBe('ada');
		tab.close();
		// A reconnect, then a second edit: no second binding.
		const again = await RawClient.connect(room, ada.doc, { user: 'ada', replica: id });
		await vi.waitFor(() => expect(again.synced).toBe(true), SLOW);
		ada.transact(() => ada.facade.insertText('p', 3, ' two'));
		await vi.waitFor(async () => expect(await roomText(room, 'p')).toBe('one two'), SLOW);
		expect(await bindingItems(room, id)).toBe(1);
		again.close();
		// Offline, then a reload: the new session's provider counts the old
		// session's edit unsaved until the room stores it, and binds its own
		// client id with its own first write.
		ada.transact(() => ada.facade.insertText('p', 7, ' three'));
		const copy = ada.encode();
		ada.destroy();
		const reloaded = E.createDocument({ actor: { id: 'ada' } });
		const provider = new crdt.providers.WebsocketProvider(
			`${ORIGIN.replace('https', 'wss')}/rooms`,
			room,
			reloaded.doc,
			{
				connect: false,
				disableBc: true,
				params: { user: 'ada' },
				WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket
			}
		);
		Y.applyUpdate(reloaded.doc, copy, { store: true });
		expect([provider.saved, provider.unsaved]).toEqual([false, 1]);
		provider.connect();
		await vi.waitFor(() => expect([provider.saved, provider.unsaved]).toEqual([true, 0]), SLOW);
		await vi.waitFor(async () => expect(await roomText(room, 'p')).toBe('one two three'), SLOW);
		expect(reloaded.attribution.actorOf(reloaded.doc.clientID)).toBeUndefined();
		reloaded.transact(() => reloaded.facade.insertText('p', 0, '> '));
		await vi.waitFor(
			async () => expect(await bindingIn(room, reloaded.doc.clientID)).toBe('ada'),
			SLOW
		);
		await vi.waitFor(() => expect([provider.saved, provider.unsaved]).toEqual([true, 0]), SLOW);
		provider.destroy();
		reloaded.destroy();
	});

	it("a first frame the validator denies is undone; its binding stands, and the writer's next frame applies", async () => {
		const room = 'locked-first-write';
		const ada = E.createDocument({
			value: { children: [para('p', 'locked'), para('q', 'free')] },
			actor: { id: 'ada' }
		});
		const adaTab = await RawClient.connect(room, ada.doc, {
			user: 'ada',
			replica: ada.doc.clientID
		});
		await vi.waitFor(() => expect(adaTab.synced).toBe(true), SLOW);
		ada.transact(() => ada.facade.patchData('p', [{ path: [], value: { lockedBy: 'ada' } }]));
		await vi.waitFor(() => expect(adaTab.stored()).toBe(true), SLOW);
		const bob = E.loadDocument(await inRoom(room, (r) => Y.encodeStateAsUpdate(r.doc!)), {
			actor: { id: 'bob' }
		});
		const bobId = bob.doc.clientID;
		const bobTab = await RawClient.connect(room, bob.doc, { user: 'bob', replica: bobId });
		await vi.waitFor(() => expect(bobTab.synced).toBe(true), SLOW);
		// Bob's first write, into Ada's locked block: denied and undone; his binding stays.
		bob.transact(() => bob.facade.insertText('p', 0, 'BOB '));
		await vi.waitFor(
			async () =>
				expect(
					await inRoom(room, (r) => r.refusals.filter((x) => x.reason === 'denied').length)
				).toBe(1),
			SLOW
		);
		await vi.waitFor(async () => expect(await roomText(room, 'p')).toBe('locked'), SLOW);
		expect(await bindingIn(room, bobId)).toBe('bob');
		bob.transact(() => bob.facade.insertText('q', 0, 'bob: '));
		await vi.waitFor(async () => expect(await roomText(room, 'q')).toBe('bob: free'), SLOW);
		expect(await bindingItems(room, bobId)).toBe(1);
		expect(await inRoom(room, (r) => r.refusals.filter((x) => x.reason === 'forged'))).toEqual([]);
		for (const tab of [adaTab, bobTab]) tab.close();
		ada.destroy();
		bob.destroy();
	});
});
