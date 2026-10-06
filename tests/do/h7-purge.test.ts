/**
 * Phase 3, H7 — the room purges deleted content past the horizon
 * (`docs/research/crdt-fix-plan-2026-10.md`). Rows `room.purge.timing`,
 * `room.purge.what`, `room.purge.stale` and `hist.purge.horizon` of
 * `docs/editor-delete-contract.md`, in workerd with the room's clock
 * moved (`timed-*` rooms):
 *
 * - the purge task records an epoch a day; content deleted before the
 *   newest epoch at least 30 days old is purged from the stored rows and
 *   from every replica, a fresh client never receives it;
 * - content deleted 29 days ago is still restorable, by the history and by
 *   an undo;
 * - the stored size drops (1,000 of 1,001 blocks deleted);
 * - a replica offline for 40 days reconnects and converges, its edits to
 *   live content kept; two clients connected across a purge converge;
 * - only the room writes the horizon: a client's write of it is stripped.
 */
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { JSONDoc } from '../../src/lib/crdt/index.js';
import { E, RawClient, Y, crdt, para } from './client';
import { setNow, type TimedRoom } from './worker';

declare global {
	namespace Cloudflare {
		interface Env {
			TIMED: DurableObjectNamespace<TimedRoom>;
		}
	}
}

/** `vi.waitFor` under a loaded pool: the default 1 s is short for a room's round trips. */
const SLOW = { timeout: 10_000, interval: 25 };
const DAY = 86_400_000;
const T0 = Date.parse('2026-10-06T08:00:00Z');

const stub = (room: string) => env.TIMED.getByName(room);
const inRoom = <T>(room: string, fn: (r: TimedRoom, state: DurableObjectState) => T) =>
	runInDurableObject(stub(room), (r: TimedRoom, state) => fn(r, state));
const clockTo = (room: string, at: number) =>
	inRoom(room, (_r, state) => setNow(state.storage.sql, at));
/** Move the room's clock to `at` and run its alarm (every task due). */
const advance = async (room: string, at: number) => {
	await clockTo(room, at);
	await runDurableObjectAlarm(stub(room));
	await inRoom(room, (r) => r.historyWritten());
};

const roomJSON = (room: string) =>
	inRoom(room, (r) => JSON.parse(JSON.stringify(r.read())) as JSONDoc);

/** What the room stored, as text: every record's bytes (a snapshot inflated). */
const storedText = (room: string) =>
	inRoom(room, (r) =>
		r
			.records()
			.map((record) => new TextDecoder('utf-8', { fatal: false }).decode(record.bytes))
			.join('')
	);

const holds = (doc: E.YDoc, text: string) =>
	new TextDecoder('utf-8', { fatal: false }).decode(Y.encodeStateAsUpdate(doc)).includes(text);

/** A writer's tab: a document seeded with `children`, dialing the room as `user`. */
const writer = async (
	room: string,
	user: string,
	children = [para('p1', 'keep this'), para('p2', 'secret words'), para('p3', 'tail')]
) => {
	const document = E.createDocument({
		value: { children },
		actor: { id: user },
		history: { captureTimeout: 0 }
	});
	const client = await RawClient.connect(room, document.doc, {
		user,
		replica: document.doc.clientID
	});
	await vi.waitFor(() => expect(client.synced).toBe(true), SLOW);
	return { document, client };
};

const converged = async (room: string, ...docs: E.YDoc[]) => {
	await vi.waitFor(async () => {
		const json = await roomJSON(room);
		for (const doc of docs) {
			const facade = crdt.doc.create(doc as never);
			try {
				expect(JSON.parse(JSON.stringify(facade.toJSON()))).toEqual(json);
			} finally {
				facade.dispose();
			}
		}
	}, SLOW);
	return roomJSON(room);
};

describe('H7 · the purge, on the room’s clock', () => {
	it('text deleted 31 days ago is gone from the stored bytes, from a client and from a fresh client', async () => {
		const room = 'timed-nohistory-31';
		await clockTo(room, T0);
		const ada = await writer(room, 'ada');
		const f = ada.document.facade;
		await clockTo(room, T0 + 3600_000);
		ada.document.transact(() => f.deleteBlocks(['p2']));
		ada.document.transact(() => f.deleteText('p1', 4, 5)); // ' this'
		await converged(room, ada.document.doc);
		expect(await storedText(room)).toContain('secret');
		// The purge task's first tick, a day after the first change, records an epoch.
		expect(await inRoom(room, (_r, state) => state.storage.getAlarm())).toBe(T0 + DAY);
		await advance(room, T0 + DAY);
		expect(
			await inRoom(room, (_r, state) =>
				state.storage.sql.exec<{ at: number }>('SELECT at FROM epochs').toArray()
			)
		).toEqual([{ at: T0 + DAY }]);
		// Thirty days after that epoch, the next tick purges.
		expect(await inRoom(room, (_r, state) => state.storage.getAlarm())).toBe(T0 + 31 * DAY);
		await advance(room, T0 + 31 * DAY);
		const metrics = await inRoom(room, (r) => r.metrics().purge);
		expect(metrics).toMatchObject({ runs: 1, horizon: T0 + DAY, removed: 1, marks: 1 });
		const logged = await inRoom(room, (r) => r.logged.filter((e) => e.edytor === 'purge'));
		expect(logged).toEqual([
			expect.objectContaining({ edytor: 'purge', horizon: T0 + DAY, removed: 1 })
		]);
		await inRoom(room, (r) => r.compressed());
		expect(await storedText(room)).not.toContain('secret');
		// Ada, connected, applied the purge: her history released the text too.
		const json = await converged(room, ada.document.doc);
		expect(json.children.map((b) => b.id)).toEqual(['p1', 'p3']);
		expect(holds(ada.document.doc, 'secret')).toBe(false);
		expect(ada.document.history.undo()).toBe(null);
		// A fresh client never receives it.
		const fresh = await RawClient.connect(room, crdt.createDoc(), { user: 'zoe' });
		await vi.waitFor(() => expect(fresh.synced).toBe(true), SLOW);
		await converged(room, fresh.doc);
		expect(holds(fresh.doc, 'secret')).toBe(false);
		expect(holds(fresh.doc, ' this')).toBe(false);
		// Nothing waits to pass the horizon: no tick is armed any more.
		expect(
			await inRoom(room, (_r, state) =>
				state.storage.sql.exec("SELECT value FROM meta WHERE key = 'due.purge'").toArray()
			)
		).toEqual([]);
		fresh.close();
		ada.client.close();
		ada.document.destroy();
	});

	/** Ada deletes p2 at T0 + 5 h, after the morning version; the room runs 29 daily ticks. */
	const deletedFor29Days = async (room: string) => {
		await clockTo(room, T0);
		const ada = await writer(room, 'ada');
		await advance(room, T0 + 4 * 3600_000); // the morning version holds p2
		await clockTo(room, T0 + 5 * 3600_000);
		ada.document.transact(() => ada.document.facade.deleteBlocks(['p2']));
		await converged(room, ada.document.doc);
		for (let day = 1; day <= 29; day++) await advance(room, T0 + day * DAY);
		expect(await inRoom(room, (r) => r.metrics().purge.runs)).toBe(0);
		expect(await storedText(room)).toContain('secret');
		return ada;
	};

	it('content deleted 29 days ago is still restorable by an undo', async () => {
		const room = 'timed-utc-29-undo';
		const ada = await deletedFor29Days(room);
		ada.document.history.undo();
		const json = await converged(room, ada.document.doc);
		expect(json.children.map((b) => b.id)).toEqual(['p1', 'p2', 'p3']);
		ada.client.close();
		ada.document.destroy();
	});

	it('content deleted 29 days ago is still restorable by the history', async () => {
		const room = 'timed-utc-29-history';
		const ada = await deletedFor29Days(room);
		const key = `history/${room}/2026-10-06-am`;
		expect((await inRoom(room, (r) => r.listHistory())).map((v) => v.key)).toContain(key);
		const restored = await inRoom(room, (r) => r.restoreHistory(key, { user: 'ada' }));
		expect(restored).toMatchObject({ status: 'applied', revived: 1 });
		const json = await converged(room, ada.document.doc);
		expect(json.children.map((b) => b.id)).toEqual(['p1', 'p2', 'p3']);
		expect(json.children[1].content).toEqual([{ text: 'secret words' }]);
		ada.client.close();
		ada.document.destroy();
	});

	it('the stored size drops: 1,000 of 1,001 blocks deleted, purged', async () => {
		const room = 'timed-nohistory-size';
		await clockTo(room, T0);
		const children = Array.from({ length: 1001 }, (_, i) =>
			para(`b${i}`, `paragraph number ${i} with some text in it`)
		);
		const ada = await writer(room, 'ada', children);
		await vi.waitFor(async () => expect((await roomJSON(room)).children).toHaveLength(1001), SLOW);
		await inRoom(room, (r) => r.compact());
		await inRoom(room, (r) => r.compressed());
		const full = await inRoom(room, (r) => r.metrics().storedBytes);
		ada.document.transact(() =>
			ada.document.facade.deleteBlocks(children.slice(1).map((b) => b.id))
		);
		await vi.waitFor(async () => expect((await roomJSON(room)).children).toHaveLength(1), SLOW);
		await inRoom(room, (r) => r.compact());
		await inRoom(room, (r) => r.compressed());
		const deleted = await inRoom(room, (r) => r.metrics().storedBytes);
		await advance(room, T0 + DAY);
		await advance(room, T0 + 31 * DAY);
		await inRoom(room, (r) => r.compressed());
		const purged = await inRoom(room, (r) => ({
			stored: r.metrics().storedBytes,
			snapshot: r.metrics().compaction.lastBytes,
			removed: r.metrics().purge.removed
		}));
		console.info(
			`H7 room size: full ${full} B, 1000 deleted ${deleted} B, purged ${purged.stored} B stored (${purged.snapshot} B v2)`
		);
		expect(purged.removed).toBe(1000);
		expect(purged.stored * 4).toBeLessThan(deleted);
		ada.client.close();
		ada.document.destroy();
	});

	it('a replica offline for 40 days reconnects: its live edits kept, its edits to purged blocks dropped, all converge', async () => {
		const room = 'timed-nohistory-40';
		await clockTo(room, T0);
		const ada = await writer(room, 'ada');
		// Carl syncs, then goes offline for 40 days.
		const carl = E.createDocument({ actor: { id: 'carl' }, history: { captureTimeout: 0 } });
		const first = await RawClient.connect(room, carl.doc, {
			user: 'carl',
			replica: carl.doc.clientID
		});
		await vi.waitFor(() => expect(first.json().children).toHaveLength(3), SLOW);
		first.close();
		await clockTo(room, T0 + 3600_000);
		ada.document.transact(() => ada.document.facade.deleteBlocks(['p2']));
		await converged(room, ada.document.doc);
		await advance(room, T0 + DAY);
		await advance(room, T0 + 31 * DAY);
		expect(await inRoom(room, (r) => r.metrics().purge.removed)).toBe(1);
		// Day 40: Carl, still offline, types into p1 and into p2, and moves p3 under p2.
		await clockTo(room, T0 + 40 * DAY);
		carl.transact(() => carl.facade.insertText('p1', 0, 'Carl: '));
		carl.transact(() => carl.facade.insertText('p2', 0, 'lost '));
		carl.transact(() => carl.facade.moveBlocks(['p3'], { parent: 'p2', index: 0 }));
		await evictDurableObject(stub(room));
		const back = await RawClient.connect(room, carl.doc, {
			user: 'carl',
			replica: carl.doc.clientID
		});
		await vi.waitFor(() => expect(back.synced).toBe(true), SLOW);
		const json = await converged(room, carl.doc, ada.document.doc);
		expect(json.children.map((b) => b.id).sort()).toEqual(['p1', 'p3']);
		expect(json.children.find((b) => b.id === 'p1')!.content).toEqual([
			{ text: 'Carl: keep this' }
		]);
		expect(holds(carl.doc, 'secret')).toBe(false);
		expect(holds(carl.doc, 'lost')).toBe(false);
		// Nothing waits on the room, and no refusal: no stale-replica close exists.
		expect(await inRoom(room, (r) => r.doc!.store.pendingStructs)).toBe(null);
		expect(back.closed).toBe(null);
		expect(await inRoom(room, (r) => r.refusals.filter((x) => x.reason !== 'history'))).toEqual([]);
		back.close();
		ada.client.close();
		ada.document.destroy();
		carl.destroy();
	});

	it('two clients connected across a purge converge, an edit right after it included', async () => {
		const room = 'timed-nohistory-two';
		await clockTo(room, T0);
		const ada = await writer(room, 'ada');
		const bob = await writer(room, 'bob');
		ada.document.transact(() => ada.document.facade.deleteBlocks(['p2']));
		ada.document.transact(() => ada.document.facade.splitBlock('p1', 4, 'p1b'));
		ada.document.transact(() => ada.document.facade.deleteBlocks(['p1b']));
		await converged(room, ada.document.doc, bob.document.doc);
		await advance(room, T0 + DAY);
		await advance(room, T0 + 31 * DAY);
		bob.document.transact(() => bob.document.facade.insertText('p3', 4, ' end'));
		const json = await converged(room, ada.document.doc, bob.document.doc);
		expect(json.children.map((b) => b.id)).toEqual(['p1', 'p3']);
		expect(json.children[1].content).toEqual([{ text: 'tail end' }]);
		expect(await inRoom(room, (r) => r.metrics().purge)).toMatchObject({ removed: 1, emptied: 1 });
		for (const tab of [ada, bob]) {
			expect(holds(tab.document.doc, 'secret')).toBe(false);
			tab.client.close();
			tab.document.destroy();
		}
	});

	it('a restore past the horizon can no longer be undone', async () => {
		const room = 'timed-utc-restore-old';
		await clockTo(room, T0);
		const ada = await writer(room, 'ada');
		await advance(room, T0 + 4 * 3600_000); // the morning version
		await clockTo(room, T0 + 5 * 3600_000);
		ada.document.transact(() => ada.document.facade.deleteBlocks(['p3']));
		await converged(room, ada.document.doc);
		await inRoom(room, (r) => r.restoreHistory(`history/${room}/2026-10-06-am`));
		await converged(room, ada.document.doc);
		await advance(room, T0 + DAY);
		await advance(room, T0 + 31 * DAY);
		expect(await inRoom(room, (r) => r.metrics().purge.runs)).toBe(1);
		expect(await inRoom(room, (r) => r.undoRestore())).toEqual({ status: 'noop' });
		ada.client.close();
		ada.document.destroy();
	});
});

describe('H7 · only the room writes the horizon', () => {
	it("a client's write of the horizon root is stripped (`mark`), the rest of its frame kept", async () => {
		const room = 'timed-nohistory-forge';
		await clockTo(room, T0);
		const ada = await writer(room, 'ada');
		ada.document.transact(() => {
			ada.document.facade.insertText('p1', 0, 'ok ');
		});
		await converged(room, ada.document.doc);
		// A forged horizon from Ada's own client: every new struct of that client in the frame is stripped.
		const mallory = crdt.createDoc();
		const tab = await RawClient.connect(room, mallory, {
			user: 'mallory',
			replica: mallory.clientID
		});
		await vi.waitFor(() => expect(tab.synced).toBe(true), SLOW);
		mallory.get('horizon').setAttr('h', { at: 0, sv: Y.encodeStateVector(mallory) });
		await vi.waitFor(
			async () =>
				expect(await inRoom(room, (r) => r.refusals.some((x) => x.reason === 'mark'))).toBe(true),
			SLOW
		);
		expect(await inRoom(room, (r) => r.doc!.get('horizon').getAttr('h'))).toBe(undefined);
		tab.close();
		ada.client.close();
		ada.document.destroy();
	});
});
