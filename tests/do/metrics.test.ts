/**
 * Phase 2, H14 — the room's counters (`metrics()`, also over RPC) and its
 * log (one entry per compaction, quota hit, denial or fault).
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import type { JSONDoc } from '../../src/lib/crdt/index.js';
import type { LockedRoom, QuotaRoom } from './worker';
import { E, RawClient, para } from './client';

declare global {
	namespace Cloudflare {
		interface Env {
			QUOTA: DurableObjectNamespace<QuotaRoom>;
			LOCKED: DurableObjectNamespace<LockedRoom>;
		}
	}
}

const join = async (room: string, user: string, value?: JSONDoc) => {
	const document = E.createDocument({ value, actor: { id: user } });
	const client = await RawClient.connect(room, document.doc, {
		user,
		replica: document.doc.clientID
	});
	await vi.waitFor(() => expect(client.synced).toBe(true));
	return { document, client };
};

describe('H14 · room metrics and log', () => {
	it('counts the document, its records, sockets, folds, fan-out and compactions; over RPC', async () => {
		const room = 'h14-metrics';
		const ada = await join(room, 'ada', { children: [para('p', 'hello')] });
		const bob = await join(room, 'bob');
		for (let i = 0; i < 5; i++)
			ada.document.transact(() => ada.document.facade.insertText('p', 0, 'x'));
		await vi.waitFor(() => expect(bob.document.facade.blockText('p')).toBe('xxxxxhello'));
		const stub = env.ROOM.getByName(room);
		const before = await stub.metrics();
		expect(before.sockets).toBe(2);
		expect(before.documentBytes).toBeGreaterThan(0);
		expect(before.storedBytes).toBeGreaterThan(0);
		expect(before.records).toBeGreaterThan(1);
		expect(before.rows).toBeGreaterThanOrEqual(before.records);
		expect(before.updateRecords).toBeGreaterThan(0);
		expect(before.fold.count).toBeGreaterThanOrEqual(5);
		expect(before.fold.totalMs).toBeGreaterThanOrEqual(0);
		expect(before.fanOut.messages).toBeGreaterThanOrEqual(5);
		expect(before.fanOut.bytes).toBeGreaterThan(0);
		expect(before.quotaHits).toBe(0);
		expect(before.validationDenials).toBe(0);
		expect(before.since).toBeLessThanOrEqual(Date.now());

		await stub.compact();
		await runInDurableObject(stub, (r: Room) => r.compressed());
		const after = await stub.metrics();
		expect(after.compaction.count).toBe(before.compaction.count + 1);
		expect(after.compaction.lastBytes).toBeGreaterThan(0);
		expect(after.updateRecords).toBe(0);
		expect(after.records).toBe(2); // the generation record and the snapshot
		expect(after.storedBytes).toBeLessThan(before.storedBytes);
		for (const peer of [ada, bob]) peer.client.close();
		for (const peer of [ada, bob]) peer.document.destroy();
	});

	it('logs compactions and quota hits; counts the hits', async () => {
		const room = 'quota-metrics';
		const ada = await join(room, 'ada', { children: [para('p', '')] });
		for (let i = 0; i < 40; i++)
			ada.document.transact(() => ada.document.facade.insertText('p', i, 'x'));
		await vi.waitFor(() => expect(ada.client.closed?.code).toBe(4413));
		const stub = env.QUOTA.getByName(room);
		expect((await stub.metrics()).quotaHits).toBe(1);
		const logged = await runInDurableObject(stub, (r: QuotaRoom) => r.logged);
		expect(logged).toContainEqual({ edytor: 'quota', user: 'ada', quota: 'rate' });
		await stub.compact();
		const compactions = (await runInDurableObject(stub, (r: QuotaRoom) => r.logged)).filter(
			(entry) => entry.edytor === 'compaction'
		);
		expect(compactions.length).toBeGreaterThanOrEqual(1);
		expect(compactions.at(-1)).toMatchObject({ edytor: 'compaction', records: 2 });
		ada.document.destroy();
	});

	it('logs and counts validation denials', async () => {
		const room = 'locked-metrics';
		const ada = await join(room, 'ada', { children: [para('p', 'mine')] });
		ada.document.transact(() => ada.document.facade.setBlockData('p', { lockedBy: 'ada' }));
		const bob = await join(room, 'bob');
		await vi.waitFor(() =>
			expect(bob.document.facade.blockDataOf('p')).toEqual({ lockedBy: 'ada' })
		);
		bob.document.transact(() => bob.document.facade.insertText('p', 0, 'bob'));
		const stub = env.LOCKED.getByName(room);
		await vi.waitFor(async () => expect((await stub.metrics()).validationDenials).toBe(1));
		expect(await runInDurableObject(stub, (r: LockedRoom) => r.logged)).toContainEqual({
			edytor: 'denied',
			user: 'bob',
			touched: 1
		});
		for (const peer of [ada, bob]) peer.client.close();
		for (const peer of [ada, bob]) peer.document.destroy();
	});
});
