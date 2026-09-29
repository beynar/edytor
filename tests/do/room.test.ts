/**
 * `pnpm test:do` — the SHIPPED room Durable Object (`edytor/cloudflare`,
 * `src/lib/cloudflare`) in the real Workers runtime: SQLite storage,
 * hibernatable sockets, eviction through `evictDurableObject`. Clients dial
 * the Worker route (`routeDocumentSocket`) over real WebSocket upgrades
 * (`SELF.fetch`). Expected values are hand-authored from the edits each
 * test performs.
 */
import { env } from 'cloudflare:workers';
import { SELF, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { noTimers, type DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import {
	E,
	ORIGIN,
	RawClient,
	SelfWebSocket,
	Y,
	crdt,
	dialResponse,
	readFacade,
	para,
	presenceFrame,
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

// tests/do/vitest.config.ts
const ROW_BYTES = 4096; // EDYTOR_MAX_ROW_BYTES
const FRAME_BYTES = 16384; // EDYTOR_MAX_FRAME_BYTES
const COMPACT_AFTER = 40; // EDYTOR_COMPACT_AFTER

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

	it('a container of another generation never rebuilds: every socket is refused for good (1008)', async () => {
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
		await vi.waitFor(() => expect(cc.closed).toEqual({ code: 1008, reason: 'refused: container' }));
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
		// The room stored both edits (the clients may converge with each other first,
		// over the cross-tab channel they share in this isolate).
		await vi.waitFor(async () => expect(shape(await serverJSON(room))).toEqual(expected));

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

describe('room Durable Object — identity (routeDocumentSocket + the bound socket)', () => {
	/** Updates `write` produces on a doc holding `source`'s state, written as client `clientID`. */
	const forged = (
		source: ReturnType<typeof crdt.createDoc>,
		clientID: number,
		write: (document: ReturnType<typeof E.attachDocument>) => void
	) => {
		const doc = crdt.createDoc();
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
		doc.clientID = clientID;
		const out: Uint8Array[] = [];
		doc.on('update', (u: Uint8Array) => out.push(u));
		const document = E.attachDocument(doc, { actor: { id: 'eve' } });
		write(document);
		document.destroy();
		return Y.mergeUpdates(out as Uint8Array<ArrayBuffer>[]);
	};

	const attachmentsOf = (room: string) =>
		runInDurableObject(stubOf(room), (_r: Room, state) =>
			state.getWebSockets().map((ws) => ws.deserializeAttachment())
		);

	it('authorizes before reaching the room (denied: closed 4403; 426) and forwards only the verified identity', async () => {
		const room = 'identity-route';
		const denied = await dialResponse(room, { user: 'denied' });
		expect(denied.status).toBe(101);
		denied.webSocket!.accept();
		expect(await attachmentsOf(room)).toEqual([]);
		const plain = await SELF.fetch(`${ORIGIN}/rooms/${room}`);
		expect([plain.status, plain.webSocket]).toEqual([426, null]);

		// The client forges the room's identity headers; the router drops them.
		const response = await dialResponse(
			room,
			{ user: 'eve', access: 'read' },
			{ 'X-Edytor-User': 'ada', 'X-Edytor-Access': 'write', 'X-Edytor-Replica': '7' }
		);
		expect(response.status).toBe(101);
		response.webSocket!.accept();
		expect(await attachmentsOf(room)).toEqual([
			{ user: 'eve', replica: null, readOnly: true, clock: null }
		]);
		// The room itself refuses a request without the router's headers.
		const direct = await stubOf(room).fetch(`${ORIGIN}/rooms/${room}`, {
			headers: { Upgrade: 'websocket' }
		});
		expect(direct.status).toBe(401);
		response.webSocket!.close();
	});

	it("refuses an update writing structs under another user's client id (1008): never applied, stored or relayed", async () => {
		const room = 'identity-forged-client';
		const a = seeded([para('p1', 'hello')], 'ada');
		const ada = a.doc.clientID;
		const ca = await RawClient.connect(room, a.doc, { user: 'ada', replica: ada });
		const cb = await RawClient.connect(room, undefined, { user: 'bob' });
		await vi.waitFor(() => expect(shape(cb.json()).children[0]?.text).toBe('hello'));
		await settle();
		const rowsBefore = await rowsOf(room);
		const receivedBefore = cb.received.length;
		const jsonBefore = JSON.stringify(ca.json());

		// Eve continues Ada's clock: new structs attributed to Ada's client id.
		const eve = await RawClient.bare(room, { user: 'eve' });
		eve.send(
			E.frame(E.messageSync, (e) =>
				crdt.sync.writeUpdate(
					e,
					forged(a.doc, ada, (d) => d.facade.insertText('p1', 0, 'FORGED '))
				)
			)
		);
		await vi.waitFor(() => expect(eve.closed).toEqual({ code: 1008, reason: 'refused: replica' }));
		// …and cannot bind Ada's replica to her socket either.
		const claim = await dialResponse(room, { user: 'eve', replica: ada });
		expect([claim.status, claim.webSocket]).toEqual([403, null]);

		await settle();
		expect(await rowsOf(room)).toEqual(rowsBefore);
		expect(cb.received.length).toBe(receivedBefore);
		expect(JSON.stringify(await serverJSON(room))).toBe(jsonBefore);
		expect(JSON.stringify(cb.json())).toBe(jsonBefore);
		expect((await refusalsOf(room)).map((r) => [r.reason, r.detail])).toEqual([
			['replica', ada],
			['replica', ada]
		]);
		// Ada keeps writing under her id.
		expect(ca.closed).toBeNull();
		applied(a.transact(() => a.facade.insertText('p1', 5, '!')));
		await vi.waitFor(() => expect(shape(cb.json()).children[0].text).toBe('hello!'));
		ca.close();
		cb.close();
		a.destroy();
	});

	it('a user writes under every client id they own: a reloaded replica replays its offline edits', async () => {
		const room = 'identity-reload';
		const first = seeded([para('p1', 'hello')], 'ada');
		const c1 = await RawClient.connect(room, first.doc, {
			user: 'ada',
			replica: first.doc.clientID
		});
		await vi.waitFor(async () =>
			expect(shape(await serverJSON(room)).children[0]?.text).toBe('hello')
		);
		c1.close();
		// Offline, under the first replica's id; then the page reloads: a new
		// client id holding the old one's unsent edit (IndexedDB's role).
		applied(first.transact(() => first.facade.insertText('p1', 5, ' offline')));
		const reloaded = crdt.createDoc();
		Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(first.doc));
		expect(reloaded.clientID).not.toBe(first.doc.clientID);

		// Another user holding the same bytes may not deliver them.
		const mallory = await RawClient.connect(room, reloaded, { user: 'mallory' });
		await vi.waitFor(() =>
			expect(mallory.closed).toEqual({ code: 1008, reason: 'refused: replica' })
		);
		expect(shape(await serverJSON(room)).children[0].text).toBe('hello');

		const c2 = await RawClient.connect(room, reloaded, { user: 'ada', replica: reloaded.clientID });
		await vi.waitFor(async () =>
			expect(shape(await serverJSON(room)).children[0]?.text).toBe('hello offline')
		);
		expect(c2.closed).toBeNull();
		c2.close();
		first.destroy();
	});

	it('a replica the room never saw: local-only edits restored under a new client id are accepted on reconnect', async () => {
		const room = 'identity-local-only';
		const ada = seeded([para('p1', 'hello')], 'ada');
		const ca = await RawClient.connect(room, ada.doc, { user: 'ada', replica: ada.doc.clientID });
		await vi.waitFor(async () =>
			expect(shape(await serverJSON(room)).children[0]?.text).toBe('hello')
		);
		// Bob's whole first session is offline: the same deterministic seed,
		// then an edit under a client id the room has never seen.
		const offline = seeded([para('p1', 'hello')], 'bob');
		applied(offline.transact(() => offline.facade.insertText('p1', 0, 'bob: ')));
		// The page reloads, still offline (the local store's role), then dials
		// on the shipped client path under a new client id.
		const reloaded = E.loadDocument(offline.encode(), { actor: { id: 'bob' } });
		expect(reloaded.doc.clientID).not.toBe(offline.doc.clientID);
		const release = reloaded.attachSync(
			crdt.providers.createWebsocketSync({
				serverUrl: `${ORIGIN.replace('https', 'wss')}/rooms`,
				roomName: room,
				params: { user: 'bob', replica: String(reloaded.doc.clientID) },
				WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket
			})
		);
		const expected = { children: [{ id: 'p1', type: 'paragraph', text: 'bob: hello' }] };
		await vi.waitFor(async () => expect(shape(await serverJSON(room))).toEqual(expected));
		await vi.waitFor(() => expect(shape(ca.json())).toEqual(expected));
		expect(await refusalsOf(room)).toEqual([]);
		release?.();
		ca.close();
		for (const document of [ada, offline, reloaded]) document.destroy();
	});

	it("presence is relayed only for the socket's own replica; a presence-bound replica is its user's", async () => {
		const room = 'identity-presence';
		const ca = await RawClient.connect(room, undefined, { user: 'ada', replica: 11 });
		const cb = await RawClient.connect(room, undefined, { user: 'bob' });
		ca.setPresence(11, 1, { user: { name: 'Ada' } });
		await vi.waitFor(() => expect(cb.presence.get(11)?.state).toEqual({ user: { name: 'Ada' } }));
		// An entry for another replica (a re-sent peer entry, or a spoof) is dropped.
		ca.setPresence(22, 1, { user: { name: 'Not Ada' } });
		// Bob's socket binds its replica with its first entry…
		cb.setPresence(33, 1, { user: { name: 'Bob' } });
		await vi.waitFor(() => expect(ca.presence.get(33)?.state).toEqual({ user: { name: 'Bob' } }));
		expect(cb.presence.has(22)).toBe(false);
		expect((await attachmentsOf(room)).map((a: any) => [a.user, a.replica]).sort()).toEqual([
			['ada', 11],
			['bob', 33]
		]);
		// …which another user cannot take, by presence or by the dial.
		const eve = await RawClient.connect(room, undefined, { user: 'eve' });
		eve.setPresence(33, 9, { user: { name: 'Fake Bob' } });
		await vi.waitFor(() => expect(eve.closed).toEqual({ code: 1008, reason: 'refused: replica' }));
		expect(ca.presence.get(33)?.state).toEqual({ user: { name: 'Bob' } });
		expect((await dialResponse(room, { user: 'eve', replica: 11 })).status).toBe(403);
		ca.close();
		cb.close();
	});

	it('a read-only socket catches up and shares presence; its writes are refused, never stored or relayed', async () => {
		const room = 'identity-read-only';
		const a = seeded([para('p1', 'hello')], 'ada');
		const ca = await RawClient.connect(room, a.doc, { user: 'ada' });
		await vi.waitFor(async () =>
			expect(shape(await serverJSON(room)).children[0]?.text).toBe('hello')
		);
		const viewer = await RawClient.connect(room, undefined, { user: 'viv', access: 'read' });
		await vi.waitFor(() => expect(viewer.synced).toBe(true));
		expect(shape(viewer.json()).children[0].text).toBe('hello');
		expect(viewer.step1s).toBe(0); // the room never asks a viewer for its state
		await settle();
		const rowsBefore = await rowsOf(room);
		const receivedBefore = ca.received.length;

		const v = E.attachDocument(viewer.doc, { actor: { id: 'viv' } });
		applied(v.transact(() => v.facade.insertText('p1', 0, 'VIEWER ')));
		await vi.waitFor(() => expect(viewer.denied.length).toBeGreaterThan(0));
		await settle();
		// One denial per write frame (the edit, and the actor record attaching wrote).
		const refusals = (await refusalsOf(room)).map((r) => r.reason);
		expect(new Set(refusals)).toEqual(new Set(['read-only']));
		expect(viewer.denied).toEqual(refusals.map(() => 'read-only'));
		expect(viewer.closed).toBeNull();
		expect(await rowsOf(room)).toEqual(rowsBefore);
		expect(ca.received.length).toBe(receivedBefore);
		expect(shape(await serverJSON(room)).children[0].text).toBe('hello');

		// Presence is not a write: the viewer's caret reaches Ada.
		viewer.setPresence(viewer.doc.clientID, 1, { user: { name: 'Viv' } });
		await vi.waitFor(() =>
			expect(ca.presence.get(viewer.doc.clientID)?.state).toEqual({ user: { name: 'Viv' } })
		);
		// Ada's edits still reach the viewer (its own refused edit stays local).
		applied(a.transact(() => a.facade.insertText('p1', 5, '!')));
		await vi.waitFor(() => expect(shape(viewer.json()).children[0].text).toBe('VIEWER hello!'));
		await vi.waitFor(async () =>
			expect(shape(await serverJSON(room)).children[0].text).toBe('hello!')
		);
		ca.close();
		viewer.close();
		v.destroy();
		a.destroy();
	});
});

describe('room Durable Object — store-before-ack', () => {
	it("saved/unsaved follow the room's acknowledgements; an acknowledged edit is in storage", async () => {
		const room = 'saved-signal';
		const a = seeded([para('p1', 'hello')], 'ada');
		const provider = new crdt.providers.WebsocketProvider(
			`${ORIGIN.replace('https', 'wss')}/rooms`,
			room,
			a.doc,
			{ awareness: a.awareness, WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket }
		);
		const events: Array<{ saved: boolean; unsaved: number }> = [];
		provider.on('saved', (state) => events.push(state));
		// The seed is held locally and not yet in the room.
		expect([provider.saved, provider.unsaved]).toEqual([false, 1]);
		await vi.waitFor(() => expect(provider.saved).toBe(true));
		expect(events).toEqual([{ saved: true, unsaved: 0 }]);
		expect(shape(await serverJSON(room)).children[0].text).toBe('hello');

		// Offline: each local update is unsaved.
		provider.disconnect();
		applied(a.transact(() => a.facade.insertText('p1', 5, ' one')));
		applied(a.transact(() => a.facade.insertText('p1', 9, ' two')));
		applied(a.transact(() => a.facade.insertText('p1', 13, ' three')));
		expect([provider.saved, provider.unsaved]).toEqual([false, 3]);
		expect(events.slice(1)).toEqual([
			{ saved: false, unsaved: 1 },
			{ saved: false, unsaved: 2 },
			{ saved: false, unsaved: 3 }
		]);
		await settle();
		expect(shape(await serverJSON(room)).children[0].text).toBe('hello');

		provider.connect();
		await vi.waitFor(() => expect(provider.saved).toBe(true));
		expect(events.at(-1)).toEqual({ saved: true, unsaved: 0 });
		// What the room acknowledged is in its rows: a restore from storage
		// alone (memory gone, sockets kept) holds it.
		await evictDurableObject(stubOf(room));
		expect(shape(await serverJSON(room)).children[0].text).toBe('hello one two three');
		expect(await runInDurableObject(stubOf(room), (r: Room) => r.origin.kind)).toBe('restored');

		// Online: an edit is unsaved until its acknowledgement arrives.
		applied(a.transact(() => a.facade.insertText('p1', 0, '> ')));
		expect(provider.unsaved).toBe(1);
		await vi.waitFor(() => expect(provider.saved).toBe(true));
		provider.destroy();
		a.destroy();
	});

	it('every sync message is answered with the room state vector, after the write', async () => {
		const room = 'saved-raw';
		const a = seeded([para('p1', 'hello')], 'ada');
		const ca = await RawClient.connect(room, a.doc);
		await vi.waitFor(() => expect(ca.acks.length).toBeGreaterThanOrEqual(2));
		applied(a.transact(() => a.facade.insertText('p1', 5, '?')));
		const own = a.doc.clientID;
		const clock = Y.decodeStateVector(Y.encodeStateVector(a.doc)).get(own)!;
		await vi.waitFor(() => expect(ca.acks.at(-1)?.get(own)).toBe(clock));
		// The stored records alone, rebuilt into a fresh doc (P8 pruned `createDocFromUpdate`).
		const stored = await runInDurableObject(stubOf(room), (r: Room) => {
			const rebuilt = crdt.createDoc();
			Y.applyUpdate(
				rebuilt,
				Y.mergeUpdates(
					r
						.records()
						.slice(1)
						.map((x) => x.bytes)
				)
			);
			return Y.decodeStateVector(Y.encodeStateVector(rebuilt)).get(own);
		});
		expect(stored).toBe(clock);
		ca.close();
		a.destroy();
	});
});

describe('room Durable Object — bounded catch-up', () => {
	const big = (n: number) => 'lorem ipsum dolor sit amet '.repeat(n);

	it('the chunk codec: small frames pass whole; a sequence reads only when complete', () => {
		const small = E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, new Uint8Array(10)));
		expect(E.chunkFrame(small, 64)).toEqual([small]);
		const whole = E.frame(E.messageSync, (e) =>
			crdt.sync.writeUpdate(e, new Uint8Array(500).fill(7))
		);
		const pieces = E.chunkFrame(whole, 64);
		expect(pieces.length).toBeGreaterThan(2);
		expect(pieces.every((p) => p.length <= 64)).toBe(true);
		const body = (piece: Uint8Array) => {
			const decoder = E.createDecoder(piece);
			expect(E.readProtocolVersion(decoder)).toBe(true);
			expect(E.readVarUint(decoder)).toBe(E.messageChunk);
			return decoder;
		};
		const read = E.createChunkReader();
		const out = pieces.map((piece) => read(body(piece)));
		expect(out.slice(0, -1).every((x) => x === null)).toBe(true);
		expect(out.at(-1)).toEqual(whole);
		// Truncated (end before every part) and orphaned parts throw.
		const truncated = E.createChunkReader();
		truncated(body(pieces[0]));
		truncated(body(pieces[1]));
		expect(() => truncated(body(pieces.at(-1)!))).toThrow('incomplete chunked frame');
		expect(() => E.createChunkReader()(body(pieces[1]))).toThrow('without a start');
	});

	it('a document larger than one frame reaches late joiners as chunks, applied once complete', async () => {
		const room = 'catch-up-chunked';
		const a = seeded([para('p1', 'head'), para('p2', big(3000))], 'ada'); // ~81 KB
		const ca = await RawClient.connect(room, a.doc);
		await vi.waitFor(async () =>
			expect(shape(await serverJSON(room)).children[0]?.text).toBe('head')
		);

		// A raw late joiner: every frame within the limit, the Step2 reassembled.
		const cb = await RawClient.connect(room);
		await vi.waitFor(() => expect(cb.synced).toBe(true));
		expect(cb.received.every((frame) => frame.length <= FRAME_BYTES)).toBe(true);
		expect(cb.reassembled.length).toBeGreaterThanOrEqual(1);
		expect(cb.reassembled[0].length).toBeGreaterThan(FRAME_BYTES);
		expect(cb.json()).toEqual(a.facade.toJSON());

		// The shipped provider path catches up the same way.
		const b = E.createDocument({ actor: { id: 'bob' }, history: { captureTimeout: 0 } });
		const release = b.attachSync(
			crdt.providers.createWebsocketSync({
				serverUrl: `${ORIGIN.replace('https', 'wss')}/rooms`,
				roomName: room,
				WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket
			})
		);
		await vi.waitFor(() => expect(b.ready).toBe(true));
		expect(b.facade.toJSON()).toEqual(a.facade.toJSON());

		// A live update larger than one frame is broadcast in chunks too.
		const before = cb.reassembled.length;
		applied(a.transact(() => a.facade.insertText('p1', 4, big(1500))));
		await vi.waitFor(() => {
			expect(cb.json()).toEqual(a.facade.toJSON());
			expect(b.facade.toJSON()).toEqual(a.facade.toJSON());
		});
		expect(cb.reassembled.length).toBeGreaterThan(before);
		expect(cb.received.every((frame) => frame.length <= FRAME_BYTES)).toBe(true);
		release?.();
		b.destroy();
		ca.close();
		cb.close();
		a.destroy();
	});
});

describe('room Durable Object — automatic compaction', () => {
	it(`after ${COMPACT_AFTER} update records the rows are merged into one snapshot; a restore rebuilds the doc`, async () => {
		const room = 'compaction-auto';
		const a = seeded([para('p1', '')], 'ada');
		const ca = await RawClient.connect(room, a.doc);
		await vi.waitFor(() => expect(ca.synced).toBe(true));
		for (let i = 0; i < COMPACT_AFTER + 5; i++) {
			applied(a.transact(() => a.facade.insertText('p1', i, String(i % 10))));
		}
		const text = Array.from({ length: COMPACT_AFTER + 5 }, (_, i) => String(i % 10)).join('');
		await vi.waitFor(async () =>
			expect(shape(await serverJSON(room)).children[0]?.text).toBe(text)
		);
		const rows = await rowsOf(room);
		expect(rows[0]).toMatchObject({ kind: 'generation' });
		expect(rows.filter((r) => r.kind === 'snapshot').length).toBeGreaterThanOrEqual(1);
		expect(rows.filter((r) => r.kind === 'update').length).toBeLessThan(COMPACT_AFTER);
		ca.close();
		await settle();
		await evictDurableObject(stubOf(room));
		const cc = await RawClient.connect(room);
		await vi.waitFor(() => expect(cc.synced).toBe(true));
		expect(cc.json()).toEqual(a.facade.toJSON());
		cc.close();
		a.destroy();
	});
});
