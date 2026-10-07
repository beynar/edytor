/**
 * `pnpm test:do` — the room's failure paths and lifecycle (adversarial
 * review 2026-09-29, UW-02/05/06/07/11/12/32/33/34): compaction outside the
 * update observer, the restore path (`onLoad` settles before anything is
 * stored; a refused payload refuses sockets instead of crash-looping; the
 * replica registry travels with `SavedDocument`), read-only replicas,
 * registry pruning, the generation cutover `reset()`, the presence echo,
 * the ping/pong keepalive, the capped refusal log and the 4403 denial. Faults are injected with SQLite `RAISE(ABORT)`
 * triggers and `HookedRoom` name prefixes (tests/do/worker.ts). Expected
 * values are hand-authored from the edits each test performs.
 */
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import type { HookedRoom } from './worker';
import {
	E,
	ORIGIN,
	REPLICA_TAKEN,
	RawClient,
	SelfWebSocket,
	Y,
	crdt,
	dialOutcome,
	dialResponse,
	para,
	readFacade,
	shape,
	upgrade,
	storedUpdate
} from './client';

const COMPACT_AFTER = 40; // tests/do/vitest.config.ts EDYTOR_COMPACT_AFTER

const hooked = (room: string) => env.HOOKED.getByName(room);
const inHooked = <T>(room: string, fn: (r: HookedRoom, state: DurableObjectState) => T) =>
	runInDurableObject(hooked(room), (r: HookedRoom, state) => fn(r, state));
const inRoom = <T>(room: string, fn: (r: Room, state: DurableObjectState) => T) =>
	runInDurableObject(env.ROOM.getByName(room), (r: Room, state) => fn(r, state));

const count = (state: DurableObjectState, table: string) =>
	state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;

/** The text of block `id` in what the room STORED (its rows, merged). */
const storedText = (r: Room, id: string) => {
	const stored = crdt.createDoc();
	Y.applyUpdate(stored, storedUpdate(r.records()));
	return readFacade(stored, (f) => f.blockText(id));
};

const loaded = { children: [{ id: 'seed', type: 'paragraph', text: 'from onLoad' }] };

describe('UW-02 · compaction runs after the ack, never inside the update observer', () => {
	it('an engine observer that throws once wedges every later update emit (why the room guards it)', () => {
		const doc = crdt.createDoc();
		let emits = 0;
		doc.on('update', () => {
			if (++emits === 1) throw new Error('observer failed');
		});
		expect(() => doc.get('meta').setAttr('x', 1)).toThrow('observer failed');
		doc.get('meta').setAttr('x', 2);
		doc.get('meta').setAttr('x', 3);
		expect(emits).toBe(1);
	});

	it('a failing compaction: every later update is stored, relayed and acknowledged; the sender stays', async () => {
		const room = 'compact-failure';
		const document = E.createDocument({ value: { children: [para('p', '')] } });
		const author = await RawClient.connect(room, document.doc, { user: 'ada' });
		await vi.waitFor(() => expect(author.stored()).toBe(true));
		const peer = await RawClient.connect(room, undefined, { user: 'bob' });
		await vi.waitFor(() => expect(peer.synced).toBe(true));
		await inRoom(room, (_r, state) =>
			state.storage.sql.exec(
				"CREATE TRIGGER fail_compaction BEFORE DELETE ON rows BEGIN SELECT RAISE(ABORT, 'injected compaction failure'); END"
			)
		);
		// Past the threshold: compaction is attempted (and fails) at least once.
		const own = document.doc.clientID;
		for (let i = 0; i < COMPACT_AFTER + 5; i++) {
			document.transact(() => document.facade.insertText('p', i, 'x'));
		}
		const clock = Y.decodeStateVector(Y.encodeStateVector(document.doc)).get(own)!;
		await vi.waitFor(() => expect(author.acks.at(-1)?.get(own)).toBe(clock));
		const expected = 'x'.repeat(COMPACT_AFTER + 5);
		await vi.waitFor(() => expect(readFacade(peer.doc, (f) => f.blockText('p'))).toBe(expected));
		const observed = await inRoom(room, (r) => ({
			stored: storedText(r, 'p'),
			storage: r.refusals.filter((x) => x.reason === 'storage').length > 0,
			others: r.refusals.filter((x) => x.reason !== 'storage').map((x) => x.reason)
		}));
		expect(observed).toEqual({ stored: expected, storage: true, others: [] });
		expect(author.closed).toBeNull();
		// Fixed storage: an explicit compaction goes through.
		const rows = await inRoom(room, (r, state) => {
			state.storage.sql.exec('DROP TRIGGER fail_compaction');
			return r.compact().rows;
		});
		expect(rows).toBeGreaterThanOrEqual(2);
		await evictDurableObject(env.ROOM.getByName(room));
		expect(await inRoom(room, (r) => readFacade(r.doc!, (f) => f.blockText('p')))).toBe(expected);
		author.close();
		peer.close();
		document.destroy();
	});
});

describe('UW-05 · onLoad settles before the room stores anything', () => {
	it('onLoad throws once: nothing is stored, the next start asks again and adopts it', async () => {
		const room = 'hooked-flaky-evict';
		const first = await inHooked(room, (r, state) => ({
			failure: r.failure?.message,
			doc: r.doc,
			rows: count(state, 'rows')
		}));
		expect(first).toEqual({ failure: 'store unavailable', doc: null, rows: 0 });
		await evictDurableObject(hooked(room));
		const second = await inHooked(room, (r, state) => ({
			failure: r.failure,
			json: shape(r.read()),
			calls: count(state, 'load_calls')
		}));
		expect(second).toEqual({ failure: null, json: loaded, calls: 2 });
	});

	it('onLoad throws once: the next dial retries it (the socket keeps the object warm)', async () => {
		const room = 'hooked-flaky-dial';
		expect(await inHooked(room, (r) => r.failure?.message)).toBe('store unavailable');
		const client = await RawClient.connect(room);
		await vi.waitFor(() => expect(shape(client.json())).toEqual(loaded));
		expect(client.closed).toBeNull();
		client.close();
	});

	it('onLoad returns nothing: provisional — asked again at each start until something is stored', async () => {
		const room = 'hooked-empty-provisional';
		const stats = () =>
			inHooked(room, (r, state) => ({
				origin: r.origin.kind,
				rows: count(state, 'rows'),
				calls: count(state, 'load_calls')
			}));
		expect(await stats()).toEqual({ origin: 'fresh', rows: 0, calls: 1 });
		await evictDurableObject(hooked(room));
		expect(await stats()).toEqual({ origin: 'fresh', rows: 0, calls: 2 });
		// The first stored record carries the generation record with it.
		await inHooked(room, (r) => r.transact((f) => f.insertText(f.listBlockIds()[0], 0, 'x')));
		const kinds = await inHooked(room, (r) => r.records().map((x) => x.kind));
		expect(kinds).toEqual(['generation', 'update', 'update']);
		await evictDurableObject(hooked(room));
		expect(await stats()).toEqual({ origin: 'restored', rows: 3, calls: 2 });
	});
});

describe('UW-06 · a refused onLoad payload or stored record refuses sockets instead of crash-looping', () => {
	for (const [room, failure] of [
		['hooked-badbytes-a', 'UndecodableUpdateError'],
		['hooked-badjson-a', 'TypeError']
	] as const) {
		it(`${room}: failure ${failure}, no document, nothing stored, dials refused (1008 container)`, async () => {
			const state = await inHooked(room, (r, st) => ({
				failure: r.failure?.name,
				doc: r.doc,
				rows: count(st, 'rows')
			}));
			expect(state).toEqual({ failure, doc: null, rows: 0 });
			const client = await RawClient.connect(room);
			await vi.waitFor(() =>
				expect(client.closed).toEqual({ code: 1008, reason: 'refused: container' })
			);
			// The object still answers (no reset loop), and logged the refusal.
			const reasons = await inHooked(room, (r) => r.refusals.map((x) => x.reason));
			expect(new Set(reasons)).toEqual(new Set(['container']));
		});
	}

	it('a torn stored record: failure recorded, sockets refused, the object keeps answering', async () => {
		const room = 'storage-torn';
		const document = E.createDocument({ value: { children: [para('p', 'hi')] } });
		const client = await RawClient.connect(room, document.doc);
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		client.close();
		await inRoom(room, (_r, state) =>
			state.storage.sql.exec(
				"INSERT INTO rows (kind, record, part, parts, bytes) VALUES ('update', 999, 0, 2, x'00')"
			)
		);
		await evictDurableObject(env.ROOM.getByName(room));
		expect(await inRoom(room, (r) => [r.failure?.message, r.doc])).toEqual(['torn record', null]);
		const dial = await RawClient.connect(room);
		await vi.waitFor(() =>
			expect(dial.closed).toEqual({ code: 1008, reason: 'refused: container' })
		);
		document.destroy();
	});
});

describe('UW-07 · the replica registry travels with the saved document', () => {
	/** Ada writes in a `hooked-restore*` room, the alarm saves, then the room's tables are wiped. */
	const writeSaveAndReset = async (room: string) => {
		const doc = crdt.createDoc();
		const tab = await RawClient.connect(room, doc, { user: 'ada', replica: doc.clientID });
		await vi.waitFor(() => expect(shape(tab.json())).toEqual(loaded));
		const ada = E.attachDocument(doc, { actor: { id: 'ada' } });
		ada.transact(() => ada.facade.insertText('seed', 0, 'ada: '));
		await vi.waitFor(() => expect(tab.acks.at(-1)?.get(doc.clientID)).toBeGreaterThan(0));
		expect(await runDurableObjectAlarm(hooked(room))).toBe(true);
		const saved = await inHooked(room, (_r, state) =>
			JSON.parse(
				state.storage.sql
					.exec<{ replicas: string }>('SELECT replicas FROM mirror ORDER BY rowid DESC LIMIT 1')
					.one().replicas
			)
		);
		tab.close();
		// A storage reset of the room's own tables (the host's mirror survives).
		await inHooked(room, (_r, state) => {
			state.storage.sql.exec('DELETE FROM rows');
			state.storage.sql.exec('DELETE FROM replicas');
		});
		await evictDurableObject(hooked(room));
		return { ada, doc, saved };
	};

	it('onSave hands the registry; a restore from { update, replicas } lets returning replicas in', async () => {
		const room = 'hooked-restore-a';
		const { ada, doc, saved } = await writeSaveAndReset(room);
		expect(saved).toEqual([{ replica: doc.clientID, user: 'ada' }]);
		// A fresh container, seeded from what onSave handed over.
		expect(await inHooked(room, (r) => [r.origin.kind, shape(r.read())])).toEqual([
			'fresh',
			{ children: [{ id: 'seed', type: 'paragraph', text: 'ada: from onLoad' }] }
		]);
		// The still-open tab redials with its replica: accepted.
		expect(await dialOutcome(room, { user: 'ada', replica: doc.clientID })).toBe('open');
		// The same tab edited while offline, under the same id: stored, no refusal.
		ada.transact(() => ada.facade.insertText('seed', 0, '[offline] '));
		const back = await RawClient.connect(room, doc, { user: 'ada', replica: doc.clientID });
		const expected = '[offline] ada: from onLoad';
		await vi.waitFor(async () =>
			expect(await inHooked(room, (r) => shape(r.read()).children[0].text)).toBe(expected)
		);
		expect(back.closed).toBeNull();
		expect(await inHooked(room, (r) => r.refusals.map((x) => x.reason))).toEqual([]);
		// Another user still cannot take Ada's id.
		expect(await dialOutcome(room, { user: 'eve', replica: doc.clientID })).toEqual(REPLICA_TAKEN);
		back.close();
		ada.destroy();
	});

	it('a bare update restore: an id with history is claimed by its first authenticated writer (logged)', async () => {
		const room = 'hooked-restore-bare-a';
		const { ada, doc } = await writeSaveAndReset(room);
		ada.transact(() => ada.facade.insertText('seed', 0, '[offline] '));
		const back = await RawClient.connect(room, doc, { user: 'ada', replica: doc.clientID });
		await vi.waitFor(async () =>
			expect(await inHooked(room, (r) => shape(r.read()).children[0].text)).toBe(
				'[offline] ada: from onLoad'
			)
		);
		expect(back.closed).toBeNull();
		const log = await inHooked(room, (r) => r.refusals);
		expect(log).toEqual([{ reason: 'orphan', detail: { replica: doc.clientID, user: 'ada' } }]);
		// Claimed: Ada's now, nobody else's.
		expect(await dialOutcome(room, { user: 'eve', replica: doc.clientID })).toEqual(REPLICA_TAKEN);
		back.close();
		ada.destroy();
	});
});

describe('UW-32 · read-only replicas are registered too', () => {
	it("a viewer's dialed or presence-bound replica cannot be claimed by a writer", async () => {
		const room = 'read-only-registered';
		const viewer = await RawClient.connect(room, undefined, {
			user: 'viv',
			replica: 7001,
			access: 'read'
		});
		await vi.waitFor(() => expect(viewer.synced).toBe(true));
		expect(await dialOutcome(room, { user: 'eve', replica: 7001 })).toEqual(REPLICA_TAKEN);
		const bare = await RawClient.connect(room, undefined, { user: 'viv', access: 'read' });
		bare.setPresence(7002, 1, { user: { name: 'Viv' } });
		await vi.waitFor(() => expect(bare.presence.get(7002)).toBeDefined());
		expect(await dialOutcome(room, { user: 'eve', replica: 7002 })).toEqual(REPLICA_TAKEN);
		// Viv, granted edit, redials with the same id.
		expect(await dialOutcome(room, { user: 'viv', replica: 7001 })).toBe('open');
		viewer.close();
		bare.close();
	});
});

describe('UW-33 · compaction prunes registrations without content', () => {
	it('ids with no content and no open socket are dropped; writers and open sockets are kept', async () => {
		const room = 'replicas-prune';
		const ada = E.createDocument({ value: { children: [para('p', 'hi')] }, actor: { id: 'ada' } });
		const writer = await RawClient.connect(room, ada.doc, {
			user: 'ada',
			replica: ada.doc.clientID
		});
		ada.transact(() => ada.facade.insertText('p', 2, '!'));
		await vi.waitFor(() => expect(writer.acks.at(-1)?.get(ada.doc.clientID)).toBeGreaterThan(0));
		for (const replica of [8001, 8002, 8003]) {
			const idle = await RawClient.connect(room, undefined, { user: 'bob', replica });
			await vi.waitFor(() => expect(idle.synced).toBe(true));
			idle.close();
		}
		const open = await RawClient.connect(room, undefined, { user: 'bob', replica: 8004 });
		await vi.waitFor(() => expect(open.synced).toBe(true));
		const registered = () =>
			inRoom(room, (_r, state) =>
				state.storage.sql
					.exec<{ replica: number }>('SELECT replica FROM replicas ORDER BY replica')
					.toArray()
					.map((x) => x.replica)
			);
		const before = await registered();
		expect(before).toEqual(expect.arrayContaining([8001, 8002, 8003, 8004, ada.doc.clientID]));
		const writers = await inRoom(room, (r) => [
			...Y.decodeStateVector(Y.encodeStateVector(r.doc!)).keys()
		]);
		await inRoom(room, (r) => r.compact());
		// Kept: every id holding content in the room, and the open socket's.
		expect(await registered()).toEqual([...writers, 8004].sort((a, b) => a - b));
		expect(writers).toContain(ada.doc.clientID);
		// A pruned id is free again (it holds no content).
		expect(await dialOutcome(room, { user: 'eve', replica: 8001 })).toBe('open');
		writer.close();
		open.close();
		ada.destroy();
	});
});

describe('UW-34 · generation cutover: reset()', () => {
	it('a container of another generation is dropped and reseeded from onLoad; a healthy room refuses reset', async () => {
		const room = 'hooked-cutover';
		const first = await RawClient.connect(room);
		await vi.waitFor(() => expect(shape(first.json())).toEqual(loaded));
		first.close();
		await expect(inHooked(room, (r) => r.reset())).rejects.toThrow(/another generation/);
		await inHooked(room, (_r, state) =>
			state.storage.sql.exec(
				"UPDATE rows SET bytes = ? WHERE kind = 'generation'",
				new TextEncoder().encode(
					JSON.stringify({ ...E.GENERATION_RECORD, schema: E.SCHEMA_VERSION + 1 })
				)
			)
		);
		await evictDurableObject(hooked(room));
		expect(await inHooked(room, (r) => r.failure?.name)).toBe('GenerationMismatchError');
		await inHooked(room, (r) => r.reset());
		expect(await inHooked(room, (r) => [r.failure, shape(r.read())])).toEqual([null, loaded]);
		const back = await RawClient.connect(room);
		await vi.waitFor(() => expect(shape(back.json())).toEqual(loaded));
		back.close();
	});
});

describe('UW-11 · a lone socket is not torn down', () => {
	it('the accepted presence entry is echoed to its sender', async () => {
		const room = 'presence-echo';
		const lone = await RawClient.connect(room, undefined, { user: 'ada', replica: 9001 });
		lone.setPresence(9001, 1, { user: { name: 'Ada' } });
		await vi.waitFor(() =>
			expect(lone.presence.get(9001)?.state).toEqual({ user: { name: 'Ada' } })
		);
		lone.close();
	});

	it('a lone shipped provider stays connected past the 30 s silence timeout', async () => {
		const room = 'presence-lone';
		const document = E.createDocument({ value: { children: [para('p', 'hi')] } });
		const provider = new crdt.providers.WebsocketProvider(
			`${ORIGIN.replace('https', 'wss')}/rooms`,
			room,
			document.doc,
			{
				awareness: document.awareness,
				WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
				disableBc: true
			}
		);
		const closes: unknown[] = [];
		provider.on('connection-close', (event: unknown) => closes.push(event));
		await vi.waitFor(() => expect(provider.synced).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 36_000));
		expect(closes).toEqual([]);
		provider.destroy();
		document.destroy();
	}, 45_000);

	/** Send `ping` on a fresh socket of `room`: the texts heard back and the close code, if any. */
	const ping = async (room: string) => {
		const ws = await upgrade(room, { user: 'ada' });
		const texts: string[] = [];
		let closed: number | null = null;
		ws.addEventListener('message', (e) => {
			if (typeof e.data === 'string') texts.push(e.data);
		});
		ws.addEventListener('close', (e) => {
			closed = e.code;
		});
		ws.send('ping');
		await vi.waitFor(() => expect(texts).toEqual(['pong']));
		await new Promise((resolve) => setTimeout(resolve, 200));
		ws.close();
		return { texts, closed };
	};

	it('the room answers a text ping with pong (auto-response); the socket stays open', async () => {
		const room = 'keepalive-raw';
		expect(await ping(room)).toEqual({ texts: ['pong'], closed: null });
		expect(await inRoom(room, (_r, state) => state.getWebSocketAutoResponse()?.request)).toBe(
			'ping'
		);
		expect(await inRoom(room, (r) => r.refusals)).toEqual([]);
	});

	it('without the auto-response (a host pair replaced it) the message handler answers', async () => {
		const room = 'keepalive-handler';
		await inRoom(room, (_r, state) => state.setWebSocketAutoResponse());
		expect(await ping(room)).toEqual({ texts: ['pong'], closed: null });
		expect(await inRoom(room, (r) => r.refusals)).toEqual([]);
	});

	it('a lone provider with no presence to echo is kept alive by ping/pong past 36 s', async () => {
		const room = 'keepalive-lone';
		const document = E.createDocument({ value: { children: [para('p', 'hi')] } });
		// No presence: nothing to renew, so nothing is echoed — only the pings are answered.
		document.awareness.setLocalState(null);
		const provider = new crdt.providers.WebsocketProvider(
			`${ORIGIN.replace('https', 'wss')}/rooms`,
			room,
			document.doc,
			{
				awareness: document.awareness,
				WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
				disableBc: true
			}
		);
		const closes: unknown[] = [];
		provider.on('connection-close', (event: unknown) => closes.push(event));
		await vi.waitFor(() => expect(provider.synced).toBe(true));
		let pongs = 0;
		const ws = provider.ws!;
		const read = ws.onmessage!.bind(ws);
		ws.onmessage = (event) => {
			if (event.data === 'pong') pongs++;
			read(event);
		};
		await new Promise((resolve) => setTimeout(resolve, 36_000));
		expect(closes).toEqual([]);
		expect(pongs).toBeGreaterThanOrEqual(1);
		provider.destroy();
		document.destroy();
	}, 45_000);
});

describe('UW-12 · refusals are bounded; a refused provider dials once', () => {
	it('the refusal log keeps the newest entries and counts every reason', async () => {
		const room = 'refusals-capped';
		const client = await RawClient.connect(room, undefined, { user: 'viv', access: 'read' });
		await vi.waitFor(() => expect(client.synced).toBe(true));
		const frame = E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, Uint8Array.of(0, 0)));
		for (let i = 0; i < 150; i++) client.send(frame);
		await vi.waitFor(
			async () => expect(await inRoom(room, (r) => r.refusalCounts['read-only'])).toBe(150),
			{ timeout: 10_000 }
		);
		expect(await inRoom(room, (r) => r.refusals.length)).toBe(100);
		client.close();
	});

	it("the shipped provider relaying another user's edits stays connected: the relay is stripped", async () => {
		const room = 'refused-provider';
		// Ada's offline edits, copied into Eve's document: Eve's handshake writes under Ada's id.
		const ada = E.createDocument({ value: { children: [para('p', 'hi')] }, actor: { id: 'ada' } });
		const tab = await RawClient.connect(room, ada.doc, { user: 'ada' });
		await vi.waitFor(() => expect(tab.stored()).toBe(true));
		tab.close();
		ada.transact(() => ada.facade.insertText('p', 2, '!'));
		const eve = E.createDocument();
		Y.applyUpdate(eve.doc, Y.encodeStateAsUpdate(ada.doc));
		let dials = 0;
		class Counted extends SelfWebSocket {
			constructor(url: string) {
				super(url);
				dials++;
			}
		}
		const provider = new crdt.providers.WebsocketProvider(
			`${ORIGIN.replace('https', 'wss')}/rooms`,
			room,
			eve.doc,
			{
				awareness: eve.awareness,
				params: { user: 'eve' },
				WebSocketPolyfill: Counted as unknown as typeof WebSocket,
				disableBc: true
			}
		);
		const refused: unknown[] = [];
		provider.on('refused', (refusal) => refused.push(refusal));
		await vi.waitFor(async () =>
			expect(await inRoom(room, (r) => r.refusals.map((x) => x.reason))).toContain('replica')
		);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		// One dial, still open; Ada's "!" is not stored under her id by Eve.
		expect(dials).toBe(1);
		expect(provider.wsconnected).toBe(true);
		expect(refused).toEqual([]);
		const observed = await inRoom(room, (r) => ({
			text: readFacade(r.doc!, (f) => f.blockText('p')),
			reasons: [...new Set(r.refusals.map((x) => [x.reason, x.detail]).map(String))]
		}));
		expect(observed).toEqual({ text: 'hi', reasons: [String(['replica', ada.doc.clientID])] });
		provider.destroy();
		ada.destroy();
		eve.destroy();
	});

	it('a dial authorize denies is accepted, then closed 4403 with a reason', async () => {
		const response = await dialResponse('denied-close', { user: 'denied' });
		expect(response.status).toBe(101);
		const ws = response.webSocket!;
		const closed = new Promise<[number, string]>((resolve) =>
			ws.addEventListener('close', (e) => resolve([e.code, e.reason]))
		);
		ws.accept();
		expect(await closed).toEqual([4403, 'document access denied']);
	});

	it('the shipped provider denied by authorize emits refused once and stops dialing', async () => {
		const document = E.createDocument();
		let dials = 0;
		class Counted extends SelfWebSocket {
			constructor(url: string) {
				super(url);
				dials++;
			}
		}
		const provider = new crdt.providers.WebsocketProvider(
			`${ORIGIN.replace('https', 'wss')}/rooms`,
			'denied-provider',
			document.doc,
			{
				awareness: document.awareness,
				params: { user: 'denied' },
				WebSocketPolyfill: Counted as unknown as typeof WebSocket,
				disableBc: true
			}
		);
		const refused: Array<{ code: number; reason: string }> = [];
		provider.on('refused', (r) => refused.push({ code: r.code, reason: r.reason }));
		await vi.waitFor(() => expect(refused).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(refused).toEqual([{ code: 4403, reason: 'document access denied' }]);
		expect(dials).toBe(1);
		expect(provider.shouldConnect).toBe(false);
		provider.destroy();
		document.destroy();
	});
});
