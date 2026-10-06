/**
 * Phase 2, P5 — the room's snapshots are v2 and compressed, tagged in the
 * generation record (`room.store.v2` in `docs/editor-delete-contract.md`):
 *
 * - a fresh container's record says `storage: 'v2'`; its snapshot is v2,
 *   then compressed in place (gzip), and a woken room inflates it;
 * - a container written by 0.1.0-next.22 (a record without `storage`, v1
 *   rows) loads, takes v1 updates beside its rows, and its first
 *   compaction rewrites it in v2;
 * - a compressed snapshot that does not inflate, or a storage format this
 *   build does not read, refuses the container (`1008`, `container`).
 */
import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import { E, RawClient, Y, dialOutcome, para, readFacade, storedUpdate } from './client';

/** `vi.waitFor` under a loaded pool: the default 1 s is short for a room's round trips. */
const SLOW = { timeout: 10_000, interval: 25 };

const stubOf = (room: string) => env.ROOM.getByName(room);
const inRoom = <T>(room: string, fn: (r: Room, state: DurableObjectState) => T) =>
	runInDurableObject(stubOf(room), (r: Room, state) => fn(r, state));

type RawRow = { kind: string; record: number; part: number; bytes: ArrayBuffer };
const rowsOf = (room: string) =>
	inRoom(room, (_r, state) =>
		state.storage.sql
			.exec<RawRow>('SELECT kind, record, part, bytes FROM rows ORDER BY seq')
			.toArray()
			.map((row) => ({ ...row, bytes: new Uint8Array(row.bytes) }))
	);

const generationOf = (rows: Array<{ kind: string; bytes: Uint8Array }>) =>
	JSON.parse(new TextDecoder().decode(rows.find((row) => row.kind === 'generation')!.bytes));

const isGzip = (bytes: Uint8Array) => bytes[0] === 0x1f && bytes[1] === 0x8b;

const textOf = (room: string) => inRoom(room, (r) => readFacade(r.doc!, (f) => f.toJSON()));

/** Replace a room's rows with `rows` (as an older build or a corruption left them), then wake it. */
const storeRows = async (
	room: string,
	rows: Array<{ kind: string; bytes: Uint8Array }>,
	replicas: Array<{ replica: number; user: string }> = []
) => {
	await inRoom(room, (_r, state) => {
		state.storage.transactionSync(() => {
			state.storage.sql.exec('DELETE FROM rows');
			for (const { replica, user } of replicas) {
				state.storage.sql.exec('INSERT INTO replicas (replica, user) VALUES (?, ?)', replica, user);
			}
			rows.forEach(({ kind, bytes }, record) =>
				state.storage.sql.exec(
					'INSERT INTO rows (kind, record, part, parts, bytes) VALUES (?, ?, 0, 1, ?)',
					kind,
					record,
					bytes
				)
			);
		});
	});
	await evictDurableObject(stubOf(room));
};

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** The generation record 0.1.0-next.22 wrote (no storage format: v1 rows). */
const NEXT22_RECORD = { engine: 'yjs-v14', protocol: E.PROTOCOL_VERSION, schema: E.SCHEMA_VERSION };

describe('P5 · room snapshots in v2, compressed', () => {
	it('a fresh container is v2: the snapshot is compressed in place, and a woken room inflates it', async () => {
		const room = 'p5-fresh';
		const a = E.createDocument({
			value: { children: [para('p', 'lorem ipsum '.repeat(500))] },
			actor: { id: 'ada' }
		});
		const client = await RawClient.connect(room, a.doc, { user: 'ada', replica: a.doc.clientID });
		await vi.waitFor(() => expect(client.synced).toBe(true), SLOW);
		a.transact(() => a.facade.insertText('p', 0, 'one '));
		await vi.waitFor(
			async () =>
				expect(await inRoom(room, (r) => Y.encodeStateVector(r.doc!))).toEqual(
					Y.encodeStateVector(a.doc)
				),
			SLOW
		);
		const raw = await inRoom(room, (r) => {
			r.compact();
			const snapshot = r.records().find((record) => record.kind === 'snapshot')!;
			return { v2: snapshot.v2, length: snapshot.bytes.length, first: snapshot.bytes[0] };
		});
		expect(raw).toMatchObject({ v2: true, first: 0 }); // a v2 update's feature flag
		await inRoom(room, (r) => r.compressed());
		const rows = await rowsOf(room);
		expect(generationOf(rows)).toEqual({ ...NEXT22_RECORD, storage: 'v2' });
		const snapshot = rows.filter((row) => row.kind === 'snapshot');
		expect(isGzip(snapshot[0].bytes)).toBe(true);
		expect(snapshot.reduce((n, row) => n + row.bytes.length, 0)).toBeLessThan(raw.length / 4);
		// Update records stay v1, beside the snapshot.
		a.transact(() => a.facade.insertText('p', 0, 'two '));
		await vi.waitFor(
			async () => expect((await rowsOf(room)).some((row) => row.kind === 'update')).toBe(true),
			SLOW
		);
		const before = await textOf(room);
		client.close();
		await evictDurableObject(stubOf(room));
		expect(await textOf(room)).toEqual(before);
		expect(before).toEqual(a.facade.toJSON());
		// The records read back as one update, the inflated snapshot included.
		const restored = await inRoom(room, (r) => {
			const doc = E.bindCrdt(Y).createDoc();
			Y.applyUpdate(doc, storedUpdate(r.records()));
			return readFacade(doc, (f) => f.toJSON());
		});
		expect(restored).toEqual(before);
		a.destroy();
	});

	it('a container written by 0.1.0-next.22 loads, and its first compaction rewrites it in v2', async () => {
		const room = 'p5-next22';
		const a = E.createDocument({
			value: { children: [para('p', 'from next.22')] },
			actor: { id: 'ada' }
		});
		const updates: Uint8Array[] = [];
		a.doc.on('update', (update: Uint8Array) => updates.push(update));
		const snapshot = Y.encodeStateAsUpdate(a.doc);
		a.transact(() => a.facade.insertText('p', 0, '> '));
		// What 0.1.0-next.22 stored: its record, a merged (v1) snapshot, a v1 update.
		await storeRows(
			room,
			[
				{ kind: 'generation', bytes: json(NEXT22_RECORD) },
				{ kind: 'snapshot', bytes: Y.mergeUpdates([snapshot]) },
				...updates.map((bytes) => ({ kind: 'update', bytes }))
			],
			[{ replica: a.doc.clientID, user: 'ada' }]
		);
		expect(await textOf(room)).toEqual(a.facade.toJSON());
		expect(await inRoom(room, (r) => r.records().map((record) => record.v2))).toEqual(
			[false, false].concat(updates.map(() => false))
		);
		// A client edits: the record is appended in v1, as every update record is.
		const client = await RawClient.connect(room, a.doc, { user: 'ada', replica: a.doc.clientID });
		await vi.waitFor(() => expect(client.synced).toBe(true), SLOW);
		a.transact(() => a.facade.insertText('p', 2, 'edited '));
		await vi.waitFor(async () => expect(await textOf(room)).toEqual(a.facade.toJSON()), SLOW);
		expect(generationOf(await rowsOf(room))).toEqual(NEXT22_RECORD);
		// The first compaction rewrites the container in this build's format.
		await inRoom(room, (r) => r.compact());
		await inRoom(room, (r) => r.compressed());
		const rows = await rowsOf(room);
		expect(generationOf(rows)).toEqual({ ...NEXT22_RECORD, storage: 'v2' });
		client.close();
		await evictDurableObject(stubOf(room));
		expect(await textOf(room)).toEqual(a.facade.toJSON());
		a.destroy();
	});

	it('a compressed snapshot that does not inflate, or an unknown storage format, refuses the container', async () => {
		const corrupt = 'p5-corrupt';
		await storeRows(corrupt, [
			{ kind: 'generation', bytes: json({ ...NEXT22_RECORD, storage: 'v2' }) },
			{ kind: 'snapshot', bytes: Uint8Array.of(0x1f, 0x8b, 8, 0, 1, 2, 3) }
		]);
		expect(await dialOutcome(corrupt)).toEqual({ code: 1008, reason: 'refused: container' });
		expect(await inRoom(corrupt, (r) => r.failure?.message)).toMatch(/does not inflate/);

		const future = 'p5-future';
		await storeRows(future, [
			{ kind: 'generation', bytes: json({ ...NEXT22_RECORD, storage: 'v3' }) }
		]);
		expect(await dialOutcome(future)).toEqual({ code: 1008, reason: 'refused: container' });
		expect(await inRoom(future, (r) => r.failure?.name)).toBe('GenerationMismatchError');
	});
});
