/**
 * The history store is pluggable (`room.history.store`,
 * `room.history.retention` in `docs/editor-delete-contract.md`): a
 * `HistoryStore` — `kvHistory`, `r2History`, `roomHistory` or any object
 * with its members — or, deprecated, a bare KV namespace. For each store:
 *
 * - a slot's version is written, listed (with its `expiresAt`), read back as
 *   the document and restored;
 * - expiry belongs to the room: no version is listed or read past its
 *   `expiresAt`, and for a store without a TTL of its own the alarm deletes
 *   it (`retention`);
 * - a version past the store's `maxValueBytes` (or the option's) is skipped;
 *   `roomHistory`'s table keeps under its `maxBytes`, oldest first;
 * - versions a 0.1.0-next.25 room wrote to KV list, read and restore.
 */
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
	kvHistory,
	r2History,
	roomHistory,
	type HistoryMetadata,
	type HistoryStore
} from '../../src/lib/cloudflare/index.js';
import { gunzip } from '../../src/lib/crdt/storage.js';
import type { JSONDoc } from '../../src/lib/crdt/index.js';
import { E, RawClient, para } from './client';
import { FakeKV, FakeR2, setNow, type TimedRoom } from './worker';

declare global {
	namespace Cloudflare {
		interface Env {
			TIMED: DurableObjectNamespace<TimedRoom>;
			HISTORY: KVNamespace;
			HISTORY_R2: R2Bucket;
		}
	}
}

const SLOW = { timeout: 10_000, interval: 25 };
const at = (iso: string) => Date.parse(iso);
const stub = (room: string) => env.TIMED.getByName(room);
const inRoom = <T>(room: string, fn: (r: TimedRoom, state: DurableObjectState) => T) =>
	runInDurableObject(stub(room), (r: TimedRoom, state) => fn(r, state));
const clockTo = (room: string, iso: string) =>
	inRoom(room, (_r, state) => setNow(state.storage.sql, at(iso)));
const fire = async (room: string) => {
	const ran = await runDurableObjectAlarm(stub(room));
	await inRoom(room, (r) => r.historyWritten());
	return ran;
};
const dues = (room: string) =>
	inRoom(room, (_r, state) =>
		Object.fromEntries(
			state.storage.sql
				.exec<{ key: string; value: number }>("SELECT key, value FROM meta WHERE key LIKE 'due.%'")
				.toArray()
				.map(({ key, value }) => [key, value])
		)
	);
const shape = (json: JSONDoc) => JSON.parse(JSON.stringify(json));
const roomJSON = (room: string) => inRoom(room, (r) => shape(r.read()));

const writer = async (room: string, user: string, text?: string) => {
	const children = [para('p1', text ?? 'one'), para('p2', 'two'), para('p3', 'three')];
	const document = E.createDocument({
		value: { children },
		actor: { id: user },
		history: { captureTimeout: 0 }
	});
	const client = await RawClient.connect(room, document.doc, {
		user,
		replica: document.doc.clientID
	});
	await vi.waitFor(() => expect(client.synced).toBe(true), SLOW);
	await vi.waitFor(async () => expect((await roomJSON(room)).children).toHaveLength(3), SLOW);
	return {
		document,
		client,
		done() {
			client.close();
			document.destroy();
		}
	};
};

/** Text gzip cannot shrink much (a pseudo-random sequence of `n` characters). */
const noise = (n: number, seed = 12345) => {
	let text = '';
	for (let i = 0, x = seed; i < n; i++) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		text += String.fromCharCode(33 + ((x >>> 16) % 90));
	}
	return text;
};

/** The keys each store holds for a room, read from its backing table (or binding). */
const heldKeys = async (room: string, store: Store): Promise<string[]> => {
	if (store.kind === 'env-r2') {
		const listed = await env.HISTORY_R2.list({ prefix: `history/${room}/` });
		return listed.objects.map((o) => o.key);
	}
	if (store.kind === 'env-kv') {
		const listed = await env.HISTORY.list({ prefix: `history/${room}/` });
		return listed.keys.map((k) => k.name);
	}
	const table =
		store.kind === 'r2'
			? 'fake_r2'
			: store.kind === 'sqlite' || store.kind === 'env-room'
				? 'history'
				: 'fake_kv';
	return inRoom(room, (_r, state) =>
		state.storage.sql
			.exec<{ key: string }>(`SELECT DISTINCT key FROM ${table} ORDER BY key`)
			.toArray()
			.map(({ key }) => key)
	);
};

type Store = {
	kind: 'kv' | 'kvstore' | 'r2' | 'sqlite' | 'env-kv' | 'env-r2' | 'env-room';
	/** The room-name infix that selects it (`storeOf` / `TimedRoom` in worker.ts). */
	infix: string;
	/** The store expires versions itself (KV): the room arms no `retention` task. */
	nativeTtl: boolean;
};
const STORES: Store[] = [
	{ kind: 'kv', infix: 'utc', nativeTtl: true },
	{ kind: 'kvstore', infix: 'kvstore', nativeTtl: true },
	{ kind: 'r2', infix: 'r2', nativeTtl: false },
	{ kind: 'sqlite', infix: 'sqlite', nativeTtl: false },
	{ kind: 'env-kv', infix: 'env-kv', nativeTtl: true },
	{ kind: 'env-r2', infix: 'env-r2', nativeTtl: false },
	{ kind: 'env-room', infix: 'env-room', nativeTtl: false }
];
const roomFor = (store: Store, what: string) =>
	store.kind.startsWith('env-') ? `timed-${store.infix}-${what}` : `timed-x-${store.infix}-${what}`;

describe('room.history.store · every store writes, lists, reads and restores', () => {
	for (const store of STORES) {
		it(`${store.kind}: a version is written at the slot's end, listed with its expiry, read and restored`, async () => {
			const room = roomFor(store, 'cycle');
			await clockTo(room, '2026-10-06T08:00:00Z');
			const ada = await writer(room, 'ada');
			await clockTo(room, '2026-10-06T12:00:00Z');
			await fire(room);
			const key = `history/${room}/2026-10-06-am`;
			expect(await heldKeys(room, store)).toEqual([key]);
			const listed = await inRoom(room, (r) => r.listHistory());
			const expiresAt = at('2026-11-05T12:00:00Z');
			expect(listed).toEqual([
				{
					key,
					date: '2026-10-06',
					slot: 'am',
					bytes: expect.any(Number),
					blocks: 3,
					editors: ['ada'],
					more: 0,
					at: at('2026-10-06T12:00:00Z'),
					// Real KV computes its expiry from its own clock: only the fakes match the room's.
					expiresAt: store.kind === 'env-kv' ? expect.any(Number) : expiresAt
				}
			]);
			// Only a store without its own TTL arms the room's retention task.
			expect((await dues(room))['due.retention']).toBe(store.nativeTtl ? undefined : expiresAt);
			const morning = await inRoom(room, (r) => r.readHistory(key));
			expect(shape(morning!)).toEqual(await roomJSON(room));
			// An afternoon edit, then the morning restored.
			await clockTo(room, '2026-10-06T13:00:00Z');
			ada.document.transact(() => {
				ada.document.facade.insertText('p1', 0, 'ONE ');
				ada.document.facade.deleteBlocks(['p2']);
			});
			await vi.waitFor(async () => expect((await roomJSON(room)).children).toHaveLength(2), SLOW);
			expect(await inRoom(room, (r) => r.restoreHistory(key, { user: 'carol' }))).toMatchObject({
				status: 'applied',
				revived: 1
			});
			await vi.waitFor(async () => {
				const json = await roomJSON(room);
				expect(json).toEqual(shape(morning!));
				expect(shape(ada.document.facade.toJSON())).toEqual(json);
			}, SLOW);
			ada.done();
		});
	}
});

describe('room.history.retention · expiry belongs to the room', () => {
	for (const store of STORES.filter((s) => !s.kind.startsWith('env-kv'))) {
		it(`${store.kind}: nothing past its expiresAt is listed or read; ${store.nativeTtl ? 'the store expires it' : 'the alarm deletes it'}`, async () => {
			const room = roomFor(store, 'expiry');
			await clockTo(room, '2026-10-06T08:00:00Z');
			const ada = await writer(room, 'ada');
			await clockTo(room, '2026-10-06T12:00:00Z');
			await fire(room);
			ada.document.transact(() => ada.document.facade.insertText('p1', 0, 'x'));
			await vi.waitFor(
				async () => expect((await roomJSON(room)).children[0].content[0].text).toBe('xone'),
				SLOW
			);
			await clockTo(room, '2026-10-07T00:00:00Z');
			await fire(room);
			const am = `history/${room}/2026-10-06-am`;
			const pm = `history/${room}/2026-10-06-pm`;
			expect(await heldKeys(room, store)).toEqual([am, pm]);
			// A minute past the morning's expiry: the evening is the only version.
			await clockTo(room, '2026-11-05T12:01:00Z');
			expect((await inRoom(room, (r) => r.listHistory())).map((v) => v.key)).toEqual([pm]);
			expect(await inRoom(room, (r) => r.readHistory(am))).toBeNull();
			expect(await inRoom(room, (r) => r.restoreHistory(am))).toEqual({
				status: 'refused',
				key: am
			});
			if (store.nativeTtl) {
				expect((await dues(room))['due.retention']).toBeUndefined();
			} else {
				// The store still holds it until the alarm's retention task runs.
				expect(await heldKeys(room, store)).toEqual([am, pm]);
				expect((await dues(room))['due.retention']).toBe(at('2026-11-05T12:00:00Z'));
				await fire(room);
				expect(await heldKeys(room, store)).toEqual([pm]);
				// Re-armed at the next version's expiry, then nothing left.
				expect((await dues(room))['due.retention']).toBe(at('2026-11-06T00:00:00Z'));
				await clockTo(room, '2026-11-06T00:00:00Z');
				await fire(room);
				expect(await heldKeys(room, store)).toEqual([]);
				expect((await dues(room))['due.retention']).toBeUndefined();
				expect(await inRoom(room, (r) => r.listHistory())).toEqual([]);
			}
			ada.done();
		});
	}

	it('a retention sweep that fails is noted and retried an hour later', async () => {
		const room = 'timed-x-r2-sweepfail';
		await clockTo(room, '2026-10-06T08:00:00Z');
		const ada = await writer(room, 'ada');
		await clockTo(room, '2026-10-06T12:00:00Z');
		await fire(room);
		await clockTo(room, '2026-11-05T12:00:00Z');
		await inRoom(room, (r) => {
			const doc = r.room as unknown as { historyConfig: { store: HistoryStore } };
			const store = doc.historyConfig.store;
			const remove = store.delete.bind(store);
			let failures = 1;
			(store as { delete: HistoryStore['delete'] }).delete = async (key) => {
				if (failures-- > 0) throw new Error('R2 delete failed (injected)');
				return remove(key);
			};
		});
		await fire(room);
		expect(
			await inRoom(room, (r) => r.refusals.find((x) => x.reason === 'history')?.detail)
		).toEqual({ retention: true, error: 'Error: R2 delete failed (injected)' });
		expect((await dues(room))['due.retention']).toBe(at('2026-11-05T13:00:00Z'));
		await clockTo(room, '2026-11-05T13:00:00Z');
		await fire(room);
		expect(await heldKeys(room, STORES[2])).toEqual([]);
		ada.done();
	});
});

describe('room.history.store · size caps', () => {
	for (const kind of ['r2', 'sqlite', 'kvstore'] as const) {
		it(`${kind}: a version past maxValueBytes is skipped and noted`, async () => {
			const room = `timed-cap-${kind}-a`;
			await clockTo(room, '2026-10-06T08:00:00Z');
			const ada = await writer(room, 'ada', noise(1500));
			await clockTo(room, '2026-10-06T12:00:00Z');
			await fire(room);
			expect(await inRoom(room, (r) => r.listHistory())).toEqual([]);
			const refusal = await inRoom(
				room,
				(r) => r.refusals.find((x) => x.reason === 'history')?.detail
			);
			expect(refusal).toEqual({
				key: `history/${room}/2026-10-06-am`,
				bytes: expect.any(Number),
				limit: 600
			});
			ada.done();
		});
	}

	it("the store's own maxValueBytes bounds the option: a larger option cannot raise it", async () => {
		// A custom store of 700 bytes, the option asking for 25 MiB: 700 wins.
		const sql: { put: number } = { put: 0 };
		const store: HistoryStore = {
			maxValueBytes: 700,
			async put() {
				sql.put++;
			},
			async get() {
				return null;
			},
			async list() {
				return { entries: [] };
			},
			async delete() {}
		};
		const room = 'timed-x-custom-cap';
		await clockTo(room, '2026-10-06T08:00:00Z');
		const ada = await writer(room, 'ada', noise(1500));
		await clockTo(room, '2026-10-06T12:00:00Z');
		const detail = await inRoom(room, async (r) => {
			const doc = r.room as unknown as { _history: unknown; options: object };
			doc._history = undefined;
			// The room's options read `history` through a getter: replace it.
			Object.defineProperty(doc.options, 'history', {
				value: { store, maxValueBytes: 25 * 1024 * 1024 }
			});
			await r.alarm();
			await r.historyWritten();
			return r.refusals.find((x) => x.reason === 'history')?.detail;
		});
		expect(detail).toMatchObject({ limit: 700 });
		expect(sql.put).toBe(0);
		ada.done();
	});

	it('roomHistory keeps its table under maxBytes: the oldest versions go first', async () => {
		const room = 'timed-x-sqlite-small-a';
		await clockTo(room, '2026-10-06T08:00:00Z');
		const ada = await writer(room, 'ada', noise(2200, 7));
		await clockTo(room, '2026-10-06T12:00:00Z');
		await fire(room);
		const am = `history/${room}/2026-10-06-am`;
		const pm = `history/${room}/2026-10-06-pm`;
		expect(await heldKeys(room, STORES[3])).toEqual([am]);
		ada.document.transact(() => ada.document.facade.insertText('p2', 0, noise(200, 9)));
		await vi.waitFor(
			async () => expect((await roomJSON(room)).children[1].content[0].text).toContain('two'),
			SLOW
		);
		await vi.waitFor(
			async () =>
				expect((await roomJSON(room)).children[1].content[0].text.length).toBeGreaterThan(200),
			SLOW
		);
		await clockTo(room, '2026-10-07T00:00:00Z');
		await fire(room);
		expect(await heldKeys(room, STORES[3])).toEqual([pm]);
		const bytes = await inRoom(
			room,
			(_r, state) =>
				state.storage.sql.exec<{ n: number }>('SELECT SUM(length(value)) AS n FROM history').one().n
		);
		expect(bytes).toBeLessThanOrEqual(4000);
		expect((await inRoom(room, (r) => r.listHistory())).map((v) => v.key)).toEqual([pm]);
		ada.done();
	});

	it('roomHistory splits a version over 1 MiB into rows, atomically, and reads it whole', async () => {
		const room = 'timed-x-sqlite-big';
		await inRoom(room, async (_r, state) => {
			const store = roomHistory()({
				sql: state.storage.sql,
				transactionSync: (fn) => state.storage.transactionSync(fn),
				tablePrefix: 'big_'
			});
			const value = new Uint8Array(2.5 * 1024 * 1024).map((_, i) => (i * 31) & 0xff);
			const metadata: HistoryMetadata = { bytes: value.length, blocks: 1, editors: [], at: 1 };
			await store.put('history/x/2026-10-06-am', value, { expiresAt: 10, metadata });
			const rows = state.storage.sql
				.exec<{ n: number }>('SELECT COUNT(*) AS n FROM big_history')
				.one().n;
			expect(rows).toBe(3);
			const read = await store.get('history/x/2026-10-06-am');
			expect(read!.expiresAt).toBe(10);
			expect(read!.value).toEqual(value);
			// Rewritten smaller: the old parts go with it.
			await store.put('history/x/2026-10-06-am', value.subarray(0, 10), {
				expiresAt: 11,
				metadata
			});
			expect(
				state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM big_history').one().n
			).toBe(1);
			expect((await store.list('history/x/')).entries).toEqual([
				{ key: 'history/x/2026-10-06-am', expiresAt: 11, metadata }
			]);
			await store.delete('history/x/2026-10-06-am');
			expect(await store.get('history/x/2026-10-06-am')).toBeNull();
		});
	});
});

describe('room.history.store · adapters over their bindings', () => {
	it('r2History reads what a listing without customMetadata would miss, and pages', async () => {
		await inRoom('timed-x-r2-adapter', async (_r, state) => {
			const store = r2History(new FakeR2(state.storage.sql));
			const metadata = (at: number): HistoryMetadata => ({
				bytes: 3,
				blocks: 1,
				editors: ['a'],
				at
			});
			for (const [i, date] of ['2026-10-01', '2026-10-02', '2026-10-03'].entries())
				await store.put(`history/r/${date}-am`, Uint8Array.of(1, 2, 3), {
					expiresAt: 100 + i,
					metadata: metadata(i)
				});
			await store.put('history/other/2026-10-01-am', Uint8Array.of(9), {
				expiresAt: 1,
				metadata: metadata(9)
			});
			const first = await store.list('history/r/');
			expect(first.entries).toHaveLength(2);
			expect(first.cursor).toBeDefined();
			const second = await store.list('history/r/', first.cursor);
			expect([...first.entries, ...second.entries]).toEqual([
				{ key: 'history/r/2026-10-01-am', expiresAt: 100, metadata: metadata(0) },
				{ key: 'history/r/2026-10-02-am', expiresAt: 101, metadata: metadata(1) },
				{ key: 'history/r/2026-10-03-am', expiresAt: 102, metadata: metadata(2) }
			]);
			expect(second.cursor).toBeUndefined();
			expect(await store.get('history/r/2026-10-02-am')).toEqual({
				value: Uint8Array.of(1, 2, 3),
				expiresAt: 101
			});
		});
	});

	it('kvHistory writes the 0.1.0-next.25 format: TTL, metadata, no expiry field', async () => {
		await inRoom('timed-x-kvstore-adapter', async (_r, state) => {
			const kv = new FakeKV(state.storage.sql, () => at('2026-10-06T12:00:00Z'));
			const store = kvHistory(kv);
			const metadata: HistoryMetadata = {
				bytes: 3,
				blocks: 1,
				editors: ['a'],
				at: at('2026-10-06T12:00:00Z')
			};
			await store.put('history/k/2026-10-06-am', Uint8Array.of(1, 2, 3), {
				expiresAt: at('2026-11-05T12:00:00Z'),
				metadata
			});
			const row = state.storage.sql
				.exec<{ ttl: number; metadata: string }>('SELECT ttl, metadata FROM fake_kv')
				.one();
			expect(row.ttl).toBe(30 * 86_400);
			expect(JSON.parse(row.metadata)).toEqual(metadata);
			expect((await store.list('history/k/')).entries).toEqual([
				{ key: 'history/k/2026-10-06-am', expiresAt: at('2026-11-05T12:00:00Z'), metadata }
			]);
		});
	});
});

describe('room.history.store · versions written by 0.1.0-next.25 (KV) keep working', () => {
	it('a next.25 KV version (bare namespace, no expiry in its metadata) lists, reads and restores through the env binding', async () => {
		// The bytes of a version: a room's own, read raw from its fake KV.
		const source = 'timed-x-utc-next25-source';
		await clockTo(source, '2026-10-06T08:00:00Z');
		const ada = await writer(source, 'ada', 'from next.25');
		await clockTo(source, '2026-10-06T12:00:00Z');
		await fire(source);
		const raw = await inRoom(
			source,
			(_r, state) =>
				new Uint8Array(
					state.storage.sql.exec<{ value: ArrayBuffer }>('SELECT value FROM fake_kv').one().value
				)
		);
		const sourceJSON = await roomJSON(source);
		ada.done();
		// next.25 wrote exactly this: the bare KV binding, `expirationTtl`, `{ bytes, blocks, editors, at }`.
		const room = 'timed-env-kv-next25';
		const key = `history/${room}/2026-10-05-pm`;
		await env.HISTORY.put(key, raw, {
			expirationTtl: 30 * 86_400,
			metadata: { bytes: raw.length, blocks: 3, editors: ['ada'], at: at('2026-10-06T00:00:00Z') }
		});
		await clockTo(room, '2026-10-06T08:00:00Z');
		const bob = await writer(room, 'bob');
		const listed = await inRoom(room, (r) => r.listHistory());
		expect(listed).toEqual([
			expect.objectContaining({
				key,
				date: '2026-10-05',
				slot: 'pm',
				bytes: raw.length,
				blocks: 3,
				editors: ['ada'],
				expiresAt: expect.any(Number)
			})
		]);
		expect(shape((await inRoom(room, (r) => r.readHistory(key)))!)).toEqual(sourceJSON);
		expect(await inRoom(room, (r) => r.restoreHistory(key))).toMatchObject({ status: 'applied' });
		await vi.waitFor(async () => expect(await roomJSON(room)).toEqual(sourceJSON), SLOW);
		// The bytes are the gzip of a v2 state, as before.
		expect((await gunzip(raw)).length).toBeGreaterThan(raw.length / 4);
		bob.done();
	});
});
