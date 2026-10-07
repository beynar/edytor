/**
 * WU-05 (production-readiness plan, R3) — presence within quotas
 * (`room.presence.quota` in `docs/editor-delete-contract.md`).
 *
 * - an entry whose state is larger than `maxPresenceBytes` (16 KiB) is
 *   ignored: not kept, not relayed, logged as a `presence` refusal
 *   (`quota: 'size'`); the socket stays and its next entry is relayed;
 * - presence and presence queries have their own rate
 *   (`maxPresencePerSecond`, a token bucket with a ten-second burst):
 *   entries past it are coalesced, the newest held and relayed in one
 *   frame once the socket's rate allows it again; queries past it are
 *   dropped; both logged `presence` (`quota: 'rate'`), once per burst
 *   (`refusalCounts.presence` counts each message);
 * - read-only sockets keep presence, within the same quotas.
 *
 * The `quota-*` rooms (`QuotaRoom`) allow 2 presence messages a second
 * (a burst of 20); `ROOM` keeps the defaults.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_MAX_PRESENCE_BYTES,
	type DocumentRoom as Room
} from '../../src/lib/cloudflare/index.js';
import type { QuotaRoom } from './worker';
import { E, RawClient, crdt } from './client';

const SLOW = { timeout: 20_000, interval: 25 };

declare global {
	namespace Cloudflare {
		interface Env {
			QUOTA: DurableObjectNamespace<QuotaRoom>;
		}
	}
}

/** The presence frames `client` received that carry `replica`'s entry, as that entry's state. */
const heardFrom = (client: RawClient, replica: number) =>
	client.received.flatMap((bytes) => {
		const decoder = E.createDecoder(bytes);
		if (!E.readProtocolVersion(decoder) || E.readVarUint(decoder) !== E.messageAwareness) return [];
		const entries = E.readAwarenessEntries(E.readVarUint8Array(decoder));
		return entries.filter((entry) => entry.clientID === replica).map((entry) => entry.state);
	});

const presenceRefusals = (stub: DurableObjectStub<Room>) =>
	runInDurableObject(stub, (r: Room) =>
		r.refusals.filter((refusal) => refusal.reason === 'presence').map((refusal) => refusal.detail)
	);

const queryFrame = () => E.frame(E.messageQueryAwareness, () => {});

describe('WU-05 · presence quota', () => {
	it('an entry past maxPresenceBytes is ignored and logged; the socket stays', async () => {
		expect(DEFAULT_MAX_PRESENCE_BYTES).toBe(16 * 1024);
		const room = 'wu05-size';
		const stub = env.ROOM.getByName(room);
		const peer = await RawClient.connect(room, undefined, { user: 'pam' });
		const sender = await RawClient.connect(room, undefined, { user: 'sam', replica: 501 });
		await vi.waitFor(() => expect(peer.synced && sender.synced).toBe(true), SLOW);
		const big = { blob: 'x'.repeat(DEFAULT_MAX_PRESENCE_BYTES) };
		sender.setPresence(501, 1, big);
		await vi.waitFor(async () => expect(await presenceRefusals(stub)).toHaveLength(1), SLOW);
		expect(await presenceRefusals(stub)).toEqual([
			{
				user: 'sam',
				quota: 'size',
				bytes: new TextEncoder().encode(JSON.stringify(big)).length,
				limit: DEFAULT_MAX_PRESENCE_BYTES
			}
		]);
		expect(await runInDurableObject(stub, (r: Room) => r.presence.has(501))).toBe(false);
		// Within the limit, the next entry is relayed at once.
		sender.setPresence(501, 2, { user: { name: 'Sam' } });
		await vi.waitFor(
			() => expect(peer.presence.get(501)?.state).toEqual({ user: { name: 'Sam' } }),
			SLOW
		);
		expect(heardFrom(peer, 501)).toEqual([{ user: { name: 'Sam' } }]);
		expect(sender.closed).toBe(null);

		// A read-only socket keeps presence.
		const viewer = await RawClient.connect(room, undefined, {
			user: 'viv',
			access: 'read',
			replica: 502
		});
		viewer.setPresence(502, 1, { user: { name: 'Viv' } });
		await vi.waitFor(
			() => expect(peer.presence.get(502)?.state).toEqual({ user: { name: 'Viv' } }),
			SLOW
		);
		for (const client of [peer, sender, viewer]) client.close();
	});

	it('a presence flood is coalesced past the rate: the newest entry follows in one frame', async () => {
		const room = 'quota-presence-flood';
		const stub = env.QUOTA.getByName(room);
		const peer = await RawClient.connect(room, undefined, { user: 'pam' });
		const sender = await RawClient.bare(room, { user: 'sam', replica: 601 });
		await vi.waitFor(() => expect(peer.synced).toBe(true), SLOW);
		for (let clock = 1; clock <= 60; clock++) sender.setPresence(601, clock, { n: clock });
		await vi.waitFor(
			async () =>
				expect(await runInDurableObject(stub, (r: Room) => r.presence.get(601)?.clock)).toBe(60),
			SLOW
		);
		const relayed = heardFrom(peer, 601).length;
		// The burst (20) went out; the rest waits as one entry, the newest.
		expect(relayed).toBeGreaterThanOrEqual(20);
		expect(relayed).toBeLessThan(30);
		expect(peer.presence.get(601)?.state).not.toEqual({ n: 60 });
		// A burst is one log entry, until a message within the rate ends it (a
		// slow run refills a token mid-flood: a new burst); refusalCounts
		// counts every message past the rate.
		const bursts = await presenceRefusals(stub);
		expect(bursts.length).toBeGreaterThanOrEqual(1);
		expect(bursts.length).toBeLessThanOrEqual(5);
		expect(new Set(bursts.map((x) => JSON.stringify(x)))).toEqual(
			new Set([JSON.stringify({ user: 'sam', quota: 'rate', limit: 2 })])
		);
		expect(
			await runInDurableObject(stub, (r: Room) => r.refusalCounts.presence)
		).toBeGreaterThanOrEqual(30);
		// Once the socket's rate allows it, any message lets the newest out.
		await new Promise((resolve) => setTimeout(resolve, 1200));
		peer.send(E.frame(E.messageSync, (e) => crdt.sync.writeSyncStep1(e, peer.doc)));
		await vi.waitFor(() => expect(peer.presence.get(601)?.state).toEqual({ n: 60 }), SLOW);
		expect(heardFrom(peer, 601).length).toBe(relayed + 1);
		// A new burst past the rate is logged again, once.
		for (let clock = 61; clock <= 90; clock++) sender.setPresence(601, clock, { n: clock });
		await vi.waitFor(
			async () => expect((await presenceRefusals(stub)).length).toBeGreaterThan(bursts.length),
			SLOW
		);
		expect(sender.closed).toBe(null);
		peer.close();
		sender.close();
	});

	it('a query flood is rate-limited: queries past the rate are dropped', async () => {
		const room = 'quota-presence-query';
		const stub = env.QUOTA.getByName(room);
		const asker = await RawClient.bare(room, { user: 'quin' });
		for (let i = 0; i < 40; i++) asker.send(queryFrame());
		await vi.waitFor(
			async () =>
				expect(
					await runInDurableObject(stub, (r: Room) => r.refusalCounts.presence ?? 0)
				).toBeGreaterThanOrEqual(15),
			SLOW
		);
		const bursts = await presenceRefusals(stub);
		expect(bursts.length).toBeGreaterThanOrEqual(1);
		expect(bursts.length).toBeLessThanOrEqual(5);
		const answers = asker.received.filter((bytes) => {
			const decoder = E.createDecoder(bytes);
			return E.readProtocolVersion(decoder) && E.readVarUint(decoder) === E.messageAwareness;
		}).length;
		expect(answers).toBeLessThan(26);
		expect(asker.closed).toBe(null);
		asker.close();
	});
});
