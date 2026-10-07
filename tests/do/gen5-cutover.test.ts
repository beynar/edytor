/**
 * The generation cutover in the room (`room.generation.convert`,
 * `reference/migration.mdx` "From 0.1.0-next.24"):
 *
 * - a container of generation 4 (as 0.1.0-next.24 stored it, v1 or v2)
 *   converts at load: its visible document read as JSON and seeded as
 *   generation 5's, the container replaced by it; a client then gets that
 *   document;
 * - a client of generation 4 (0.1.0-next.24, wire word 14004) is refused
 *   before anything is decoded (`1008`, `refused: generation`): the
 *   provider stops and reports it (`onSyncRefused`);
 * - a container of any other generation is still refused until `reset()`.
 */
import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import { E, RawClient, dialOutcome, readFacade, updateFrameWithWord } from './client';
import { GENERATION_4_V1, GENERATION_4_V2, GENERATION_4_VALUE } from './fixtures/generation-4';

const stubOf = (room: string) => env.ROOM.getByName(room);
const inRoom = <T>(room: string, fn: (r: Room, state: DurableObjectState) => T) =>
	runInDurableObject(stubOf(room), (r: Room, state) => fn(r, state));
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const GENERATION_4 = { engine: 'yjs-v14', protocol: 14, schema: 4 };

/** Replace a room's rows with `rows`, then wake it. */
const storeRows = async (room: string, rows: Array<{ kind: string; bytes: Uint8Array }>) => {
	await inRoom(room, (_r, state) => {
		state.storage.transactionSync(() => {
			state.storage.sql.exec('DELETE FROM rows');
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

const kinds = (room: string) =>
	inRoom(room, (_r, state) =>
		state.storage.sql
			.exec<{ kind: string; bytes: ArrayBuffer }>('SELECT kind, bytes FROM rows ORDER BY seq')
			.toArray()
			.map((row) => ({ kind: row.kind, bytes: new Uint8Array(row.bytes) }))
	);

describe('generation cutover · a container of generation 4 converts at load', () => {
	for (const [name, rows] of [
		['v1 update rows', [{ kind: 'update', bytes: GENERATION_4_V1 }]],
		['a v2 snapshot', [{ kind: 'snapshot', bytes: GENERATION_4_V2 }]]
	] as const) {
		it(`${name}: the document is generation 5's, the same JSON, and a client gets it`, async () => {
			const room = `gen5-convert-${name.replace(/\W/g, '')}`;
			await storeRows(room, [
				{
					kind: 'generation',
					bytes: json(name === 'a v2 snapshot' ? { ...GENERATION_4, storage: 'v2' } : GENERATION_4)
				},
				...rows
			]);
			expect(await inRoom(room, (r) => r.origin)).toEqual({
				kind: 'converted',
				from: 4,
				records: rows.length
			});
			expect(await inRoom(room, (r) => readFacade(r.doc!, (f) => f.toJSON()))).toEqual(
				GENERATION_4_VALUE
			);
			const stored = await kinds(room);
			expect(stored.map((row) => row.kind)).toEqual(['generation', 'snapshot']);
			expect(JSON.parse(new TextDecoder().decode(stored[0].bytes)).schema).toBe(5);
			// A woken room loads the converted container as its own.
			await evictDurableObject(stubOf(room));
			expect(await inRoom(room, (r) => r.origin.kind)).toBe('restored');
			const client = await RawClient.connect(room);
			await vi.waitFor(() => expect(client.synced).toBe(true));
			expect(readFacade(client.doc, (f) => f.toJSON())).toEqual(GENERATION_4_VALUE);
			client.close();
		});
	}

	it('a container of another generation is still refused until reset()', async () => {
		const room = 'gen5-other';
		await storeRows(room, [
			{ kind: 'generation', bytes: json({ ...GENERATION_4, schema: 3 }) },
			{ kind: 'update', bytes: GENERATION_4_V1 }
		]);
		expect(await dialOutcome(room)).toEqual({ code: 1008, reason: 'refused: container' });
		expect(await inRoom(room, (r) => r.failure?.name)).toBe('GenerationMismatchError');
	});
});

describe('generation cutover · a client of generation 4 is refused', () => {
	it('a frame with the wire word 14004 closes the socket 1008 before anything is decoded', async () => {
		const room = 'gen5-old-client';
		const client = await RawClient.connect(room);
		await vi.waitFor(() => expect(client.synced).toBe(true));
		client.send(updateFrameWithWord(14004, GENERATION_4_V1));
		await vi.waitFor(() =>
			expect(client.closed).toEqual({ code: 1008, reason: 'refused: generation' })
		);
		expect(await inRoom(room, (r) => r.doc!.store.clients.size)).toBe(0);
	});
});
