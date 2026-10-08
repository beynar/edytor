/**
 * Re-score 3 (2026-09-30) — FW-07, in workerd: the RW-10 case after a
 * reload. After a restore from a lagging snapshot, the room strips Ada's
 * edit that Bob's copy still holds. Bob reloads: his provider starts on a
 * document hydrated from his local copy (Ada's lost edit included, and his
 * own offline edit made before the reload). It counts only his actor's
 * writes as pending: unsaved until the room stored his edit, then saved,
 * though Ada's stays stripped.
 *
 * Both hydration orders are covered: the copy applied before the provider
 * starts, and replayed after it (as the local store does).
 *
 * Expected values are hand-authored from the edits each test performs.
 */
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import type { HookedRoom } from './worker';
import {
	E,
	ORIGIN,
	RawClient,
	SelfWebSocket,
	Y,
	crdt,
	readFacade,
	shape,
	storedUpdate
} from './client';

const hooked = (room: string) => env.HOOKED.getByName(room);
const inHooked = <T>(room: string, fn: (r: HookedRoom, state: DurableObjectState) => T) =>
	runInDurableObject(hooked(room), (r: HookedRoom, state) => fn(r, state));

const clockOf = (doc: E.YDoc) => Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID);
const textOf = (client: RawClient) => shape(client.json()).children[0]?.text;

/** The text of block `id` in what the room STORED (its rows, merged). */
const storedText = (r: Room, id: string) => {
	const stored = crdt.createDoc();
	Y.applyUpdate(stored, storedUpdate(r.records()));
	return readFacade(stored, (f) => f.blockText(id));
};

/** The shipped provider over `SELF`; `connect: false` until the test dials. */
const provider = (room: string, doc: E.YDoc, user: string, connect = true) =>
	new crdt.providers.WebsocketProvider(`${ORIGIN.replace('https', 'wss')}/rooms`, room, doc, {
		params: { user },
		WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
		disableBc: true,
		connect
	});

/**
 * RW-10's setup: Ada's "!" reaches Bob, then the room restores from a
 * snapshot without it, and Bob types offline. Returns Bob's copy.
 */
const restoredWithBobOffline = async (room: string) => {
	const a = crdt.createDoc();
	const tabA = await RawClient.connect(room, a, { user: 'ada', replica: a.clientID });
	await vi.waitFor(() => expect(textOf(tabA)).toBe('from onLoad'));
	const ada = E.attachDocument(a, { actor: { id: 'ada' } });
	ada.transact(() => ada.facade.insertText('seed', 0, 'ada: '));
	await vi.waitFor(() => expect(tabA.acks.at(-1)?.get(a.clientID)).toBe(clockOf(a)));
	expect(await runDurableObjectAlarm(hooked(room))).toBe(true);
	const snapshot = await inHooked(
		room,
		(_r, state) =>
			state.storage.sql.exec<{ id: number }>('SELECT MAX(rowid) AS id FROM mirror').one().id
	);

	const b = crdt.createDoc();
	const bob = E.attachDocument(b, { actor: { id: 'bob' } });
	const first = provider(room, b, 'bob');
	await vi.waitFor(() => expect(first.synced).toBe(true));
	ada.transact(() => ada.facade.insertText('seed', 'ada: from onLoad'.length, '!'));
	await vi.waitFor(() =>
		expect(readFacade(b, (f) => f.blockText('seed'))).toBe('ada: from onLoad!')
	);
	first.destroy();
	tabA.close();

	await inHooked(room, async (_r, state) => {
		state.storage.sql.exec('DELETE FROM rows');
		state.storage.sql.exec('DELETE FROM replicas');
		state.storage.sql.exec('DELETE FROM mirror WHERE rowid > ?', snapshot);
		await state.storage.deleteAlarm();
	});
	await evictDurableObject(hooked(room));

	bob.transact(() => bob.facade.insertText('seed', 'ada: '.length, '[bob] '));
	const copy = Y.encodeStateAsUpdate(b);
	ada.destroy();
	bob.destroy();
	return copy;
};

describe('FW-07 · after a reload, the relaying provider reaches saved', () => {
	it('hydrated before the provider starts: unsaved, then saved once the room stored his edit', async () => {
		const room = 'hooked-restore-lag-reload-before';
		const copy = await restoredWithBobOffline(room);
		const reloaded = crdt.createDoc();
		Y.applyUpdate(reloaded, copy);
		const bob = E.attachDocument(reloaded, { actor: { id: 'bob' } });
		const bobs = provider(room, reloaded, 'bob', false);
		expect(bobs.saved).toBe(false);
		bobs.connect();
		await vi.waitFor(() => expect(bobs.saved).toBe(true), { timeout: 10_000 });
		const stored = await inHooked(room, (r) => storedText(r, 'seed'));
		expect({ stored, unsaved: bobs.unsaved }).toEqual({
			stored: 'ada: [bob] from onLoad',
			unsaved: 0
		});
		bobs.destroy();
		bob.destroy();
	});

	it('replayed after the provider starts (the local store): unsaved, then saved', async () => {
		const room = 'hooked-restore-lag-reload-replay';
		const copy = await restoredWithBobOffline(room);
		const reloaded = crdt.createDoc();
		const bob = E.attachDocument(reloaded, { actor: { id: 'bob' } });
		const bobs = provider(room, reloaded, 'bob', false);
		Y.applyUpdate(reloaded, copy, { store: true });
		expect(bobs.saved).toBe(false);
		bobs.connect();
		await vi.waitFor(() => expect(bobs.saved).toBe(true), { timeout: 10_000 });
		const stored = await inHooked(room, (r) => storedText(r, 'seed'));
		expect({ stored, unsaved: bobs.unsaved }).toEqual({
			stored: 'ada: [bob] from onLoad',
			unsaved: 0
		});
		bobs.destroy();
		bob.destroy();
	});
});

describe('SW-collab-1 · a read-only socket reaches saved', () => {
	it("a viewer's provider is saved once it caught up: the document's actor record is not content", async () => {
		const room = 'hooked-readonly-viewer-saved';
		const a = crdt.createDoc();
		const author = await RawClient.connect(room, a, { user: 'ada', replica: a.clientID });
		await vi.waitFor(() => expect(textOf(author)).toBe('from onLoad'));
		const viewer = E.createDocument({ actor: { id: 'viv' } });
		const viewers = new crdt.providers.WebsocketProvider(
			`${ORIGIN.replace('https', 'wss')}/rooms`,
			room,
			viewer.doc,
			{
				params: { user: 'viv', access: 'read' },
				WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
				disableBc: true
			}
		);
		await vi.waitFor(() => expect(viewers.synced).toBe(true));
		await vi.waitFor(() => expect(viewers.saved).toBe(true), { timeout: 5_000 });
		expect(viewers.unsaved).toBe(0);
		viewers.destroy();
		viewer.destroy();
		author.close();
	});
});
