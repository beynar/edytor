/**
 * WU-04 (production-readiness plan, R2 and R4) — memory limits that hold
 * (`room.quota`, `net.chunk.inbound` in `docs/editor-delete-contract.md`).
 *
 * - the default document quota fits a 128 MB isolate: measured, a live
 *   room document takes up to about 47 bytes of heap per stored byte
 *   (`bench/room-memory.mjs`), so the default is 2 MiB, and the default
 *   frame quota a few MiB; a document past the default is refused `4413`
 *   while the room keeps serving;
 * - chunk sequences are bounded room-wide: a sequence is buffered into
 *   one buffer of its announced size, allocated at its start (`buffered`
 *   in `metrics()`); the sequences in flight on every socket share
 *   `maxBufferedBytes`, and one that would pass it closes its socket
 *   `1011` (`room busy`: the provider redials) while the others complete;
 *   a closed socket releases its buffer;
 * - a read-only socket's chunk sequence is denied at its start (`read-only`)
 *   and never buffered; the socket stays;
 * - a sequence's start counts against the update rate.
 *
 * The `quota-buffer-*` rooms (`QuotaRoom`) take 30,000-byte frames and
 * buffer 40,000 bytes room-wide; `ROOM` keeps every default.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_MAX_BUFFERED_BYTES,
	DEFAULT_MAX_DOCUMENT_BYTES,
	DEFAULT_MAX_INBOUND_FRAME_BYTES,
	type DocumentRoom as Room
} from '../../src/lib/cloudflare/index.js';
import type { QuotaRoom } from './worker';
import { E, RawClient, crdt, para, readFacade } from './client';

/** `vi.waitFor` under a loaded pool: the default 1 s is short for a room's round trips. */
const SLOW = { timeout: 20_000, interval: 25 };
const MiB = 1024 * 1024;

declare global {
	namespace Cloudflare {
		interface Env {
			QUOTA: DurableObjectNamespace<QuotaRoom>;
		}
	}
}

/** Incompressible text: what a document quota measures is what it stores. */
const noise = (length: number, seed: number) => {
	const out = new Array<string>(length);
	for (let i = 0; i < length; i++) {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		out[i] = String.fromCharCode(48 + ((seed >>> 16) % 64));
	}
	return out.join('');
};

const syncFrame = (update: Uint8Array) =>
	E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, update));

const textIn = (stub: DurableObjectStub<Room>, block: string) =>
	runInDurableObject(stub, (r: Room) => readFacade(r.doc!, (f) => f.blockText(block)));

/** Seed `room` with empty paragraphs `ids`, stored before it returns. */
const seedRoom = async (room: string, ids: string[]) => {
	const seed = E.createDocument({
		value: { children: ids.map((id) => para(id, '')) },
		actor: { id: 'root' }
	});
	const client = await RawClient.connect(room, seed.doc, {
		user: 'root',
		replica: seed.doc.clientID
	});
	await vi.waitFor(() => expect(client.acks.length).toBeGreaterThan(1), SLOW);
	client.close();
	seed.destroy();
};

/**
 * A writer's frame inserting `chars` of noise into `block`, made while
 * offline (synced first, then disconnected): its whole frame and its
 * replica, to send as chunks from a bare socket.
 */
const offlineFrame = async (room: string, user: string, block: string, chars: number) => {
	const doc = E.createDocument({ actor: { id: user } });
	const client = await RawClient.connect(room, doc.doc, { user, replica: doc.doc.clientID });
	await vi.waitFor(() => expect(client.synced).toBe(true), SLOW);
	client.close();
	const updates: Uint8Array[] = [];
	doc.doc.on('update', (update: Uint8Array) => updates.push(update));
	doc.transact(() => doc.facade.insertText(block, 0, noise(chars, chars + user.length)));
	return { frame: syncFrame(updates[0]), replica: doc.doc.clientID, doc };
};

const buffered = (stub: DurableObjectStub<QuotaRoom>) =>
	runInDurableObject(stub, (r: QuotaRoom) => r.metrics().buffered);

describe('WU-04 · memory limits that hold', () => {
	it('the defaults fit a 128 MB isolate: a 2 MiB document, frames of a few MiB', () => {
		// 47 heap bytes per stored byte at worst (short blocks, with the index).
		expect(DEFAULT_MAX_DOCUMENT_BYTES * 47).toBeLessThanOrEqual(100 * MiB);
		expect(DEFAULT_MAX_DOCUMENT_BYTES).toBeGreaterThanOrEqual(2 * MiB);
		// A frame may carry a whole document (a client seeding an empty room).
		expect(DEFAULT_MAX_INBOUND_FRAME_BYTES).toBeGreaterThanOrEqual(DEFAULT_MAX_DOCUMENT_BYTES);
		expect(DEFAULT_MAX_INBOUND_FRAME_BYTES).toBeLessThanOrEqual(4 * MiB);
		expect(DEFAULT_MAX_BUFFERED_BYTES).toBe(2 * DEFAULT_MAX_INBOUND_FRAME_BYTES);
	});

	it('a document past the default quota is refused 4413 while the room keeps serving', async () => {
		const room = 'wu04-default-document';
		const stub = env.ROOM.getByName(room);
		const a = E.createDocument({ value: { children: [para('p', '')] }, actor: { id: 'ada' } });
		const ca = await RawClient.connect(room, a.doc, { user: 'ada', replica: a.doc.clientID });
		await vi.waitFor(() => expect(ca.synced).toBe(true), SLOW);
		// 400 KB a transaction, each frame well under the frame quota.
		let typed = 0;
		for (let i = 0; i < 8 && ca.closed === null; i++) {
			a.transact(() => a.facade.insertText('p', 0, noise(400_000, i + 1)));
			typed += 400_000;
			await vi.waitFor(
				async () =>
					expect(ca.closed !== null || (await textIn(stub, 'p'))?.length === typed).toBe(true),
				SLOW
			);
		}
		await vi.waitFor(
			() => expect(ca.closed).toEqual({ code: 4413, reason: 'quota: document' }),
			SLOW
		);
		const stored = (await textIn(stub, 'p'))!.length;
		expect(stored).toBeLessThan(typed);
		expect(stored).toBeGreaterThan(DEFAULT_MAX_DOCUMENT_BYTES - 500_000);
		const metrics = await stub.metrics();
		expect(metrics.documentBytes).toBeLessThanOrEqual(DEFAULT_MAX_DOCUMENT_BYTES);
		expect(metrics.quotaHits).toBe(1);

		// The room is up: a reader joins and receives what it stored.
		const reader = await RawClient.connect(room, undefined, { user: 'viv', access: 'read' });
		await vi.waitFor(() => expect(reader.synced).toBe(true), SLOW);
		expect(readFacade(reader.doc, (f) => f.blockText('p'))?.length).toBe(stored);
		reader.close();
		a.destroy();
	}, 120_000);

	it('a frame past the default frame quota is refused 4413 unread', async () => {
		const room = 'wu04-default-frame';
		const stub = env.ROOM.getByName(room);
		// A whole frame of 4 MiB and a byte (an update frame, padded).
		const big = new Uint8Array(4 * MiB + 1);
		big.set(syncFrame(new Uint8Array(0)));
		const direct = await RawClient.bare(room, { user: 'ada' });
		direct.send(big);
		await vi.waitFor(
			() => expect(direct.closed).toEqual({ code: 4413, reason: 'quota: frame' }),
			SLOW
		);
		expect((await stub.metrics()).quotaHits).toBe(1);
	});

	it('a sequence is buffered into one buffer of its announced size, released at its end', async () => {
		const room = 'quota-buffer-prealloc';
		const stub = env.QUOTA.getByName(room);
		await seedRoom(room, ['p']);
		const { frame, replica, doc } = await offlineFrame(room, 'ada', 'p', 12_000);
		const pieces = E.chunkFrame(frame, 4096);
		const sender = await RawClient.bare(room, { user: 'ada', replica });
		sender.send(pieces[0]);
		sender.send(pieces[1]);
		await vi.waitFor(
			async () => expect(await buffered(stub)).toEqual({ sequences: 1, bytes: frame.length }),
			SLOW
		);
		for (const piece of pieces.slice(2)) sender.send(piece);
		await vi.waitFor(async () => expect((await textIn(stub, 'p'))?.length).toBe(12_000), SLOW);
		expect(await buffered(stub)).toEqual({ sequences: 0, bytes: 0 });
		expect(sender.closed).toBe(null);
		sender.close();
		doc.destroy();
	});

	it('sequences share the room-wide buffer: the one past it closes 1011 (room busy), the others complete', async () => {
		const room = 'quota-buffer-shared';
		const stub = env.QUOTA.getByName(room);
		await seedRoom(room, ['a', 'b', 'c']);
		// Three writers, a 15 KB frame each: two fit the 40,000-byte buffer, three do not.
		const writers = await Promise.all(
			['ada', 'bob', 'cyd'].map((user, i) => offlineFrame(room, user, 'abc'[i], 14_500))
		);
		const sockets = await Promise.all(
			writers.map(({ replica }, i) =>
				RawClient.bare(room, { user: ['ada', 'bob', 'cyd'][i], replica })
			)
		);
		const pieces = writers.map(({ frame }) => E.chunkFrame(frame, 4096));
		sockets[0].send(pieces[0][0]);
		sockets[1].send(pieces[1][0]);
		await vi.waitFor(async () => expect((await buffered(stub)).sequences).toBe(2), SLOW);
		sockets[2].send(pieces[2][0]);
		await vi.waitFor(
			() => expect(sockets[2].closed).toEqual({ code: 1011, reason: 'room busy' }),
			SLOW
		);
		// The two in flight complete, interleaved.
		const rest = pieces.map((list) => list.slice(1));
		for (let i = 0; i < Math.max(rest[0].length, rest[1].length); i++) {
			if (rest[0][i]) sockets[0].send(rest[0][i]);
			if (rest[1][i]) sockets[1].send(rest[1][i]);
		}
		await vi.waitFor(async () => {
			expect((await textIn(stub, 'a'))?.length).toBe(14_500);
			expect((await textIn(stub, 'b'))?.length).toBe(14_500);
		}, SLOW);
		expect(await textIn(stub, 'c')).toBe('');
		expect(sockets[0].closed).toBe(null);
		expect(sockets[1].closed).toBe(null);
		const refusals = await runInDurableObject(stub, (r: QuotaRoom) =>
			r.refusals.filter((refusal) => refusal.reason === 'quota').map((refusal) => refusal.detail)
		);
		expect(refusals).toEqual([
			{
				user: 'cyd',
				quota: 'buffer',
				bytes: writers[2].frame.length,
				buffered: writers[0].frame.length + writers[1].frame.length,
				limit: 40_000
			}
		]);
		expect(await buffered(stub)).toEqual({ sequences: 0, bytes: 0 });
		for (const socket of sockets) socket.close();
		for (const { doc } of writers) doc.destroy();
	});

	it('a socket that closes mid-sequence releases its buffer', async () => {
		const room = 'quota-buffer-release';
		const stub = env.QUOTA.getByName(room);
		await seedRoom(room, ['p']);
		const { frame, replica, doc } = await offlineFrame(room, 'ada', 'p', 25_000);
		const pieces = E.chunkFrame(frame, 4096);
		const first = await RawClient.bare(room, { user: 'ada', replica });
		first.send(pieces[0]);
		await vi.waitFor(async () => expect((await buffered(stub)).bytes).toBe(frame.length), SLOW);
		first.close();
		await vi.waitFor(
			async () => expect(await buffered(stub)).toEqual({ sequences: 0, bytes: 0 }),
			SLOW
		);
		// The same 25 KB sequence again fits the 40,000-byte buffer.
		const second = await RawClient.bare(room, { user: 'ada', replica });
		for (const piece of pieces) second.send(piece);
		await vi.waitFor(async () => expect((await textIn(stub, 'p'))?.length).toBe(25_000), SLOW);
		expect(second.closed).toBe(null);
		second.close();
		doc.destroy();
	});

	it("a read-only socket's sequence is denied at its start, never buffered; the socket stays", async () => {
		const room = 'quota-buffer-readonly';
		const stub = env.QUOTA.getByName(room);
		await seedRoom(room, ['p']);
		const { frame, doc } = await offlineFrame(room, 'ada', 'p', 12_000);
		const viewer = await RawClient.connect(room, undefined, { user: 'viv', access: 'read' });
		await vi.waitFor(() => expect(viewer.synced).toBe(true), SLOW);
		const pieces = E.chunkFrame(frame, 4096);
		viewer.send(pieces[0]);
		viewer.send(pieces[1]);
		await vi.waitFor(() => expect(viewer.denied).toEqual(['read-only']), SLOW);
		expect(await buffered(stub)).toEqual({ sequences: 0, bytes: 0 });
		for (const piece of pieces.slice(2)) viewer.send(piece);
		// Still served: a Step1 is answered.
		const acks = viewer.acks.length;
		viewer.send(E.frame(E.messageSync, (e) => crdt.sync.writeSyncStep1(e, viewer.doc)));
		await vi.waitFor(() => expect(viewer.acks.length).toBe(acks + 1), SLOW);
		expect(viewer.closed).toBe(null);
		expect(await textIn(stub, 'p')).toBe('');
		expect(viewer.denied).toEqual(['read-only']);
		viewer.close();
		doc.destroy();
	});

	it("a sequence's start counts against the update rate", async () => {
		const room = 'quota-rate-chunks';
		const sender = await RawClient.bare(room, { user: 'ada' });
		const start = E.chunkFrame(new Uint8Array(20_000), 8192)[0];
		// A burst of 20 messages: the 21st start is past it.
		for (let i = 0; i < 25; i++) sender.send(start);
		await vi.waitFor(
			() => expect(sender.closed).toEqual({ code: 4413, reason: 'quota: rate' }),
			SLOW
		);
	});
});
