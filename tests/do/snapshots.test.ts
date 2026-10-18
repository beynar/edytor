/**
 * The room's snapshots are compressed (`room.store.v2` in
 * `docs/editor-delete-contract.md`):
 *
 * - every record holds an update in the engine's one encoding; a
 *   snapshot is compressed in place (gzip), and a woken room inflates it;
 * - a compressed snapshot that does not inflate, or a container of another
 *   generation, refuses the container (`1008`, `container`).
 */
import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import { E, RawClient, Y, dialOutcome, para, readFacade, storedUpdate } from './client';

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

describe('P5 · room snapshots, compressed', () => {
	it('a fresh container: the snapshot is compressed in place, and a woken room inflates it', async () => {
		const room = 'p5-fresh';
		const a = E.createDocument({
			value: { children: [para('p', 'lorem ipsum '.repeat(500))] },
			actor: { id: 'ada' }
		});
		const client = await RawClient.connect(room, a.doc, { user: 'ada', replica: a.doc.clientID });
		await vi.waitFor(() => expect(client.synced).toBe(true));
		a.transact(() => a.facade.insertText('p', 0, 'one '));
		await vi.waitFor(async () =>
			expect(await inRoom(room, (r) => Y.encodeStateVector(r.doc!))).toEqual(
				Y.encodeStateVector(a.doc)
			)
		);
		const raw = await inRoom(room, (r) => {
			r.compact();
			const snapshot = r.records().find((record) => record.kind === 'snapshot')!;
			return { length: snapshot.bytes.length, first: snapshot.bytes[0] };
		});
		expect(raw).toMatchObject({ first: 1 }); // an update's feature flag: its encoding (fork patch YP24)
		await inRoom(room, (r) => r.compressed());
		const rows = await rowsOf(room);
		expect(generationOf(rows)).toEqual(E.GENERATION_RECORD);
		const snapshot = rows.filter((row) => row.kind === 'snapshot');
		expect(isGzip(snapshot[0].bytes)).toBe(true);
		expect(snapshot.reduce((n, row) => n + row.bytes.length, 0)).toBeLessThan(raw.length / 4);
		// Update records beside the snapshot.
		a.transact(() => a.facade.insertText('p', 0, 'two '));
		await vi.waitFor(async () =>
			expect((await rowsOf(room)).some((row) => row.kind === 'update')).toBe(true)
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

	it('a compressed snapshot that does not inflate, or another generation, refuses the container', async () => {
		const corrupt = 'p5-corrupt';
		await storeRows(corrupt, [
			{ kind: 'generation', bytes: json(E.GENERATION_RECORD) },
			{ kind: 'snapshot', bytes: Uint8Array.of(0x1f, 0x8b, 8, 0, 1, 2, 3) }
		]);
		expect(await dialOutcome(corrupt)).toEqual({ code: 1008, reason: 'refused: container' });
		expect(await inRoom(corrupt, (r) => r.failure?.message)).toMatch(/does not inflate/);

		const future = 'p5-future';
		await storeRows(future, [
			{ kind: 'generation', bytes: json({ ...E.GENERATION_RECORD, schema: E.SCHEMA_VERSION - 1 }) }
		]);
		expect(await dialOutcome(future)).toEqual({ code: 1008, reason: 'refused: container' });
		expect(await inRoom(future, (r) => r.failure?.name)).toBe('GenerationMismatchError');
	});
});
