/**
 * Phase 3, H11 — version history in KV (`docs/research/crdt-fix-plan-2026-10.md`).
 * Rows `room.alarm.tasks`, `room.history.slots`, `room.history.value`,
 * `room.history.restore` and `room.history.undo` of
 * `docs/editor-delete-contract.md`:
 *
 * - two half-day slots per local date, in the room's time zone, closed by
 *   the alarm at local noon and midnight, by the first write past the
 *   boundary (the version holds the state before it), or at a wake;
 * - only a slot the room stored a change in is written; its key, value
 *   (the compressed live state), metadata and TTL;
 * - list, read, restore (a forward edit keeping ids, relayed: two clients
 *   converge) and the undo of a restore (edits since kept, after a wake
 *   too), also through `routeDocumentHistory`;
 * - a version past the value cap is skipped, logged `history`.
 */
import { env } from 'cloudflare:workers';
import {
	SELF,
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject
} from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
	fitMetadata,
	historyKey,
	parseHistoryKey,
	slotAt,
	slotEnd
} from '../../src/lib/cloudflare/history.js';
import type { JSONDoc } from '../../src/lib/crdt/index.js';
import { E, ORIGIN, RawClient, crdt, para, readFacade } from './client';
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
const at = (iso: string) => Date.parse(iso);

const stub = (room: string) => env.TIMED.getByName(room);
const inRoom = <T>(room: string, fn: (r: TimedRoom, state: DurableObjectState) => T) =>
	runInDurableObject(stub(room), (r: TimedRoom, state) => fn(r, state));
const clockTo = (room: string, iso: string) =>
	inRoom(room, (_r, state) => setNow(state.storage.sql, at(iso)));

/** Run the room's alarm (every task due at its time), then wait for its version writes. */
const fire = async (room: string) => {
	const ran = await runDurableObjectAlarm(stub(room));
	await inRoom(room, (r) => r.historyWritten());
	return ran;
};

type Stored = { key: string; ttl: number | null; metadata: string | null; bytes: number };
/** What the room's fake KV holds (expired rows too). */
const stored = (room: string) =>
	inRoom(room, (_r, state) =>
		state.storage.sql
			.exec<Stored>('SELECT key, ttl, metadata, length(value) AS bytes FROM fake_kv ORDER BY key')
			.toArray()
	);

const dues = (room: string) =>
	inRoom(room, (_r, state) =>
		Object.fromEntries(
			state.storage.sql
				.exec<{ key: string; value: number }>("SELECT key, value FROM meta WHERE key LIKE 'due.%'")
				.toArray()
				.map(({ key, value }) => [key, value])
		)
	);

const author = (
	actor: string,
	children = [para('p1', 'one'), para('p2', 'two'), para('p3', 'three')]
) =>
	E.createDocument({ value: { children }, actor: { id: actor }, history: { captureTimeout: 0 } });

/** A writer's tab: a seeded document dialing the room as `user`. */
const writer = async (room: string, user: string) => {
	const document = author(user);
	const client = await RawClient.connect(room, document.doc, {
		user,
		replica: document.doc.clientID
	});
	await vi.waitFor(() => expect(client.synced).toBe(true), SLOW);
	return { document, client };
};

/** The visible document as compared across replicas. */
const shape = (json: JSONDoc) => JSON.parse(JSON.stringify(json));

const roomJSON = (room: string) => inRoom(room, (r) => shape(r.read()));

describe('H11 · slots in a time zone', () => {
	it('am ends at local noon, pm at local midnight (UTC, Paris, New York, Kolkata)', () => {
		expect(slotAt(at('2026-10-06T11:59:59.999Z'), 'UTC')).toEqual({
			date: '2026-10-06',
			slot: 'am'
		});
		expect(slotEnd(at('2026-10-06T08:00:00Z'), 'UTC')).toBe(at('2026-10-06T12:00:00Z'));
		expect(slotAt(at('2026-10-06T12:00:00Z'), 'UTC').slot).toBe('pm');
		expect(slotEnd(at('2026-10-06T12:00:00Z'), 'UTC')).toBe(at('2026-10-07T00:00:00Z'));
		// Paris, summer time (UTC+2): 11:30 local is the morning, noon is 10:00Z.
		expect(slotAt(at('2026-10-06T09:30:00Z'), 'Europe/Paris')).toEqual({
			date: '2026-10-06',
			slot: 'am'
		});
		expect(slotEnd(at('2026-10-06T09:30:00Z'), 'Europe/Paris')).toBe(at('2026-10-06T10:00:00Z'));
		// 22:30Z is already the next local date in Paris.
		expect(slotAt(at('2026-10-06T22:30:00Z'), 'Europe/Paris')).toEqual({
			date: '2026-10-07',
			slot: 'am'
		});
		// New York (UTC-4): 03:00Z is the previous local evening.
		expect(slotAt(at('2026-10-06T03:00:00Z'), 'America/New_York')).toEqual({
			date: '2026-10-05',
			slot: 'pm'
		});
		expect(slotEnd(at('2026-10-06T03:00:00Z'), 'America/New_York')).toBe(
			at('2026-10-06T04:00:00Z')
		);
		// Kolkata (UTC+5:30): local noon is 06:30Z.
		expect(slotEnd(at('2026-10-06T06:29:00Z'), 'Asia/Kolkata')).toBe(at('2026-10-06T06:30:00Z'));
	});

	it('a daylight-saving day: the Paris morning of 2026-10-25 lasts 13 hours', () => {
		const start = at('2026-10-24T22:00:00Z'); // 00:00 CEST
		expect(slotAt(start, 'Europe/Paris')).toEqual({ date: '2026-10-25', slot: 'am' });
		expect(slotAt(start - 1, 'Europe/Paris')).toEqual({ date: '2026-10-24', slot: 'pm' });
		const end = slotEnd(start, 'Europe/Paris');
		expect(end).toBe(at('2026-10-25T11:00:00Z')); // 12:00 CET
		expect(end - start).toBe(13 * 3600_000);
	});

	it('keys name the room percent-encoded, and only its own keys parse', () => {
		const key = historyKey('a/b c', { date: '2026-10-06', slot: 'pm' });
		expect(key).toBe('history/a%2Fb%20c/2026-10-06-pm');
		expect(parseHistoryKey('a/b c', key)).toEqual({ date: '2026-10-06', slot: 'pm' });
		expect(parseHistoryKey('a', key)).toBeNull();
		expect(parseHistoryKey('a/b c', 'history/a%2Fb%20c/2026-10-06-xx')).toBeNull();
		expect(
			historyKey('x'.repeat(256).replaceAll('x', '\u{1F600}'), { date: '2026-10-06', slot: 'am' })
		).toBeNull();
	});

	it('metadata keeps under 1,024 bytes by dropping the last editors', () => {
		const editors = Array.from({ length: 40 }, (_, i) => `user-${i}-${'x'.repeat(30)}`);
		const meta = fitMetadata({ bytes: 1, blocks: 2, editors, at: 3 });
		expect(new TextEncoder().encode(JSON.stringify(meta)).length).toBeLessThanOrEqual(1024);
		expect(meta.editors).toEqual(editors.slice(0, meta.editors.length));
		expect(meta.more).toBe(editors.length - meta.editors.length);
	});
});

describe('H11 · two versions a day, only when changed', () => {
	it('the alarm writes the morning at local noon: key, value, editors, TTL; one alarm for every task', async () => {
		const room = 'timed-paris-noon';
		await clockTo(room, '2026-10-06T07:00:00Z'); // 09:00 in Paris
		const ada = await writer(room, 'ada');
		ada.document.transact(() => ada.document.facade.insertText('p1', 3, '!'));
		await vi.waitFor(
			async () => expect((await roomJSON(room)).children[0].content[0].text).toBe('one!'),
			SLOW
		);
		// One alarm, the earliest task: the slot's end (local noon), before the purge tick.
		const due = await dues(room);
		expect(due['due.history']).toBe(at('2026-10-06T10:00:00Z'));
		expect(due['due.purge']).toBe(at('2026-10-07T07:00:00Z'));
		expect(await inRoom(room, (_r, state) => state.storage.getAlarm())).toBe(
			at('2026-10-06T10:00:00Z')
		);
		await clockTo(room, '2026-10-06T10:00:00Z');
		expect(await fire(room)).toBe(true);
		const rows = await stored(room);
		expect(rows.map((row) => row.key)).toEqual([`history/${room}/2026-10-06-am`]);
		expect(rows[0].ttl).toBe(30 * 86_400);
		const metadata = JSON.parse(rows[0].metadata!);
		expect(metadata).toEqual({
			bytes: rows[0].bytes,
			blocks: 3,
			editors: ['ada'],
			at: at('2026-10-06T10:00:00Z')
		});
		// The value is the live state: it reads back as the document.
		const json = await inRoom(room, (r) => r.readHistory(`history/${room}/2026-10-06-am`));
		expect(json).toEqual(await roomJSON(room));
		// Nothing changed since: the evening writes nothing, and the alarm left is the purge tick.
		expect(await dues(room)).toEqual({ 'due.purge': at('2026-10-07T07:00:00Z') });
		await clockTo(room, '2026-10-07T07:00:00Z');
		await fire(room);
		expect((await stored(room)).map((row) => row.key)).toEqual([`history/${room}/2026-10-06-am`]);
		ada.client.close();
		ada.document.destroy();
	});

	it('the first write past the boundary closes the slot first: the version holds the state before it', async () => {
		const room = 'timed-utc-boundary';
		await clockTo(room, '2026-10-06T11:00:00Z');
		const ada = await writer(room, 'ada');
		await vi.waitFor(async () => expect((await roomJSON(room)).children).toHaveLength(3), SLOW);
		// Past noon, no alarm has run yet: Bob writes.
		await clockTo(room, '2026-10-06T12:30:00Z');
		const bob = await writer(room, 'bob');
		const b = E.attachDocument(bob.document.doc, { actor: { id: 'bob' } });
		b.transact(() => b.facade.insertText('p2', 0, 'bob: '));
		await vi.waitFor(
			async () => expect((await roomJSON(room)).children[1].content[0].text).toBe('bob: two'),
			SLOW
		);
		await inRoom(room, (r) => r.historyWritten());
		const morning = await inRoom(room, (r) => r.readHistory(`history/${room}/2026-10-06-am`));
		expect(morning!.children.map((block) => block.content?.[0])).toEqual([
			{ text: 'one' },
			{ text: 'two' },
			{ text: 'three' }
		]);
		const [row] = await stored(room);
		expect(JSON.parse(row.metadata!).editors).toEqual(['ada']);
		// The evening slot is open, with Bob as its editor.
		expect((await dues(room))['due.history']).toBe(at('2026-10-07T00:00:00Z'));
		await clockTo(room, '2026-10-07T00:00:00Z');
		await fire(room);
		const rows = await stored(room);
		expect(rows.map((r) => r.key)).toEqual([
			`history/${room}/2026-10-06-am`,
			`history/${room}/2026-10-06-pm`
		]);
		expect(JSON.parse(rows[1].metadata!).editors).toEqual(['bob']);
		for (const tab of [ada, bob]) {
			tab.client.close();
			tab.document.destroy();
		}
		b.destroy();
	});

	it('a room that slept through the boundary writes the slot at its wake', async () => {
		const room = 'timed-ny-wake';
		await clockTo(room, '2026-10-06T14:00:00Z'); // 10:00 in New York
		const ada = await writer(room, 'ada');
		await vi.waitFor(async () => expect((await roomJSON(room)).children).toHaveLength(3), SLOW);
		ada.client.close();
		await vi.waitFor(
			async () => expect(await inRoom(room, (r) => r.metrics().sockets)).toBe(0),
			SLOW
		);
		await evictDurableObject(stub(room));
		// The noon alarm never ran: the room wakes at 15:00 local (the fake
		// clock is stored in the room, so it is set, then the room sleeps again).
		await clockTo(room, '2026-10-06T19:00:00Z');
		await evictDurableObject(stub(room));
		await inRoom(room, (r) => r.historyWritten());
		const rows = await stored(room);
		expect(rows.map((row) => row.key)).toEqual([`history/${room}/2026-10-06-am`]);
		expect(JSON.parse(rows[0].metadata!).at).toBe(at('2026-10-06T19:00:00Z'));
		expect((await dues(room))['due.history']).toBeUndefined();
		ada.document.destroy();
	});

	it('versions expire after the retention (TTL)', async () => {
		const room = 'timed-utc-ttl';
		await clockTo(room, '2026-10-06T08:00:00Z');
		const ada = await writer(room, 'ada');
		await vi.waitFor(async () => expect((await roomJSON(room)).children).toHaveLength(3), SLOW);
		await clockTo(room, '2026-10-06T12:00:00Z');
		await fire(room);
		expect(await inRoom(room, (r) => r.listHistory())).toHaveLength(1);
		await clockTo(room, '2026-11-05T11:59:00Z'); // 29 days, 23:59 later
		expect(await inRoom(room, (r) => r.listHistory())).toHaveLength(1);
		await clockTo(room, '2026-11-05T12:01:00Z');
		expect(await inRoom(room, (r) => r.listHistory())).toEqual([]);
		expect(await inRoom(room, (r) => r.readHistory(`history/${room}/2026-10-06-am`))).toBeNull();
		ada.client.close();
		ada.document.destroy();
	});

	it('a version past the value cap is skipped, logged `history`; a KV failure too', async () => {
		const room = 'timed-cap-utc';
		await clockTo(room, '2026-10-06T08:00:00Z');
		const ada = await writer(room, 'ada');
		// Text gzip cannot shrink below the 600-byte cap (a pseudo-random sequence).
		let text = '';
		for (let i = 0, x = 12345; i < 1500; i++) {
			x = (Math.imul(x, 1103515245) + 12345) >>> 0;
			text += String.fromCharCode(33 + ((x >>> 16) % 90));
		}
		ada.document.transact(() => ada.document.facade.insertText('p1', 0, text));
		await vi.waitFor(
			async () => expect((await roomJSON(room)).children[0].content[0].text).toContain(text),
			SLOW
		);
		await clockTo(room, '2026-10-06T12:00:00Z');
		await fire(room);
		expect(await stored(room)).toEqual([]);
		const { refusals, metrics } = await inRoom(room, (r) => ({
			refusals: r.refusals.filter((x) => x.reason === 'history'),
			metrics: r.metrics().history
		}));
		expect(refusals).toEqual([
			{
				reason: 'history',
				detail: {
					key: `history/${room}/2026-10-06-am`,
					bytes: expect.any(Number),
					limit: 600
				}
			}
		]);
		expect((refusals[0].detail as { bytes: number }).bytes).toBeGreaterThan(600);
		expect(metrics).toEqual({ written: 0, skipped: 1, lastKey: null });
		ada.client.close();
		ada.document.destroy();
	});

	it('a KV write that fails is skipped and noted; the next slot writes', async () => {
		const room = 'timed-utc-kvfail';
		await clockTo(room, '2026-10-06T08:00:00Z');
		const ada = await writer(room, 'ada');
		await vi.waitFor(async () => expect((await roomJSON(room)).children).toHaveLength(3), SLOW);
		await inRoom(room, (_r, state) =>
			state.storage.sql.exec('INSERT INTO fake_kv_fail VALUES (1)')
		);
		await clockTo(room, '2026-10-06T12:00:00Z');
		await fire(room);
		expect(await stored(room)).toEqual([]);
		expect(await inRoom(room, (r) => r.refusals.some((x) => x.reason === 'history'))).toBe(true);
		ada.document.transact(() => ada.document.facade.insertText('p1', 0, 'x'));
		await vi.waitFor(
			async () => expect((await roomJSON(room)).children[0].content[0].text).toBe('xone'),
			SLOW
		);
		await clockTo(room, '2026-10-07T00:00:00Z');
		await fire(room);
		expect((await stored(room)).map((row) => row.key)).toEqual([`history/${room}/2026-10-06-pm`]);
		ada.client.close();
		ada.document.destroy();
	});

	it('an unknown time zone keeps no history (noted), and the room works', async () => {
		const room = 'timed-badzone-a';
		await clockTo(room, '2026-10-06T08:00:00Z');
		const ada = await writer(room, 'ada');
		await vi.waitFor(async () => expect((await roomJSON(room)).children).toHaveLength(3), SLOW);
		expect((await dues(room))['due.history']).toBeUndefined();
		expect(
			await inRoom(room, (r) => r.refusals.find((x) => x.reason === 'history')?.detail)
		).toEqual({ timeZone: 'Mars/Olympus_Mons' });
		await expect(inRoom(room, (r) => r.listHistory())).rejects.toThrow(/no history/);
		ada.client.close();
		ada.document.destroy();
	});
});

/** A morning version of three paragraphs, then an afternoon of edits by Ada and Bob. */
const afternoon = async (room: string) => {
	await clockTo(room, '2026-10-06T08:00:00Z');
	const ada = await writer(room, 'ada');
	await clockTo(room, '2026-10-06T12:00:00Z');
	await vi.waitFor(async () => expect((await roomJSON(room)).children).toHaveLength(3), SLOW);
	await fire(room);
	const key = `history/${room}/2026-10-06-am`;
	const morning = (await inRoom(room, (r) => r.readHistory(key)))!;
	await clockTo(room, '2026-10-06T13:00:00Z');
	const bob = { doc: crdt.createDoc() };
	const bobClient = await RawClient.connect(room, bob.doc, {
		user: 'bob',
		replica: bob.doc.clientID
	});
	await vi.waitFor(() => expect(bobClient.json().children).toHaveLength(3), SLOW);
	const b = E.attachDocument(bob.doc, { actor: { id: 'bob' } });
	const f = ada.document.facade;
	ada.document.transact(() => {
		f.insertText('p1', 0, 'ONE ');
		f.deleteBlocks(['p2']);
		f.insertBlocks({ parent: null, index: 2 }, [
			{ id: 'p4', type: 'paragraph', content: [{ kind: 'text', text: 'four' }] }
		]);
		f.setBlockData('p1', { color: 'red' });
	});
	b.transact(() => {
		b.facade.insertText('p3', 5, ' and more');
		b.facade.moveBlocks(['p3'], { parent: null, index: 0 });
	});
	await vi.waitFor(async () => {
		const json = await roomJSON(room);
		expect(json).toEqual(shape(ada.document.facade.toJSON()));
		expect(json).toEqual(shape(bobClient.json()));
		expect(json.children.map((block: { id: string }) => block.id)).toEqual(['p3', 'p1', 'p4']);
	}, SLOW);
	return { ada, bob: b, bobClient, key, morning };
};

const converged = async (
	room: string,
	ada: { document: { facade: { toJSON(): JSONDoc } } },
	bobClient: RawClient
) => {
	await vi.waitFor(async () => {
		const json = await roomJSON(room);
		expect(shape(ada.document.facade.toJSON())).toEqual(json);
		expect(shape(bobClient.json())).toEqual(json);
	}, SLOW);
	return roomJSON(room);
};

describe('H11 · list, read, restore, undo', () => {
	it('a restore makes the document equal the version, keeping ids; both clients converge; its undo returns', async () => {
		const room = 'timed-utc-restore';
		const { ada, bob, bobClient, key, morning } = await afternoon(room);
		const before = await roomJSON(room);
		const listed = await inRoom(room, (r) => r.listHistory());
		expect(listed).toEqual([
			{
				key,
				date: '2026-10-06',
				slot: 'am',
				bytes: expect.any(Number),
				blocks: 3,
				editors: ['ada'],
				more: 0,
				at: at('2026-10-06T12:00:00Z')
			}
		]);
		await clockTo(room, '2026-10-06T14:00:00Z');
		const result = await inRoom(room, (r) => r.restoreHistory(key, { user: 'carol' }));
		expect(result).toMatchObject({ status: 'applied', key, revived: 1, created: 0, deleted: 1 });
		const restored = await converged(room, ada, bobClient);
		expect(restored).toEqual(shape(morning));
		// Ids are kept: p2 is the same block, revived; p3 kept the text it had in the morning.
		expect(restored.children.map((block: { id: string }) => block.id)).toEqual(['p1', 'p2', 'p3']);
		const undone = await inRoom(room, (r) => r.undoRestore({ user: 'carol' }));
		expect(undone).toEqual({ status: 'applied' });
		expect(await converged(room, ada, bobClient)).toEqual(before);
		// One level: nothing left to undo.
		expect(await inRoom(room, (r) => r.undoRestore())).toEqual({ status: 'noop' });
		// The restorer is the slot's editor.
		await clockTo(room, '2026-10-07T00:00:00Z');
		await fire(room);
		const pm = (await inRoom(room, (r) => r.listHistory())).find((v) => v.slot === 'pm')!;
		expect([...pm.editors].sort()).toEqual(['ada', 'bob', 'carol']);
		bobClient.close();
		ada.client.close();
		ada.document.destroy();
		bob.destroy();
	});

	it('the undo of a restore keeps the edits made since, and works after a wake', async () => {
		const room = 'timed-utc-undo-wake';
		const { ada, bob, bobClient, key } = await afternoon(room);
		const before = await roomJSON(room);
		await inRoom(room, (r) => r.restoreHistory(key, { user: 'ada' }));
		await converged(room, ada, bobClient);
		// Bob types into the restored first paragraph.
		bob.transact(() => bob.facade.insertText('p1', 0, '>'));
		await converged(room, ada, bobClient);
		await evictDurableObject(stub(room));
		expect(await inRoom(room, (r) => r.undoRestore())).toEqual({ status: 'applied' });
		const after = await converged(room, ada, bobClient);
		const text = (json: JSONDoc, id: string) =>
			json.children
				.find((block) => block.id === id)
				?.content?.map((c) => ('text' in c ? c.text : ''))
				.join('');
		expect(after.children.map((block: { id: string }) => block.id)).toEqual(
			before.children.map((block: { id: string }) => block.id)
		);
		// Bob's '>' stays (where the engine orders it beside the restored text).
		expect(text(after, 'p1')).toContain('>');
		expect(text(after, 'p1')!.replace('>', '')).toBe(text(before, 'p1'));
		expect(text(after, 'p3')).toBe(text(before, 'p3'));
		bobClient.close();
		ada.client.close();
		ada.document.destroy();
		bob.destroy();
	});

	it('a restore of the current state writes nothing; a key of another room or an expired one is refused', async () => {
		const room = 'timed-utc-noop';
		await clockTo(room, '2026-10-06T08:00:00Z');
		const ada = await writer(room, 'ada');
		await vi.waitFor(async () => expect((await roomJSON(room)).children).toHaveLength(3), SLOW);
		await clockTo(room, '2026-10-06T12:00:00Z');
		await fire(room);
		const key = `history/${room}/2026-10-06-am`;
		const records = await inRoom(room, (r) => r.records().length);
		expect(await inRoom(room, (r) => r.restoreHistory(key))).toMatchObject({ status: 'noop' });
		expect(await inRoom(room, (r) => r.records().length)).toBe(records);
		expect(await inRoom(room, (r) => r.restoreHistory(`history/other/2026-10-06-am`))).toEqual({
			status: 'refused',
			key: 'history/other/2026-10-06-am'
		});
		expect(await inRoom(room, (r) => r.restoreHistory(`history/${room}/2026-10-05-am`))).toEqual({
			status: 'refused',
			key: `history/${room}/2026-10-05-am`
		});
		ada.client.close();
		ada.document.destroy();
	});

	it('routeDocumentHistory: list, read, restore and undo, authorized like a dial', async () => {
		const room = 'timed-utc-http';
		const { ada, bob, bobClient, key, morning } = await afternoon(room);
		const url = (query: string) => `${ORIGIN}/history/${encodeURIComponent(room)}?${query}`;
		const listed = await SELF.fetch(url('user=ada'));
		expect(listed.status).toBe(200);
		expect(((await listed.json()) as Array<{ key: string }>).map((v) => v.key)).toEqual([key]);
		const read = await SELF.fetch(url(`user=ada&key=${encodeURIComponent(key)}`));
		expect(await read.json()).toEqual(shape(morning));
		expect((await SELF.fetch(url('user=ada&key=nope'))).status).toBe(404);
		// A read-only identity reads, never restores.
		expect((await SELF.fetch(url('user=viewer&access=read'))).status).toBe(200);
		expect(
			(
				await SELF.fetch(url(`user=viewer&access=read&restore=${encodeURIComponent(key)}`), {
					method: 'POST'
				})
			).status
		).toBe(403);
		expect((await SELF.fetch(url('user=denied'))).status).toBe(403);
		expect((await SELF.fetch(url('user=expired'))).status).toBe(401);
		expect((await SELF.fetch(url('user=ada'), { method: 'PUT' })).status).toBe(405);
		const restored = await SELF.fetch(url(`user=ada&restore=${encodeURIComponent(key)}`), {
			method: 'POST'
		});
		expect(restored.status).toBe(200);
		expect(await restored.json()).toMatchObject({ status: 'applied', key });
		expect(await converged(room, ada, bobClient)).toEqual(shape(morning));
		const undone = await SELF.fetch(url('user=ada&undo'), { method: 'POST' });
		expect(await undone.json()).toEqual({ status: 'applied' });
		// A room without history answers 404.
		expect((await SELF.fetch(`${ORIGIN}/history/plain-room?user=ada`)).status).toBe(404);
		bobClient.close();
		ada.client.close();
		ada.document.destroy();
		bob.destroy();
	});
});

describe('H11 · a restore keeps the room readable from storage', () => {
	it('a reload after a restore and its undo holds the live state', async () => {
		const room = 'timed-utc-reload';
		const { ada, bob, bobClient, key } = await afternoon(room);
		await inRoom(room, (r) => r.restoreHistory(key));
		const restored = await converged(room, ada, bobClient);
		bobClient.close();
		ada.client.close();
		await evictDurableObject(stub(room));
		expect(await roomJSON(room)).toEqual(restored);
		const fresh = await RawClient.connect(room, crdt.createDoc(), { user: 'zoe' });
		await vi.waitFor(() => expect(shape(fresh.json())).toEqual(restored), SLOW);
		fresh.close();
		ada.document.destroy();
		bob.destroy();
		void readFacade;
	});
});
