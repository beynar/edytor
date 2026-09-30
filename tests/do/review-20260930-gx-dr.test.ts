/**
 * Re-score 13 follow-up (DR-rest-1), in workerd: a room `transact` called
 * while the document is inside another transaction or its change events
 * (a `facade.onChange` subscriber of a client's frame). The engine queues
 * such a write until the subscriber returns, so the room cannot store it
 * before `transact` returns: it used to return `fn`'s value anyway, and
 * when that append failed the write was lost and the frame's sender (whose
 * edit was stored) was faulted. It now throws without writing; deferring
 * the write (`queueMicrotask`) stores it, or throws the storage error.
 *
 * Expected values are hand-authored from the edits each test performs.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import { E, RawClient, Y, crdt, para, readFacade } from './client';

const inRoom = <T>(room: string, fn: (r: Room, state: DurableObjectState) => T) =>
	runInDurableObject(env.ROOM.getByName(room), (r: Room, state) => fn(r, state));

/** Block `p` as the room STORED it (its rows, merged): its text and `data.seen`. */
const stored = (r: Room) => {
	const doc = crdt.createDoc();
	Y.applyUpdate(
		doc,
		Y.mergeUpdates(
			r
				.records()
				.slice(1)
				.map((x) => x.bytes)
		)
	);
	return readFacade(doc, (f) => ({
		text: f.blockText('p'),
		seen: f.toJSON().children[0].data?.seen ?? null
	}));
};

/** Block `p` as the room holds it live. */
const live = (r: Room) => ({
	text: r.facade.blockText('p'),
	seen: r.read().children[0].data?.seen ?? null
});

const FAIL_APPEND =
	"CREATE TRIGGER fail_append BEFORE INSERT ON rows WHEN NEW.kind = 'update' BEGIN SELECT RAISE(ABORT, 'injected append failure'); END";

/** A client whose `hello` the room stored and acknowledged. */
const connect = async (room: string) => {
	const document = E.createDocument({ value: { children: [para('p', 'hello')] } });
	const author = await RawClient.connect(room, document.doc, { user: 'ada' });
	await vi.waitFor(async () => expect((await inRoom(room, stored)).text).toBe('hello'));
	const own = document.doc.clientID;
	await vi.waitFor(() => expect(author.acks.at(-1)?.get(own)).toBeGreaterThan(0));
	return { document, author, own, acked: author.acks.at(-1)!.get(own)! };
};

describe("DR-rest-1 · a room transact inside another transaction's events", () => {
	it('throws without writing, even when the append would fail; the frame is stored and acknowledged', async () => {
		const room = 'dr-rest-1-nested';
		const { document, author, own, acked } = await connect(room);
		await inRoom(room, (r, state) => {
			(globalThis as Record<string, unknown>).drNested = null;
			r.facade.onChange(() => {
				state.storage.sql.exec(FAIL_APPEND);
				try {
					(globalThis as Record<string, unknown>).drNested = {
						result: r.transact((f) => (f.setBlock('p', { data: { seen: true } }), 'ok'))
					};
				} catch (error) {
					(globalThis as Record<string, unknown>).drNested = { threw: String(error) };
				} finally {
					state.storage.sql.exec('DROP TRIGGER fail_append');
				}
			});
		});
		document.transact(() => document.facade.insertText('p', 5, '!'));
		await vi.waitFor(() => expect(author.acks.at(-1)!.get(own)).toBeGreaterThan(acked));
		const after = await inRoom(room, (r) => ({
			nested: (globalThis as Record<string, unknown>).drNested,
			live: live(r),
			stored: stored(r)
		}));
		expect(after.nested).toEqual({
			threw: expect.stringContaining('inside another transaction')
		});
		expect(after.live).toEqual({ text: 'hello!', seen: null });
		expect(after.stored).toEqual({ text: 'hello!', seen: null });
		expect(author.closed).toBe(null);
		author.close();
		document.destroy();
	});

	it('deferred with queueMicrotask, the write is stored and reaches the author', async () => {
		const room = 'dr-rest-1-deferred';
		const { document, author } = await connect(room);
		await inRoom(room, (r) => {
			let once = false;
			r.facade.onChange((change) => {
				if (once || change.local) return;
				once = true;
				queueMicrotask(() => r.transact((f) => f.setBlock('p', { data: { seen: true } })));
			});
		});
		document.transact(() => document.facade.insertText('p', 5, '!'));
		await vi.waitFor(() =>
			expect(document.facade.toJSON().children[0].data).toEqual({ seen: true })
		);
		expect(await inRoom(room, (r) => [live(r), stored(r)])).toEqual([
			{ text: 'hello!', seen: true },
			{ text: 'hello!', seen: true }
		]);
		expect(author.closed).toBe(null);
		author.close();
		document.destroy();
	});

	it('deferred, a failed append throws the storage error there; the frame stays stored and acknowledged', async () => {
		const room = 'dr-rest-1-deferred-failure';
		const { document, author, own, acked } = await connect(room);
		await inRoom(room, (r, state) => {
			(globalThis as Record<string, unknown>).drDeferred = null;
			let once = false;
			r.facade.onChange((change) => {
				if (once || change.local) return;
				once = true;
				queueMicrotask(() => {
					state.storage.sql.exec(FAIL_APPEND);
					try {
						r.transact((f) => f.setBlock('p', { data: { seen: true } }));
						(globalThis as Record<string, unknown>).drDeferred = 'returned';
					} catch (error) {
						(globalThis as Record<string, unknown>).drDeferred = String(error);
					} finally {
						state.storage.sql.exec('DROP TRIGGER fail_append');
					}
				});
			});
		});
		document.transact(() => document.facade.insertText('p', 5, '!'));
		await vi.waitFor(() => expect(author.acks.at(-1)!.get(own)).toBeGreaterThan(acked));
		const after = await inRoom(room, (r) => ({
			deferred: (globalThis as Record<string, unknown>).drDeferred,
			live: live(r),
			stored: stored(r)
		}));
		expect(after.deferred).toEqual(expect.stringContaining('injected append failure'));
		expect(after.live).toEqual({ text: 'hello!', seen: null });
		expect(after.stored).toEqual({ text: 'hello!', seen: null });
		expect(author.closed).toBe(null);
		author.close();
		document.destroy();
	});
});
