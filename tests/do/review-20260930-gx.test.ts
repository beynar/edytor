/**
 * Re-score 13 (2026-09-30) — GX-09, in workerd: a write straight through
 * the room's `facade` whose append fails is dropped, and only that one.
 * Reading `facade` again first rebuilds the document from the stored rows,
 * so the next direct write on healthy storage is stored and broadcast (it
 * used to be dropped too, silently, until the room next served or read).
 *
 * Expected values are hand-authored from the edits each test performs.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import { E, RawClient, Y, crdt, para, readFacade, storedUpdate } from './client';

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

describe('GX-09 · one failed direct facade write drops only that write', () => {
	it('the next direct write, on healthy storage, is stored and broadcast', async () => {
		const room = 'gx09-direct-after-failure';
		const document = E.createDocument({ value: { children: [para('p', 'hello')] } });
		const author = await RawClient.connect(room, document.doc, { user: 'ada' });
		await vi.waitFor(() => expect(author.acks.length).toBeGreaterThan(0));
		await vi.waitFor(async () =>
			expect(await inRoom(room, (r) => storedText(r, 'p'))).toBe('hello')
		);
		// RPC 1: a direct write whose append fails.
		await inRoom(room, (r, state) => {
			state.storage.sql.exec(FAIL_APPEND);
			try {
				r.facade.insertText('p', 0, 'A');
			} finally {
				state.storage.sql.exec('DROP TRIGGER fail_append');
			}
		});
		// RPC 2: a direct write on healthy storage.
		const after = await inRoom(room, (r) => {
			r.facade.insertText('p', 0, 'B');
			return { live: r.facade.blockText('p'), stored: storedText(r, 'p') };
		});
		expect(after).toEqual({ live: 'Bhello', stored: 'Bhello' });
		await vi.waitFor(() => expect(document.facade.blockText('p')).toBe('Bhello'));
		expect(author.closed).toBe(null);
		author.close();
		document.destroy();
	});

	it.each([
		['reads `facade`', 'gx09-subscriber-facade', (r: Room) => void r.facade.blockText('p')],
		['calls `read()`', 'sw16-subscriber-read', (r: Room) => void r.read()],
		[
			'calls `transact`',
			'sw16-subscriber-transact',
			(r: Room) => {
				try {
					r.transact((f) => f.setBlock('p', { data: { seen: true } }));
				} catch {
					// refused: inside the frame's change event (DR-rest-1)
				}
			}
		]
	])(
		"a subscriber that %s while a frame's append fails heals nothing: the sender is faulted, not acknowledged",
		async (_, room, react) => {
			const document = E.createDocument({ value: { children: [para('p', 'hello')] } });
			const author = await RawClient.connect(room, document.doc, { user: 'ada' });
			await vi.waitFor(async () =>
				expect(await inRoom(room, (r) => storedText(r, 'p'))).toBe('hello')
			);
			const own = document.doc.clientID;
			await vi.waitFor(() => expect(author.acks.at(-1)?.get(own)).toBeGreaterThan(0));
			const acked = author.acks.at(-1)!.get(own);
			await inRoom(room, (r, state) => {
				r.facade.onChange(() => react(r));
				state.storage.sql.exec(FAIL_APPEND);
			});
			document.transact(() => document.facade.insertText('p', 5, '!'));
			await vi.waitFor(() =>
				expect(author.closed).toEqual({ code: 1011, reason: 'storage failure' })
			);
			await inRoom(room, (_r, state) => state.storage.sql.exec('DROP TRIGGER fail_append'));
			expect(author.acks.at(-1)!.get(own)).toBe(acked);
			expect(await inRoom(room, (r) => [r.facade.blockText('p'), storedText(r, 'p')])).toEqual([
				'hello',
				'hello'
			]);
			document.destroy();
		}
	);

	it('a later write through a facade kept from before the failure is dropped with it (as documented)', async () => {
		const room = 'gx09-kept-facade';
		const document = E.createDocument({ value: { children: [para('p', 'hello')] } });
		const author = await RawClient.connect(room, document.doc, { user: 'ada' });
		await vi.waitFor(async () =>
			expect(await inRoom(room, (r) => storedText(r, 'p'))).toBe('hello')
		);
		const after = await inRoom(room, (r, state) => {
			const kept = r.facade;
			state.storage.sql.exec(FAIL_APPEND);
			try {
				kept.insertText('p', 0, 'A');
			} finally {
				state.storage.sql.exec('DROP TRIGGER fail_append');
			}
			kept.insertText('p', 0, 'B');
			return { live: r.facade.blockText('p'), stored: storedText(r, 'p') };
		});
		expect(after).toEqual({ live: 'hello', stored: 'hello' });
		author.close();
		document.destroy();
	});
});
