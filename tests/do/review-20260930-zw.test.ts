/**
 * Re-score 6 (2026-09-30) — the room's units, in workerd:
 *
 * - ZW-04: a writer's frame carrying one struct of its own id at a high
 *   clock (it waits: the room lacks the clocks below it) and more than
 *   MAX_WAITING_DELETES deletes of that id below the struct stores none of
 *   them: the cap drops them (refusal `waiting`, the sender's), and a
 *   relayer's delete afterwards is still stored and acknowledged. The same
 *   holds when the deletes fall inside the waiting struct itself, and for
 *   the entries its own waiting rewrites replace (kept in memory, never
 *   stored — they counted toward the cap without being capped).
 * - ZW-10: the room ids `''`, `.` and `..` can never reach their room (URL
 *   parsing collapses a dot segment, `%2E` included): the provider and
 *   `createWebsocketSync` refuse them at construction with a clear error,
 *   and `routeDocumentSocket` closes them `4400` like any invalid id.
 *
 * Expected values are hand-authored from the edits each test performs.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import * as encoding from 'lib0-v14/encoding';
import { describe, expect, it, vi } from 'vitest';
import { MAX_WAITING_DELETES, routeDocumentSocket } from '../../src/lib/cloudflare/index.js';
import type { HookedRoom } from './worker';
import { E, RawClient, Y, crdt } from './client';

const hooked = (room: string) => env.HOOKED.getByName(room);
const inHooked = <T>(room: string, fn: (r: HookedRoom) => T) =>
	runInDurableObject(hooked(room), (r: HookedRoom) => fn(r));
const syncUpdate = (update: Uint8Array) =>
	E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, update));

/** A delete-only update of `count` separate ranges of `client`'s items, from `from` on. */
const deletesOf = (client: number, count: number, from = 0) => {
	const body = new Y.UpdateEncoderV1();
	encoding.writeVarUint(body.restEncoder, 0); // no structs
	const deletes = Y.createIdSet();
	for (let i = 0; i < count; i++) deletes.add(client, from + 2 * i, 1);
	Y.writeIdSet(body, deletes);
	return body.toUint8Array();
};

/** How many ranges the room's engine keeps waiting, and the kinds of its rows. */
const waitingState = (room: string) =>
	inHooked(room, (r) => {
		let ranges = 0;
		const pending = r.doc!.store.pendingDs;
		if (pending)
			for (const ids of Y.decodeUpdateV2(pending).ds.clients.values()) {
				ranges += ids.getIds().length;
			}
		return { ranges, kinds: r.records().map((record) => record.kind) };
	});

/** The room's `waiting` refusals. */
const waitingRefusals = (room: string) =>
	inHooked(room, (r) => r.refusals.filter((refusal) => refusal.reason === 'waiting'));

/**
 * After the cap dropped Eve's deletes: nothing waits in storage, her deletes
 * are unacknowledged, the refusal is hers — and Bob's relayed delete of an
 * item the room lacks is still stored and acknowledged.
 */
const expectCapHeld = async (room: string, eve: RawClient, ranges: number) => {
	await vi.waitFor(() => expect(eve.acks.length).toBeGreaterThan(0));
	expect(eve.ackedDeletes.filter((ranges) => ranges > 0)).toEqual([]);
	expect(await waitingRefusals(room)).toEqual([
		{ reason: 'waiting', detail: { user: 'eve', ranges } }
	]);
	const state = await waitingState(room);
	expect(state.ranges).toBeLessThanOrEqual(MAX_WAITING_DELETES);
	expect(state.kinds).not.toContain('pending');

	const bob = await RawClient.bare(room, { user: 'bob' });
	bob.send(syncUpdate(deletesOf(4545, 1)));
	await vi.waitFor(() => expect(bob.ackedDeletes).toContain(1));
	expect(await waitingState(room)).toMatchObject({ kinds: expect.arrayContaining(['pending']) });
	expect((await waitingRefusals(room)).length).toBe(1);
	bob.close();
};

describe('ZW-04 · a writer cannot push waiting deletes past MAX_WAITING_DELETES', () => {
	const count = MAX_WAITING_DELETES + 100;

	it('with deletes of its own id below one high-clock struct it carries', async () => {
		const room = 'hooked-zw04-gap';
		const replica = 9292;
		// Eve's id, advanced past every delete below; only its last struct is sent.
		const doc = crdt.createDoc();
		doc.clientID = replica;
		const meta = doc.get('meta');
		for (let i = 0; i < 2 * count + 2; i++) meta.setAttr('x', i);
		let last: Uint8Array<ArrayBuffer> | null = null;
		doc.on('update', (update: Uint8Array<ArrayBuffer>) => (last = update));
		meta.setAttr('x', 'last');

		const eve = await RawClient.bare(room, { user: 'eve', replica });
		eve.send(syncUpdate(Y.mergeUpdates([last!, deletesOf(replica, count)])));
		// Its deletes, and the `x` entry its write replaces (a separate range).
		await expectCapHeld(room, eve, count + 1);
		eve.close();
	});

	it('with deletes inside the one struct it carries, which waits for its origin', async () => {
		const room = 'hooked-zw04-inside';
		const replica = 9393;
		// A long text struct whose origin (another id's item) the room never gets.
		const source = crdt.createDoc();
		source.clientID = 5151;
		const text = source.get('zw04');
		text.insert(0, 'o');
		const doc = crdt.createDoc();
		doc.clientID = replica;
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
		let insert: Uint8Array<ArrayBuffer> | null = null;
		doc.on('update', (update: Uint8Array<ArrayBuffer>) => (insert = update));
		doc.get('zw04').insert(1, 'x'.repeat(2 * count + 2));

		const eve = await RawClient.bare(room, { user: 'eve', replica });
		eve.send(syncUpdate(Y.mergeUpdates([insert!, deletesOf(replica, count)])));
		await expectCapHeld(room, eve, count);
		eve.close();
	});

	it('with the entries its own waiting rewrites replace (they wait in memory)', async () => {
		const room = 'hooked-zw04-stay';
		const replica = 9494;
		// Clock 0 is never sent: every struct after it waits. Each rewrite of
		// `a` replaces the previous `a` — a separate range, as a fresh key sits
		// between two rewrites.
		const doc = crdt.createDoc();
		doc.clientID = replica;
		const map = doc.get('zw04');
		map.setAttr('a', -1);
		const rewrites: Uint8Array<ArrayBuffer>[] = [];
		doc.on('update', (update: Uint8Array<ArrayBuffer>) => rewrites.push(update));
		for (let i = 0; i < count; i++) {
			map.setAttr('a', i);
			map.setAttr(`k${i}`, i);
		}
		const eve = await RawClient.bare(room, { user: 'eve', replica });
		eve.send(syncUpdate(Y.mergeUpdates(rewrites)));
		await vi.waitFor(() => expect(eve.acks.length).toBeGreaterThan(0));
		// `count` replaced entries: the unsent first `a` and the first rewrite are adjacent.
		expect(await waitingRefusals(room)).toEqual([
			{ reason: 'waiting', detail: { user: 'eve', ranges: count - 1 } }
		]);
		expect((await waitingState(room)).ranges).toBeLessThanOrEqual(MAX_WAITING_DELETES);

		const bob = await RawClient.bare(room, { user: 'bob' });
		bob.send(syncUpdate(deletesOf(4545, 1)));
		await vi.waitFor(() => expect(bob.ackedDeletes).toContain(1));
		bob.close();
		eve.close();
	});
});

describe('DR-sync-1 · the deletes waiting in memory with rewrites never pin the cap', () => {
	/** Eve's frame: `n` interleaved rewrites of `a` on an unsent clock 0 — `n` replaced entries wait in memory. */
	const rewritesOf = (replica: number, n: number) => {
		const doc = crdt.createDoc();
		doc.clientID = replica;
		const map = doc.get('drsync');
		map.setAttr('a', -1);
		const rewrites: Uint8Array<ArrayBuffer>[] = [];
		doc.on('update', (update: Uint8Array<ArrayBuffer>) => rewrites.push(update));
		for (let i = 0; i < n; i++) {
			map.setAttr('a', i);
			map.setAttr(`k${i}`, i);
		}
		return Y.mergeUpdates(rewrites);
	};

	it('a frame filling MAX_WAITING_DELETES exactly is emptied by dropWaitingDeletes()', async () => {
		const room = 'hooked-drsync-fill';
		const replica = 9696;
		const eve = await RawClient.bare(room, { user: 'eve', replica });
		eve.send(syncUpdate(rewritesOf(replica, MAX_WAITING_DELETES + 1)));
		await vi.waitFor(() => expect(eve.acks.length).toBeGreaterThan(0));
		// The unsent first `a` and the first rewrite's are adjacent: one range.
		expect((await waitingState(room)).ranges).toBe(MAX_WAITING_DELETES);
		expect(await waitingRefusals(room)).toEqual([]);

		expect(await inHooked(room, (r) => r.dropWaitingDeletes())).toEqual({
			ranges: MAX_WAITING_DELETES
		});
		expect((await waitingState(room)).ranges).toBe(0);

		const bob = await RawClient.bare(room, { user: 'bob' });
		bob.send(syncUpdate(deletesOf(4545, 1)));
		await vi.waitFor(() => expect(bob.ackedDeletes).toContain(1));
		expect(await waitingState(room)).toMatchObject({
			ranges: 1,
			kinds: expect.arrayContaining(['pending'])
		});
		expect(await waitingRefusals(room)).toEqual([]);
		bob.close();
		eve.close();
	});

	it('compaction reclaims the in-memory ones of ids no user registered', async () => {
		const room = 'hooked-drsync-compact';
		const replica = 9797;
		// Eve rewrites an entry of 7777 (never registered, never sent to the room).
		const source = crdt.createDoc();
		source.clientID = 7777;
		source.get('drsync').setAttr('a', 'theirs');
		const doc = crdt.createDoc();
		doc.clientID = replica;
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
		let rewrite: Uint8Array<ArrayBuffer> | null = null;
		doc.on('update', (update: Uint8Array<ArrayBuffer>) => (rewrite = update));
		doc.get('drsync').setAttr('a', 'mine');

		const eve = await RawClient.bare(room, { user: 'eve', replica });
		eve.send(syncUpdate(rewrite!));
		await vi.waitFor(() => expect(eve.acks.length).toBeGreaterThan(0));
		expect(await waitingState(room)).toEqual({ ranges: 1, kinds: ['generation', 'snapshot'] });
		eve.close();

		await inHooked(room, (r) => r.compact());
		expect((await waitingState(room)).ranges).toBe(0);
	});
});

describe('ZW-10 · room ids that no URL can carry are refused on both sides', () => {
	const url = 'wss://edytor-do.test/rooms';
	const unreachable = ['', '.', '..', 'x'.repeat(257), 'a\uD800b'];

	it.each(unreachable)('the provider refuses %j at construction, with a clear error', (id) => {
		const document = E.createDocument();
		const dial = () =>
			new crdt.providers.WebsocketProvider(url, id, document.doc, {
				connect: false,
				disableBc: true
			});
		const refusal = `room id ${JSON.stringify(id)} cannot be dialed`;
		expect(dial).toThrow(TypeError);
		expect(dial).toThrow(refusal);
		expect(() => crdt.providers.createWebsocketSync({ server: url, room: id })).toThrow(refusal);
		document.destroy();
	});

	it.each(unreachable)('the route closes %j 4400, never reaching a room', async (id) => {
		let reached = false;
		const rooms = {
			getByName() {
				reached = true;
				throw new Error('never');
			}
		};
		const request = new Request(`${url.replace('wss', 'https')}/x`, {
			headers: { Upgrade: 'websocket' }
		});
		const response = await routeDocumentSocket(request, rooms, id, () => ({ userId: 'ada' }));
		const ws = response.webSocket!;
		ws.accept();
		const closed = await new Promise((resolve) =>
			ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }))
		);
		expect(closed).toEqual({ code: 4400, reason: 'invalid document id' });
		expect(reached).toBe(false);
	});

	it('a dotted id that is not a whole segment still reaches its own room', () => {
		const document = E.createDocument();
		for (const id of ['...', '.a', 'a.', 'a/..', 'x'.repeat(256), 'emoji \u{1F600}']) {
			const provider = new crdt.providers.WebsocketProvider(url, id, document.doc, {
				connect: false,
				disableBc: true
			});
			expect(new URL(provider.url).pathname).toBe(`/rooms/${encodeURIComponent(id)}`);
			provider.destroy();
		}
		document.destroy();
	});
});
