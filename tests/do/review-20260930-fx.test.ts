/**
 * Re-score 12 (2026-09-30) — the room's `transact` when `fn` throws, in workerd:
 *
 * - FX-11: `transact(fn)` is one transaction, not a rollback, like every
 *   client-side `transact`. A throw from `fn` keeps the writes made before
 *   it (stored and broadcast) and propagates. The live `doc`, the `facade`
 *   and its `onChange` subscribers stay as they were (DR-rest-1: a
 *   rebuild-based rollback reported the dropped write as committed, then
 *   replaced the facade and silently dropped its subscribers).
 * - FX-03: a throwing `fn` while appends fail (a double fault) leaves
 *   nothing unstored behind: no joiner is served or acknowledged the edit,
 *   and the rebuild keeps what the engine holds waiting.
 *   A write straight through `facade` whose append fails is dropped at the
 *   room's next entry point, before anything is served.
 *
 * Expected values are hand-authored from the edits each test performs.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import { E, RawClient, Y, crdt, para, readFacade, shape, storedUpdate } from './client';

const inRoom = <T>(room: string, fn: (r: Room, state: DurableObjectState) => T) =>
	runInDurableObject(env.ROOM.getByName(room), (r: Room, state) => fn(r, state));

/** The text of block `id` in what the room STORED (its rows, merged). */
const storedText = (r: Room, id: string) => {
	const stored = crdt.createDoc();
	Y.applyUpdate(stored, storedUpdate(r.records()));
	return readFacade(stored, (f) => f.blockText(id));
};

const FAIL_APPEND =
	"CREATE TRIGGER fail_append BEFORE INSERT ON rows WHEN NEW.kind = 'update' BEGIN SELECT RAISE(ABORT, 'injected append failure'); END";

const textOf = (client: RawClient, id = 'p') => readFacade(client.doc, (f) => f.blockText(id));

/** A seeded room with a peer connected and caught up. */
const seeded = async (room: string) => {
	const document = E.createDocument({ value: { children: [para('p', 'hello')] } });
	const author = await RawClient.connect(room, document.doc, { user: 'ada' });
	await vi.waitFor(() => expect(author.acks.length).toBeGreaterThan(0));
	await vi.waitFor(async () => expect(await inRoom(room, (r) => storedText(r, 'p'))).toBe('hello'));
	return { document, author };
};

/** A `transact` whose fn writes, then throws; what it threw. */
const throwingTransact = (r: Room) => {
	try {
		r.transact((f) => {
			f.insertText('p', 0, 'PARTIAL ');
			throw new Error('fn failed');
		});
		return null;
	} catch (error) {
		return String(error);
	}
};

/** What a subscriber on the room's facade saw (the text of `p` at each change). */
const seen: Array<string | null> = [];

describe('FX-11 · a throw from transact(fn) keeps the writes made before it', () => {
	it('the partial write is stored and broadcast; the error propagates', async () => {
		const room = 'fx11-partial';
		const { document, author } = await seeded(room);
		const before = await inRoom(room, (r) => r.records().length);
		const thrown = await inRoom(room, (r) => ({
			error: throwingTransact(r),
			read: shapeText(r.read()),
			stored: storedText(r, 'p'),
			records: r.records().length
		}));
		expect(thrown).toEqual({
			error: 'Error: fn failed',
			read: 'PARTIAL hello',
			stored: 'PARTIAL hello',
			records: before + 1
		});
		await vi.waitFor(() => expect(document.facade.blockText('p')).toBe('PARTIAL hello'));
		const joiner = await RawClient.connect(room, undefined, { user: 'bob' });
		await vi.waitFor(() => expect(joiner.synced).toBe(true));
		expect(textOf(joiner)).toBe('PARTIAL hello');
		joiner.close();
		author.close();
		document.destroy();
	});

	it('doc, facade, origin and onChange subscribers stay; the subscriber sees each real change once', async () => {
		const room = 'fx11-subscribers';
		const { document, author } = await seeded(room);
		seen.length = 0;
		const kept = await inRoom(room, (r) => {
			const live = { doc: r.doc, facade: r.facade, origin: r.origin };
			r.facade.onChange(() => seen.push(r.facade.blockText('p')));
			const error = throwingTransact(r);
			return {
				error,
				doc: r.doc === live.doc,
				facade: r.facade === live.facade,
				origin: r.origin === live.origin
			};
		});
		expect(kept).toEqual({ error: 'Error: fn failed', doc: true, facade: true, origin: true });
		await vi.waitFor(() => expect(document.facade.blockText('p')).toBe('PARTIAL hello'));
		document.facade.insertText('p', 13, '!');
		await vi.waitFor(() => expect(seen).toEqual(['PARTIAL hello', 'PARTIAL hello!']));
		author.close();
		document.destroy();
	});

	it('a throw with no write keeps the same document', async () => {
		const room = 'fx11-no-write';
		const { document, author } = await seeded(room);
		const doc = await inRoom(room, (r) => {
			const live = r.doc;
			let error = '';
			try {
				r.transact(() => {
					throw new Error('validation failed');
				});
			} catch (e) {
				error = String(e);
			}
			return { error, same: r.doc === live };
		});
		expect(doc).toEqual({ error: 'Error: validation failed', same: true });
		author.close();
		document.destroy();
	});
});

describe('FX-03 · nothing unstored outlives a failed append on the server path', () => {
	it("a throwing fn while appends fail: the storage error outranks fn's; the room holds the stored rows; a joiner is served and acknowledged only those", async () => {
		const room = 'fx03-throwing-fn';
		const { document, author } = await seeded(room);
		const observed = await inRoom(room, (r, state) => {
			state.storage.sql.exec(FAIL_APPEND);
			const error = throwingTransact(r);
			const result = { error, read: shapeText(r.read()), stored: storedText(r, 'p') };
			state.storage.sql.exec('DROP TRIGGER fail_append');
			return result;
		});
		expect(observed.error).toContain('injected append failure');
		expect([observed.read, observed.stored]).toEqual(['hello', 'hello']);
		const joiner = await RawClient.connect(room, undefined, { user: 'bob' });
		await vi.waitFor(() => expect(joiner.synced).toBe(true));
		await vi.waitFor(() => expect(joiner.acks.length).toBeGreaterThan(0));
		const roomClient = await inRoom(room, (r) => r.doc!.clientID);
		expect({
			text: textOf(joiner),
			acked: joiner.acks.at(-1)?.get(roomClient) ?? 0,
			closed: joiner.closed
		}).toEqual({ text: 'hello', acked: 0, closed: null });
		joiner.close();
		author.close();
		document.destroy();
	});

	it('the rebuild after a failed append keeps the updates the engine holds waiting for a missing dependency', async () => {
		const room = 'fx03-keeps-pending';
		const { document, author } = await seeded(room);
		// A writer's second edit arrives before its first: the room holds it pending.
		const writer = crdt.createDoc();
		Y.applyUpdate(writer, Y.encodeStateAsUpdate(document.doc));
		const updates: Uint8Array[] = [];
		writer.on('update', (update: Uint8Array) => updates.push(update));
		readFacade(writer, (f) => f.insertText('p', 5, ' A'));
		readFacade(writer, (f) => f.insertText('p', 7, 'B'));
		expect(updates.length).toBe(2);
		const bob = await RawClient.connect(room, crdt.createDoc(), { user: 'bob' });
		await vi.waitFor(() => expect(bob.synced).toBe(true));
		const sent = async (update: Uint8Array) => {
			const acks = bob.acks.length;
			bob.send(E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, update)));
			await vi.waitFor(() => expect(bob.acks.length).toBeGreaterThan(acks));
		};
		await sent(updates[1]);
		expect(await inRoom(room, (r) => r.doc!.store.pendingStructs !== null)).toBe(true);

		const error = await inRoom(room, (r, state) => {
			state.storage.sql.exec(FAIL_APPEND);
			try {
				return throwingTransact(r);
			} finally {
				state.storage.sql.exec('DROP TRIGGER fail_append');
			}
		});
		expect(error).toContain('injected append failure');

		// The first edit arrives: the waiting one integrates with it.
		await sent(updates[0]);
		expect(await inRoom(room, (r) => [shapeText(r.read()), storedText(r, 'p')])).toEqual([
			'hello AB',
			'hello AB'
		]);
		await vi.waitFor(() => expect(document.facade.blockText('p')).toBe('hello AB'));
		bob.close();
		author.close();
		document.destroy();
		writer.destroy();
	});

	it('a fn that returns while appends fail: the storage error is thrown and nothing is kept', async () => {
		const room = 'fx03-returning-fn';
		const { document, author } = await seeded(room);
		const observed = await inRoom(room, (r, state) => {
			state.storage.sql.exec(FAIL_APPEND);
			let error = '';
			try {
				r.transact((f) => f.insertText('p', 0, 'UNSTORED '));
			} catch (e) {
				error = String(e);
			}
			const result = { error, read: shapeText(r.read()), stored: storedText(r, 'p') };
			state.storage.sql.exec('DROP TRIGGER fail_append');
			return result;
		});
		expect(observed.error).toContain('injected append failure');
		expect([observed.read, observed.stored]).toEqual(['hello', 'hello']);
		author.close();
		document.destroy();
	});

	it('a write straight through `facade` whose append fails is dropped before anything is served', async () => {
		const room = 'fx03-direct-facade';
		const { document, author } = await seeded(room);
		await inRoom(room, (r, state) => {
			state.storage.sql.exec(FAIL_APPEND);
			r.facade.insertText('p', 0, 'UNSTORED ');
			state.storage.sql.exec('DROP TRIGGER fail_append');
		});
		const joiner = await RawClient.connect(room, undefined, { user: 'bob' });
		await vi.waitFor(() => expect(joiner.synced).toBe(true));
		await vi.waitFor(() => expect(joiner.acks.length).toBeGreaterThan(0));
		expect({ text: textOf(joiner), closed: joiner.closed }).toEqual({
			text: 'hello',
			closed: null
		});
		expect(await inRoom(room, (r) => [shapeText(r.read()), storedText(r, 'p')])).toEqual([
			'hello',
			'hello'
		]);
		// The connected author was never sent it, and its next frame is not faulted.
		author.send(E.frame(E.messageSync, (e) => crdt.sync.writeSyncStep1(e, author.doc)));
		const acks = author.acks.length;
		await vi.waitFor(() => expect(author.acks.length).toBeGreaterThan(acks));
		expect({ text: document.facade.blockText('p'), closed: author.closed }).toEqual({
			text: 'hello',
			closed: null
		});
		joiner.close();
		author.close();
		document.destroy();
	});
});

/** The text of the first block of a JSON document. */
function shapeText(json: Parameters<typeof shape>[0]) {
	return shape(json).children[0]?.text;
}
