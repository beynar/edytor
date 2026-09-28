/**
 * `pnpm test:do` — the room Durable Object (tests/do/room.ts) in the real
 * Workers runtime: SQLite storage, hibernatable sockets, eviction through
 * `evictDurableObject`. Clients dial the Worker route over real WebSocket
 * upgrades (`SELF.fetch`). Expected values are hand-authored from the edits
 * each test performs.
 */
import { env } from 'cloudflare:workers';
import { SELF, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { noTimers, type Room } from './room';
import {
	E,
	ORIGIN,
	RawClient,
	SelfWebSocket,
	Y,
	crdt,
	readFacade,
	para,
	shape,
	updateFrameWithWord
} from './client';

declare global {
	namespace Cloudflare {
		interface Env {
			ROOM: DurableObjectNamespace<Room>;
		}
	}
}

const ROW_BYTES = 4096; // tests/do/vitest.config.ts EDYTOR_MAX_ROW_BYTES

const stubOf = (room: string) => env.ROOM.getByName(room);

/** The room's document as JSON, read inside the object through a bare facade. */
const serverJSON = (room: string) =>
	runInDurableObject(stubOf(room), (instance: Room) => {
		if (instance.doc === null) throw instance.failure ?? new Error('no doc');
		return readFacade(instance.doc, (facade) => facade.toJSON());
	});

type RowInfo = {
	seq: number;
	kind: string;
	record: number;
	part: number;
	parts: number;
	size: number;
};

const rowsOf = (room: string) =>
	runInDurableObject(stubOf(room), (_instance: Room, state) =>
		state.storage.sql
			.exec<RowInfo>(
				'SELECT seq, kind, record, part, parts, length(bytes) AS size FROM rows ORDER BY seq'
			)
			.toArray()
	);

const refusalsOf = (room: string) =>
	runInDurableObject(stubOf(room), (instance: Room) =>
		instance.refusals.map((r) => ({ reason: r.reason, detail: r.detail }))
	);

/** A seeded headless document (`createDocument`) — the local-first author. */
const seeded = (children: ReturnType<typeof para>[], actor: string) =>
	E.createDocument({ value: { children }, actor: { id: actor }, history: { captureTimeout: 0 } });

const applied = (result: { status: string }) => expect(result.status).toBe('applied');

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

describe('room Durable Object — sync', () => {
	it('entry points run with timers forbidden (a pending timer blocks hibernation)', async () => {
		const thrown = await runInDurableObject(stubOf('timer-guard'), () => {
			try {
				noTimers(() => setTimeout(() => {}, 0));
				return null;
			} catch (error) {
				return (error as Error).message;
			}
		});
		expect(thrown).toBe('room scheduled a timer (a Durable Object could not hibernate)');
		// …and the guard restores the real timers afterwards.
		await settle(1);
	});

	it('two clients sync edits through the room', async () => {
		const room = 'sync-two';
		const a = seeded([para('p1', 'hello')], 'ada');
		const ca = await RawClient.connect(room, a.doc);
		const cb = await RawClient.connect(room);
		await vi.waitFor(() =>
			expect(shape(cb.json())).toEqual({
				children: [{ id: 'p1', type: 'paragraph', text: 'hello' }]
			})
		);
		expect(ca.synced && cb.synced).toBe(true);

		const b = E.attachDocument(cb.doc, { actor: { id: 'bob' } });
		applied(a.transact(() => a.facade.insertText('p1', 5, ' world')));
		applied(
			b.transact(() =>
				b.facade.insertBlock({ parent: null, index: 1 }, { id: 'p2', type: 'paragraph' })
			)
		);
		applied(b.transact(() => b.facade.insertText('p2', 0, 'second')));

		const expected = {
			children: [
				{ id: 'p1', type: 'paragraph', text: 'hello world' },
				{ id: 'p2', type: 'paragraph', text: 'second' }
			]
		};
		await vi.waitFor(() => {
			expect(shape(ca.json())).toEqual(expected);
			expect(shape(cb.json())).toEqual(expected);
		});
		expect(shape(await serverJSON(room))).toEqual(expected);
		expect(await serverJSON(room)).toEqual(ca.json());
		expect(cb.json()).toEqual(ca.json());
		ca.close();
		cb.close();
		a.destroy();
		b.destroy();
	});
});

describe('room Durable Object — admission', () => {
	/** An update from a peer holding `source`'s state. */
	const peerUpdate = (source: ReturnType<typeof crdt.createDoc>, write: (peer: any) => void) => {
		const peer = crdt.createDoc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(source));
		const out: Uint8Array[] = [];
		peer.on('update', (u: Uint8Array) => out.push(u));
		write(peer);
		return Y.mergeUpdates(out as Uint8Array<ArrayBuffer>[]);
	};

	/** Send one forged frame on a fresh socket; the room must close it 1008. */
	const rogue = async (room: string, bytes: Uint8Array) => {
		const socket = await RawClient.bare(room);
		socket.send(bytes);
		await vi.waitFor(() => expect(socket.closed).not.toBeNull());
		return socket.closed!;
	};

	it('refuses frames of another generation (1008): never applied, stored or relayed', async () => {
		const room = 'admission-generation';
		const a = seeded([para('p1', 'hello')], 'ada');
		const ca = await RawClient.connect(room, a.doc);
		const cb = await RawClient.connect(room);
		await vi.waitFor(() => expect(shape(cb.json()).children[0]?.text).toBe('hello'));
		await settle();
		const rowsBefore = await rowsOf(room);
		const receivedBefore = cb.received.length;
		const jsonBefore = JSON.stringify(ca.json());

		const typed = peerUpdate(a.doc, (peer) =>
			E.attachDocument(peer, { actor: { id: 'eve' } }).facade.insertText('p1', 0, 'FOREIGN ')
		);
		// A peer of the NEXT schema generation: valid content, wrong generation.
		const next = await rogue(
			room,
			updateFrameWithWord(E.generationWord(E.SCHEMA_VERSION + 1), typed)
		);
		// A v13-era peer: its first word is a bare message type.
		const v13 = await rogue(room, updateFrameWithWord(E.messageSync, typed));
		expect([next.code, v13.code]).toEqual([1008, 1008]);
		expect(next.reason).toBe('refused: generation');

		await settle();
		expect(await rowsOf(room)).toEqual(rowsBefore);
		expect(cb.received.length).toBe(receivedBefore);
		expect(JSON.stringify(await serverJSON(room))).toBe(jsonBefore);
		expect(JSON.stringify(cb.json())).toBe(jsonBefore);
		expect((await refusalsOf(room)).map((r) => r.reason)).toEqual(['generation', 'generation']);
		// The honest sockets stay open and keep syncing.
		expect([ca.closed, cb.closed]).toEqual([null, null]);
		applied(a.transact(() => a.facade.insertText('p1', 5, '!')));
		await vi.waitFor(() => expect(shape(cb.json()).children[0].text).toBe('hello!'));
		ca.close();
		cb.close();
		a.destroy();
	});

	it('refuses an update writing a foreign schema stamp (1008), same generation', async () => {
		const room = 'admission-schema';
		const a = seeded([para('p1', 'hello')], 'ada');
		const ca = await RawClient.connect(room, a.doc);
		const cb = await RawClient.connect(room);
		await vi.waitFor(() => expect(shape(cb.json()).children[0]?.text).toBe('hello'));
		await settle();
		const rowsBefore = await rowsOf(room);
		const receivedBefore = cb.received.length;

		const unsupported = await rogue(
			room,
			updateFrameWithWord(
				E.GENERATION,
				peerUpdate(a.doc, (p) => p.get(E.META_KEY).setAttr('v', 99))
			)
		);
		const foreign = await rogue(
			room,
			updateFrameWithWord(
				E.GENERATION,
				peerUpdate(a.doc, (p) => p.get(E.META_KEY).setAttr('schema', 'not-edytor'))
			)
		);
		expect([unsupported, foreign]).toEqual([
			{ code: 1008, reason: 'refused: schema' },
			{ code: 1008, reason: 'refused: schema' }
		]);
		await settle();
		const refusals = await refusalsOf(room);
		expect(refusals.map((r) => [r.reason, (r.detail as { kind: string }).kind])).toEqual([
			['schema', 'unsupported'],
			['schema', 'foreign']
		]);
		expect(await rowsOf(room)).toEqual(rowsBefore);
		expect(cb.received.length).toBe(receivedBefore);
		expect(E.schemaVersion(cb.doc as unknown as Parameters<typeof E.schemaVersion>[0])).toBe(
			E.SCHEMA_VERSION
		);
		expect(await serverJSON(room)).toEqual(ca.json());
		expect(shape(cb.json())).toEqual({
			children: [{ id: 'p1', type: 'paragraph', text: 'hello' }]
		});
		ca.close();
		cb.close();
		a.destroy();
	});

	it('a text frame is refused as malformed', async () => {
		const room = 'admission-text';
		const socket = await RawClient.bare(room);
		socket.ws.send('hello');
		await vi.waitFor(() =>
			expect(socket.closed).toEqual({ code: 1008, reason: 'refused: malformed' })
		);
	});
});

describe('room Durable Object — presence', () => {
	it('relays presence, hands a joiner every present peer, announces a close', async () => {
		const room = 'presence-relay';
		const ca = await RawClient.connect(room);
		ca.setPresence(101, 1, { user: { name: 'Ada' } });
		await vi.waitFor(async () =>
			expect(await runInDurableObject(stubOf(room), (r: Room) => r.presence.has(101))).toBe(true)
		);

		// B joins: the join snapshot carries A's presence.
		const cb = await RawClient.connect(room);
		await vi.waitFor(() => expect(cb.presence.get(101)?.state).toEqual({ user: { name: 'Ada' } }));

		// B's presence reaches A live, and B's socket attachment records it.
		cb.setPresence(202, 3, { user: { name: 'Bob' } });
		await vi.waitFor(() => expect(ca.presence.get(202)?.state).toEqual({ user: { name: 'Bob' } }));

		// A clock regression is ignored by the relay's presence table.
		cb.setPresence(202, 2, { user: { name: 'stale' } });
		await settle();
		expect(await runInDurableObject(stubOf(room), (r: Room) => r.presence.get(202)?.state)).toEqual(
			{ user: { name: 'Bob' } }
		);

		// B leaves without a goodbye frame: the room announces it (clock + 1).
		cb.close();
		await vi.waitFor(() => expect(ca.presence.has(202)).toBe(false));
		expect(await runInDurableObject(stubOf(room), (r: Room) => [...r.presence.keys()])).toEqual([
			101
		]);

		// An explicit goodbye (null state) removes without waiting for close.
		const cc = await RawClient.connect(room);
		cc.setPresence(303, 1, { user: { name: 'Cy' } });
		await vi.waitFor(() => expect(ca.presence.has(303)).toBe(true));
		cc.setPresence(303, 2, null);
		await vi.waitFor(() => expect(ca.presence.has(303)).toBe(false));
		ca.close();
		cc.close();
	});

	it('a close after an eviction (hibernated sockets) still announces the removal', async () => {
		const room = 'presence-hibernation';
		const a = seeded([para('p1', 'hello')], 'ada');
		const ca = await RawClient.connect(room, a.doc);
		const ghost = await RawClient.connect(room);
		ghost.setPresence(777, 4, { user: { name: 'Zed' } });
		await vi.waitFor(() => expect(ca.presence.get(777)?.state).toEqual({ user: { name: 'Zed' } }));
		await runInDurableObject(stubOf(room), (r: Room, state) => {
			(r as Room & { marker?: string }).marker = 'before-eviction';
			expect(state.getWebSockets()).toHaveLength(2);
		});

		// Evict: the instance (and its in-memory presence) goes away, the
		// hibernatable sockets and their attachments stay.
		await evictDurableObject(stubOf(room));
		ghost.close();
		await vi.waitFor(() => expect(ca.presence.has(777)).toBe(false));
		expect(ca.closed).toBeNull();

		await runInDurableObject(stubOf(room), (r: Room, state) => {
			expect((r as Room & { marker?: string }).marker).toBeUndefined();
			expect(r.origin).toEqual({ kind: 'restored', records: expect.any(Number) });
			expect(r.presence.size).toBe(0);
			expect(state.getWebSockets()).toHaveLength(1);
		});

		// The surviving socket keeps syncing through the woken instance.
		applied(a.transact(() => a.facade.insertText('p1', 5, ',')));
		const late = await RawClient.connect(room);
		await vi.waitFor(() => expect(shape(late.json()).children[0]?.text).toBe('hello,'));
		expect(late.json()).toEqual(ca.json());
		ca.close();
		late.close();
		a.destroy();
	});
});

describe('room Durable Object — storage', () => {
	it('a late joiner catches up from storage after every client left and the object was evicted', async () => {
		const room = 'storage-late-joiner';
		const a = seeded([para('p1', 'hello')], 'ada');
		const ca = await RawClient.connect(room, a.doc);
		await vi.waitFor(() => expect(ca.synced).toBe(true));
		applied(a.transact(() => a.facade.insertText('p1', 5, ' world')));
		applied(a.transact(() => a.facade.splitBlock('p1', 5, 'p1b')));
		await vi.waitFor(async () =>
			expect(shape(await serverJSON(room))).toEqual({
				children: [
					{ id: 'p1', type: 'paragraph', text: 'hello' },
					{ id: 'p1b', type: 'paragraph', text: ' world' }
				]
			})
		);
		ca.close();
		await settle();
		await evictDurableObject(stubOf(room));

		const cc = await RawClient.connect(room);
		await vi.waitFor(() => expect(cc.synced).toBe(true));
		expect(shape(cc.json())).toEqual({
			children: [
				{ id: 'p1', type: 'paragraph', text: 'hello' },
				{ id: 'p1b', type: 'paragraph', text: ' world' }
			]
		});
		expect(cc.json()).toEqual(a.facade.toJSON());
		expect(await runInDurableObject(stubOf(room), (r: Room) => r.origin.kind)).toBe('restored');
		cc.close();
		a.destroy();
	});

	it('a restart from storage alone reproduces the document and its state vector', async () => {
		const room = 'storage-restart';
		const a = seeded([para('p1', 'one'), para('p2', 'two')], 'ada');
		const ca = await RawClient.connect(room, a.doc);
		const cb = await RawClient.connect(room);
		await vi.waitFor(() => expect(cb.synced).toBe(true));
		const b = E.attachDocument(cb.doc, { actor: { id: 'bob' } });
		applied(a.transact(() => a.facade.insertText('p1', 3, ' uno')));
		applied(b.transact(() => b.facade.deleteText('p2', 0, 1))); // "wo"
		applied(b.transact(() => b.facade.deleteBlock('p1')));
		const expected = { children: [{ id: 'p2', type: 'paragraph', text: 'wo' }] };
		await vi.waitFor(() => {
			expect(shape(ca.json())).toEqual(expected);
			expect(shape(cb.json())).toEqual(expected);
		});
		await settle();
		const sv = Y.encodeStateVector(a.doc);
		ca.close();
		cb.close();
		await evictDurableObject(stubOf(room), { webSockets: 'close' });

		const restored = await runInDurableObject(stubOf(room), (r: Room) => ({
			origin: r.origin,
			json: readFacade(r.doc!, (facade) => facade.toJSON()),
			sv: Y.encodeStateVector(r.doc!)
		}));
		expect(restored.origin.kind).toBe('restored');
		expect(shape(restored.json)).toEqual(expected);
		expect(restored.json).toEqual(a.facade.toJSON());
		expect(Object.fromEntries(Y.decodeStateVector(restored.sv))).toEqual(
			Object.fromEntries(Y.decodeStateVector(sv))
		);
		a.destroy();
		b.destroy();
	});

	it('compaction replaces the rows with a chunked snapshot; a tail then a restore rebuild the doc', async () => {
		const room = 'storage-compaction';
		const long = 'lorem ipsum '.repeat(1000); // 12 000 chars → a multi-row snapshot
		const a = seeded([para('p1', 'head'), para('p2', long)], 'ada');
		const ca = await RawClient.connect(room, a.doc);
		await vi.waitFor(() => expect(ca.synced).toBe(true));
		applied(a.transact(() => a.facade.insertText('p1', 4, ' one')));
		applied(a.transact(() => a.facade.insertText('p1', 8, ' two')));
		await vi.waitFor(async () =>
			expect(shape(await serverJSON(room)).children[0]?.text).toBe('head one two')
		);
		const before = await rowsOf(room);
		expect(before.filter((r) => r.kind === 'update').length).toBeGreaterThanOrEqual(3);

		const response = await SELF.fetch(`${ORIGIN}/rooms/${room}/compact`, { method: 'POST' });
		expect(response.status).toBe(200);
		const compacted = await rowsOf(room);
		expect(compacted.map((r) => r.kind).filter((k) => k === 'update')).toEqual([]);
		expect(compacted[0]).toMatchObject({ kind: 'generation', part: 0, parts: 1 });
		const snapshot = compacted.filter((r) => r.kind === 'snapshot');
		expect(snapshot.length).toBeGreaterThan(1);
		expect(new Set(snapshot.map((r) => r.record)).size).toBe(1);
		expect(snapshot.map((r) => r.part)).toEqual(snapshot.map((_, i) => i));
		expect(snapshot.every((r) => r.parts === snapshot.length && r.size <= ROW_BYTES)).toBe(true);
		expect(await response.json()).toEqual({ rows: compacted.length });

		// A tail after the snapshot.
		applied(a.transact(() => a.facade.insertText('p1', 12, ' three')));
		await vi.waitFor(async () =>
			expect((await rowsOf(room)).some((r) => r.kind === 'update')).toBe(true)
		);
		ca.close();
		await settle();
		await evictDurableObject(stubOf(room));
		const cc = await RawClient.connect(room);
		await vi.waitFor(() => expect(cc.synced).toBe(true));
		expect(shape(cc.json())).toEqual({
			children: [
				{ id: 'p1', type: 'paragraph', text: 'head one two three' },
				{ id: 'p2', type: 'paragraph', text: long }
			]
		});
		expect(cc.json()).toEqual(a.facade.toJSON());
		cc.close();
		a.destroy();
	});

	it('a large update is one record split across rows no larger than the cap', async () => {
		const room = 'storage-large-update';
		const a = seeded([para('p1', '')], 'ada');
		const ca = await RawClient.connect(room, a.doc);
		await vi.waitFor(() => expect(ca.synced).toBe(true));
		await settle();
		const before = await rowsOf(room);
		const big = 'abcdefghij'.repeat(5000); // 50 000 chars in ONE transaction
		applied(a.transact(() => a.facade.insertText('p1', 0, big)));
		await vi.waitFor(async () =>
			expect((await rowsOf(room)).length).toBeGreaterThan(before.length)
		);
		const added = (await rowsOf(room)).slice(before.length);
		const records = new Set(added.map((r) => r.record));
		expect(records.size).toBe(1);
		expect(added.every((r) => r.kind === 'update' && r.size <= ROW_BYTES)).toBe(true);
		expect(added.length).toBe(Math.ceil(added.reduce((n, r) => n + r.size, 0) / ROW_BYTES));
		expect(added.length).toBeGreaterThanOrEqual(Math.ceil(big.length / ROW_BYTES));
		expect(added.map((r) => r.part)).toEqual(added.map((_, i) => i));

		ca.close();
		await settle();
		await evictDurableObject(stubOf(room));
		const text = await runInDurableObject(stubOf(room), (r: Room) =>
			readFacade(r.doc!, (facade) => facade.blockText('p1'))
		);
		expect(text).toBe(big);
		a.destroy();
	});

	it('a container of another generation never rebuilds: every socket is refused', async () => {
		const room = 'storage-tampered';
		const a = seeded([para('p1', 'hello')], 'ada');
		const ca = await RawClient.connect(room, a.doc);
		await vi.waitFor(() => expect(ca.synced).toBe(true));
		ca.close();
		await settle();
		await runInDurableObject(stubOf(room), (_r: Room, state) => {
			state.storage.sql.exec(
				"UPDATE rows SET bytes = ? WHERE kind = 'generation'",
				new TextEncoder().encode(
					JSON.stringify({ ...E.GENERATION_RECORD, schema: E.SCHEMA_VERSION + 1 })
				)
			);
		});
		await evictDurableObject(stubOf(room));
		const cc = await RawClient.connect(room);
		await vi.waitFor(() =>
			expect(cc.closed).toEqual({ code: 1011, reason: 'room container refused' })
		);
		const state = await runInDurableObject(stubOf(room), (r: Room) => ({
			doc: r.doc,
			failure: r.failure?.name,
			refusals: r.refusals.map((x) => x.reason)
		}));
		// One refusal per inbound event on the refused socket (the upgrade, then its SyncStep1).
		expect(state.doc).toBeNull();
		expect(state.failure).toBe('GenerationMismatchError');
		expect(new Set(state.refusals)).toEqual(new Set(['container']));
		a.destroy();
	});
});

describe('room Durable Object — the shipped headless client path', () => {
	it('createDocument + createWebsocketSync converge and share presence through the room', async () => {
		const room = 'shipped-path';
		const connect = (document: ReturnType<typeof E.createDocument>) =>
			document.attachSync(
				crdt.providers.createWebsocketSync({
					serverUrl: `${ORIGIN.replace('https', 'wss')}/rooms`,
					roomName: room,
					WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket
				})
			);
		const a = seeded([para('p1', 'hello')], 'ada');
		const releaseA = connect(a);
		// B joins once the room holds A's seed (a joiner that syncs with an EMPTY
		// room seeds its own default document — the local-first rule).
		await vi.waitFor(async () =>
			expect(shape(await serverJSON(room)).children[0]?.text).toBe('hello')
		);
		const b = E.createDocument({ actor: { id: 'bob' }, history: { captureTimeout: 0 } });
		const releaseB = connect(b);
		await vi.waitFor(() => expect(b.ready).toBe(true));
		expect(shape(b.facade.toJSON())).toEqual({
			children: [{ id: 'p1', type: 'paragraph', text: 'hello' }]
		});
		applied(a.transact(() => a.facade.insertText('p1', 5, ' world')));
		applied(
			b.transact(() =>
				b.facade.insertBlock({ parent: null, index: 1 }, { id: 'p2', type: 'paragraph' })
			)
		);
		applied(b.transact(() => b.facade.insertText('p2', 0, 'from bob')));
		const expected = {
			children: [
				{ id: 'p1', type: 'paragraph', text: 'hello world' },
				{ id: 'p2', type: 'paragraph', text: 'from bob' }
			]
		};
		await vi.waitFor(() => {
			expect(shape(a.facade.toJSON())).toEqual(expected);
			expect(shape(b.facade.toJSON())).toEqual(expected);
		});
		expect(b.facade.toJSON()).toEqual(a.facade.toJSON());

		b.awareness.setLocalStateField('user', { name: 'Bob' });
		await vi.waitFor(() =>
			expect((a.awareness.getStates().get(b.doc.clientID) as any)?.user).toEqual({ name: 'Bob' })
		);
		releaseB?.();
		b.destroy();
		await vi.waitFor(() => expect(a.awareness.getStates().has(b.doc.clientID)).toBe(false));
		releaseA?.();
		a.destroy();
		await vi.waitFor(async () =>
			expect(
				await runInDurableObject(stubOf(room), (_r: Room, state) => state.getWebSockets().length)
			).toBe(0)
		);
		expect(shape(await serverJSON(room))).toEqual(expected);
	});
});
