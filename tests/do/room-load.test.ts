/**
 * WU-16 follow-ups (production-readiness plan) — the room under load, the
 * soak's findings (`site/content/docs/server/room.mdx`, Load):
 *
 * - `room.presence.fanout`: the room relays presence within a budget of
 *   frames a second over all its sockets (`maxPresenceFanout`). Within it,
 *   an entry goes out at once, as before; past it, entries wait per
 *   recipient (the newest of each replica) and go out together, one frame
 *   per recipient, at the end of a later message once the budget has a
 *   frame for it. A departure goes out at once and drops the entries it
 *   removes from every recipient's wait.
 * - `room.storage.outage`: the first frame whose append fails rebuilds the
 *   document from its rows; until storage answers again, a frame that
 *   would write is closed `1011` before it is applied (a probe write, rolled
 *   back, asks storage), with no second rebuild; a frame that writes
 *   nothing (a join) is served from memory, which equals what is stored.
 *
 * The `quota-fanout-*` rooms (`QuotaRoom`) relay 5 presence frames a second
 * (a one-second burst). Expected values are hand-authored from the
 * contract rows above.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_MAX_PRESENCE_FANOUT,
	type DocumentRoom as Room
} from '../../src/lib/cloudflare/index.js';
import type { QuotaRoom } from './worker';
import { E, RawClient, Y, crdt, para, readFacade, storedUpdate } from './client';

const SLOW = { timeout: 20_000, interval: 50 };

declare global {
	namespace Cloudflare {
		interface Env {
			QUOTA: DurableObjectNamespace<QuotaRoom>;
		}
	}
}

/** The presence frames `client` received, each as its entries' replicas. */
const presenceFrames = (client: RawClient) =>
	client.received.flatMap((bytes) => {
		const decoder = E.createDecoder(bytes);
		if (!E.readProtocolVersion(decoder) || E.readVarUint(decoder) !== E.messageAwareness) return [];
		return [E.readAwarenessEntries(E.readVarUint8Array(decoder)).map((entry) => entry.clientID)];
	});

/** A message that writes nothing (a Step1): the room releases what waits at its end. */
const nudge = (client: RawClient) =>
	client.send(E.frame(E.messageSync, (e) => crdt.sync.writeSyncStep1(e, client.doc)));

describe('WU-16 · presence fan-out within a budget (room.presence.fanout)', () => {
	it('the default budget relays a busy room at once (each entry, to every socket)', async () => {
		expect(DEFAULT_MAX_PRESENCE_FANOUT).toBe(2000);
		const room = 'wu16-fanout-default';
		const clients = await Promise.all(
			[701, 702, 703].map((replica) => RawClient.bare(room, { user: `u${replica}`, replica }))
		);
		for (const [i, client] of clients.entries()) client.setPresence(701 + i, 1, { n: i });
		// Nothing else is sent: each entry reaches each socket on its own.
		await vi.waitFor(() => {
			for (const client of clients) expect(client.presence.size).toBe(3);
		}, SLOW);
		for (const client of clients) {
			expect(presenceFrames(client).every((frame) => frame.length === 1)).toBe(true);
		}
		for (const client of clients) client.close();
	});

	it('past the budget, entries wait per recipient and go out together, the newest of each replica', async () => {
		const room = 'quota-fanout-coalesce';
		const replicas = [711, 712, 713, 714];
		const clients = await Promise.all(
			replicas.map((replica) => RawClient.bare(room, { user: `u${replica}`, replica }))
		);
		// 4 sockets × 30 entries: 480 relays one at a time; the budget is 5 a second.
		for (let clock = 1; clock <= 30; clock++)
			for (const [i, client] of clients.entries())
				client.setPresence(replicas[i], clock, { clock });
		await vi.waitFor(async () => {
			nudge(clients[0]);
			for (const client of clients)
				for (const replica of replicas) expect(client.presence.get(replica)?.clock).toBe(30);
		}, SLOW);
		const frames = clients.map(presenceFrames);
		// Far fewer frames than entries: a frame carries every replica that waited.
		for (const received of frames) expect(received.length).toBeLessThan(40);
		expect(frames.flat().some((frame) => frame.length > 1)).toBe(true);
		// A frame carries a replica once (its newest entry).
		for (const frame of frames.flat()) expect(new Set(frame).size).toBe(frame.length);
		for (const client of clients) client.close();
	});

	it('a departure goes out at once and is never overtaken by the entry it removes', async () => {
		const room = 'quota-fanout-depart';
		const peer = await RawClient.bare(room, { user: 'pam', replica: 721 });
		const leaver = await RawClient.bare(room, { user: 'lee', replica: 722 });
		const other = await RawClient.bare(room, { user: 'oto', replica: 723 });
		// Spend the budget, so the leaver's last entries wait.
		for (let clock = 1; clock <= 20; clock++) {
			peer.setPresence(721, clock, { clock });
			other.setPresence(723, clock, { clock });
			leaver.setPresence(722, clock, { clock });
		}
		await vi.waitFor(
			async () =>
				expect(
					await runInDurableObject(
						env.QUOTA.getByName(room),
						(r: Room) => r.presence.get(722)?.clock
					)
				).toBe(20),
			SLOW
		);
		leaver.close();
		await vi.waitFor(
			async () =>
				expect(
					await runInDurableObject(env.QUOTA.getByName(room), (r: Room) => r.presence.has(722))
				).toBe(false),
			SLOW
		);
		// Whatever waited for the peer goes out now: never the leaver's entry.
		await vi.waitFor(() => {
			nudge(other);
			expect(peer.presence.get(723)?.clock).toBe(20);
		}, SLOW);
		await new Promise((resolve) => setTimeout(resolve, 1200));
		nudge(other);
		await vi.waitFor(() => expect(peer.presence.get(723)?.clock).toBe(20), SLOW);
		expect(peer.presence.has(722)).toBe(false);
		peer.close();
		other.close();
	});
});

const inRoom = <T>(room: string, fn: (r: Room, state: DurableObjectState) => T) =>
	runInDurableObject(env.ROOM.getByName(room), (r: Room, state) => fn(r, state));

const FAIL_APPEND =
	"CREATE TRIGGER wu16_fail_append BEFORE INSERT ON rows WHEN NEW.kind = 'update' BEGIN SELECT RAISE(ABORT, 'injected outage'); END";

/** The text of block `id` in what the room STORED (its rows, merged). */
const storedText = (r: Room, id: string) => {
	const stored = crdt.createDoc();
	Y.applyUpdate(stored, storedUpdate(r.records()));
	return readFacade(stored, (f) => f.blockText(id));
};

describe('WU-16 · a storage outage rebuilds once (room.storage.outage)', () => {
	it('the first failing frame rebuilds; later writes are closed 1011 unapplied, with no rebuild, until storage answers', async () => {
		const room = 'wu16-outage';
		const a = E.createDocument({ value: { children: [para('p', 'hello')] } });
		const ada = await RawClient.connect(room, a.doc, { user: 'ada' });
		await vi.waitFor(() => expect(ada.stored()).toBe(true), SLOW);
		const b = E.createDocument();
		const bob = await RawClient.connect(room, b.doc, { user: 'bob' });
		await vi.waitFor(() => expect(b.facade.blockText('p')).toBe('hello'), SLOW);
		await vi.waitFor(() => expect(bob.stored()).toBe(true), SLOW);

		const before = await inRoom(room, (r, state) => {
			state.storage.sql.exec(FAIL_APPEND);
			return r.doc;
		});
		// The first failing frame: closed 1011, the document rebuilt from its rows.
		a.transact(() => a.facade.insertText('p', 5, '!'));
		await vi.waitFor(
			() => expect(ada.closed).toEqual({ code: 1011, reason: 'storage failure' }),
			SLOW
		);
		const rebuilt = await inRoom(room, (r) => r.doc);
		expect(rebuilt).not.toBe(before);
		// A second writer during the outage: closed 1011, its frame never applied, no rebuild.
		b.transact(() => b.facade.insertText('p', 0, '>'));
		await vi.waitFor(
			() => expect(bob.closed).toEqual({ code: 1011, reason: 'storage failure' }),
			SLOW
		);
		expect(
			await inRoom(room, (r) => ({
				same: r.doc === rebuilt,
				live: r.facade.blockText('p'),
				stored: storedText(r, 'p')
			}))
		).toEqual({ same: true, live: 'hello', stored: 'hello' });
		// A join that writes nothing is served from memory during the outage.
		const cal = await RawClient.connect(room, undefined, { user: 'cal' });
		const text = () => readFacade(cal.doc, (f) => f.blockText('p'));
		await vi.waitFor(() => expect(text()).toBe('hello'), SLOW);
		expect(cal.closed).toBe(null);
		expect(await inRoom(room, (r) => r.doc === rebuilt)).toBe(true);

		// Storage answers again: the next write is stored and relayed.
		await inRoom(room, (_r, state) => state.storage.sql.exec('DROP TRIGGER wu16_fail_append'));
		const ada2 = await RawClient.connect(room, a.doc, { user: 'ada' });
		await vi.waitFor(() => expect(ada2.stored()).toBe(true), SLOW);
		await vi.waitFor(() => expect(text()).toBe('hello!'), SLOW);
		expect(await inRoom(room, (r) => [r.doc === rebuilt, storedText(r, 'p')])).toEqual([
			true,
			'hello!'
		]);
		for (const client of [ada2, cal]) client.close();
		for (const document of [a, b]) document.destroy();
	});
});
