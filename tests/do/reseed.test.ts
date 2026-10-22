/**
 * The room's re-seed (`room.reseed.*` in `docs/editor-delete-contract.md`),
 * in workerd with the room's clock moved (`reseed-*` rooms: an 8,000-byte
 * quota, a re-seed due past 2,000 stored bytes after a minute idle):
 *
 * - a re-seed rebuilds the document from its content as the next epoch,
 *   stores less, keeps every block's attribution, and closes every socket
 *   `4410` with the epoch; a client of the new epoch syncs it;
 * - the door: a dial naming no epoch, or a later one, is refused `1008`; an
 *   epoch past the cuts kept is closed `4411`;
 * - an offline writer that dials its old epoch is told the room's, hands
 *   over its old document and is closed `4410`: its unsaved edits are in
 *   the document, written as its user; a second upload of them (another
 *   tab) merges nothing; a reader dialing an old epoch is closed at once;
 * - the timing: due once nobody wrote for the idle time (each write pushes
 *   it back), skipped when it would give back too little, at once past 80 %
 *   of the quota.
 */
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { CLOSE } from '../../src/lib/crdt/providers/room.js';
import type { JSONDoc } from '../../src/lib/crdt/index.js';
import { E, ORIGIN, RawClient, SelfWebSocket, Y, crdt, para } from './client';
import { setNow, type ReseedRoom } from './worker';

declare global {
	namespace Cloudflare {
		interface Env {
			RESEED: DurableObjectNamespace<ReseedRoom>;
		}
	}
}

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-22T08:00:00Z');

const stub = (room: string) => env.RESEED.getByName(room);
const inRoom = <T>(room: string, fn: (r: ReseedRoom, state: DurableObjectState) => T) =>
	runInDurableObject(stub(room), (r: ReseedRoom, state) => fn(r, state));
const clockTo = (room: string, at: number) =>
	inRoom(room, (_r, state) => setNow(state.storage.sql, at));
const roomJSON = (room: string) =>
	inRoom(room, (r) => JSON.parse(JSON.stringify(r.read())) as JSONDoc);
const texts = (json: JSONDoc) =>
	Object.fromEntries(
		json.children.map((b) => [
			b.id,
			(b.content ?? []).map((c) => ('text' in c ? c.text : '')).join('')
		])
	);

/** A writer's tab: a document seeded with `children` (or the room's), dialing `room` as `user` at `epoch`. */
const writer = async (
	room: string,
	user: string,
	children: JSONDoc['children'] | null,
	epoch = 0
) => {
	const document = E.createDocument({
		...(children && { value: { children } }),
		actor: { id: user },
		history: { captureTimeout: 0 }
	});
	if (!children) document.sync();
	const client = await RawClient.connect(room, document.doc, {
		user,
		replica: document.doc.clientID,
		epoch
	});
	return { document, client };
};

/** Churn: `n` times, a word typed then deleted but its first character, in `id`, each its own update. */
const churn = (
	document: ReturnType<typeof E.createDocument>,
	id: string,
	n: number,
	word = 'word'
) => {
	for (let i = 0; i < n; i++) {
		const typed = `${word}${i} `;
		document.facade.insertText(id, 0, typed);
		document.facade.deleteText(id, 1, typed.length - 1);
	}
};

describe('a re-seed (room.reseed.cut)', () => {
	it('rebuilds the document from its content as the next epoch, and closes every socket 4410', async () => {
		const room = 'reseed-cut';
		await clockTo(room, T0);
		const { document, client } = await writer(room, 'ana', [
			para('p1', 'hello'),
			para('p2', 'world')
		]);
		churn(document, 'p1', 40);
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		const before = await roomJSON(room);
		const bytes = await inRoom(room, (r) => r.metrics().documentBytes);
		const attribution = document.facade.blockAttribution('p1');
		expect(await inRoom(room, (r) => r.reseed())).toBe(1);
		await vi.waitFor(() => expect(client.closed).toEqual({ code: CLOSE.reseeded, reason: '1' }));
		expect(await roomJSON(room)).toEqual(before);
		const after = await inRoom(room, (r) => r.metrics());
		expect(after.epoch).toBe(1);
		expect(after.documentBytes).toBeLessThan(bytes / 2);
		// A client of the new epoch syncs it, the blocks' attribution kept.
		const fresh = await RawClient.connect(room, E.createDocument({ actor: { id: 'bob' } }).doc, {
			user: 'bob',
			epoch: 1
		});
		await vi.waitFor(() => expect(fresh.synced).toBe(true));
		expect(fresh.json()).toEqual(before);
		const synced = E.createDocument({ actor: { id: 'bob' } });
		Y.applyUpdate(synced.doc, Y.encodeStateAsUpdate(fresh.doc));
		synced.sync();
		expect(synced.facade.blockAttribution('p1')).toEqual(attribution);
		fresh.close();
	});

	it('the door: no epoch or a later one is refused 1008', async () => {
		const room = 'reseed-door';
		await clockTo(room, T0);
		const { client } = await writer(room, 'ana', [para('p1', 'hello')]);
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		// A room that never re-seeded takes a dial that names no epoch (a client before 7.0).
		const old = await RawClient.connect(room, E.createDocument({ actor: { id: 'cy' } }).doc, {
			user: 'cy'
		});
		await vi.waitFor(() => expect(old.synced).toBe(true));
		await inRoom(room, (r) => r.reseed());
		for (const dial of [{ user: 'cy' }, { user: 'cy', epoch: 2 }]) {
			const refused = await RawClient.connect(
				room,
				E.createDocument({ actor: { id: 'cy' } }).doc,
				dial
			);
			await vi.waitFor(() => expect(refused.closed?.code).toBe(CLOSE.refused));
			expect(refused.closed?.reason).toBe('refused: epoch');
		}
	});
});

describe('only the room writes the epoch (room.reseed.protocol)', () => {
	it("a client's write of the epoch root is stripped (`mark`)", async () => {
		const room = 'reseed-forge';
		await clockTo(room, T0);
		const { client } = await writer(room, 'ana', [para('p1', 'hello')]);
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		await inRoom(room, (r) => r.reseed());
		const mallory = E.createDocument({ actor: { id: 'mal' } }).doc;
		const tab = await RawClient.connect(room, mallory, { user: 'mal', epoch: 1 });
		await vi.waitFor(() => expect(tab.synced).toBe(true));
		mallory.get('epoch').setAttr('n', 99);
		await vi.waitFor(async () =>
			expect(await inRoom(room, (r) => r.refusals.some((x) => x.reason === 'mark'))).toBe(true)
		);
		expect(await inRoom(room, (r) => r.doc!.get('epoch').getAttr('n'))).toBe(1);
		tab.close();
	});
});

describe('an offline client after a re-seed (room.reseed.rebase)', () => {
	it('hands over its old document: its unsaved edits are written as its user, then it reloads', async () => {
		const room = 'reseed-rebase';
		await clockTo(room, T0);
		// Two tabs seed the same value deterministically: one document.
		const seed = () => [para('p1', 'the quick fox'), para('p2', 'second')];
		const ana = await writer(room, 'ana', seed());
		await vi.waitFor(() => expect(ana.client.stored()).toBe(true));
		ana.client.close();
		// Offline: ana types; online: bob edits the same block, then the room re-seeds.
		ana.document.facade.insertText('p1', 4, 'very ');
		ana.document.facade.insertText('p2', 6, ' line');
		const bob = await writer(room, 'bob', seed());
		await vi.waitFor(() => expect(bob.client.synced).toBe(true));
		bob.document.facade.insertText('p1', 13, ' jumps');
		await vi.waitFor(() => expect(bob.client.stored()).toBe(true));
		await inRoom(room, (r) => r.reseed());
		// Back online at its old epoch: told the room's, it uploads, and is closed 4410.
		const back = await RawClient.connect(room, ana.document.doc, {
			user: 'ana',
			replica: ana.document.doc.clientID,
			epoch: 0
		});
		await vi.waitFor(() => expect(back.epoch).toBe(1));
		expect(back.step1s).toBe(0);
		back.rebase();
		await vi.waitFor(() => expect(back.closed).toEqual({ code: CLOSE.reseeded, reason: '1' }));
		expect(texts(await roomJSON(room))).toEqual({
			p1: 'the very quick fox jumps',
			p2: 'second line'
		});
		expect(await inRoom(room, (r) => r.facade.blockAttribution('p2')?.lastChangedBy)).toBe('ana');
		// Another tab of hers hands the same document over: nothing merges twice.
		const tab = await RawClient.connect(room, ana.document.doc, { user: 'ana', epoch: 0 });
		await vi.waitFor(() => expect(tab.epoch).toBe(1));
		tab.rebase();
		await vi.waitFor(() => expect(tab.closed?.code).toBe(CLOSE.reseeded));
		expect(texts(await roomJSON(room))).toEqual({
			p1: 'the very quick fox jumps',
			p2: 'second line'
		});
		const rebases = await inRoom(room, (r) => r.logged.filter((e) => e.edytor === 'rebase'));
		expect(rebases.map((e) => (e as { status: string }).status)).toEqual(['applied', 'noop']);
	});

	it('a reader dialing an old epoch has nothing to merge: closed 4410 at once', async () => {
		const room = 'reseed-reader';
		await clockTo(room, T0);
		const { client } = await writer(room, 'ana', [para('p1', 'hello')]);
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		await inRoom(room, (r) => r.reseed());
		const reader = await RawClient.connect(room, E.createDocument({ actor: { id: 'rui' } }).doc, {
			user: 'rui',
			access: 'read',
			epoch: 0
		});
		await vi.waitFor(() => expect(reader.closed).toEqual({ code: CLOSE.reseeded, reason: '1' }));
		expect(reader.epoch).toBe(null);
	});

	it('an epoch past the cuts kept is closed 4411 (room.reseed.grace)', async () => {
		const room = 'reseed-grace';
		await clockTo(room, T0);
		const { client } = await writer(room, 'ana', [para('p1', 'hello')]);
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		await inRoom(room, (r) => r.reseed());
		await clockTo(room, T0 + 31 * DAY);
		const late = await RawClient.connect(room, E.createDocument({ actor: { id: 'ana' } }).doc, {
			user: 'ana',
			epoch: 0
		});
		await vi.waitFor(() =>
			expect(late.closed).toEqual({ code: CLOSE.epochExpired, reason: 'epoch expired' })
		);
	});
});

describe('when the room re-seeds (room.reseed.timing)', () => {
	it('past the threshold, once nobody wrote for the idle time: each write pushes it back', async () => {
		const room = 'reseed-idle';
		await clockTo(room, T0);
		const { document, client } = await writer(room, 'ana', [para('p1', 'hello')]);
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		churn(document, 'p1', 120);
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		expect(await inRoom(room, (r) => r.metrics().documentBytes)).toBeGreaterThan(2000);
		// Thirty seconds later a write: the re-seed waits a minute from it.
		await clockTo(room, T0 + 30_000);
		document.facade.insertText('p1', 0, '!');
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		// Due a minute after the last write (the alarm the room asked for).
		expect(await inRoom(room, (_r, state) => state.storage.getAlarm())).toBe(T0 + 90_000);
		await clockTo(room, T0 + 90_000);
		await runDurableObjectAlarm(stub(room));
		expect(await inRoom(room, (r) => r.metrics().epoch)).toBe(1);
		await vi.waitFor(() => expect(client.closed?.code).toBe(CLOSE.reseeded));
	});

	it('skipped when it would give back too little', async () => {
		const room = 'reseed-gain';
		await clockTo(room, T0);
		// One long text typed once: a fresh seed weighs about as much.
		const long = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
		const { client } = await writer(room, 'ana', [para('p1', long)]);
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		await clockTo(room, T0 + 61_000);
		await runDurableObjectAlarm(stub(room));
		expect(await inRoom(room, (r) => r.metrics().epoch)).toBe(0);
		expect(await inRoom(room, (r) => r.logged.filter((e) => e.edytor === 'reseed'))).toEqual([
			expect.objectContaining({ skipped: 'gain' })
		]);
	});

	it('at once past 80 % of the quota', async () => {
		const room = 'reseed-force';
		await clockTo(room, T0);
		const { document, client } = await writer(room, 'ana', [para('p1', 'hello')]);
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		// Up to past 6,400 bytes, under the quota (the alarm would fire at once).
		const bytes = () => inRoom(room, (r) => r.metrics().documentBytes);
		while ((await bytes()) <= 6_400) {
			churn(document, 'p1', 10, 'a longer word to type '.repeat(2));
			await vi.waitFor(() => expect(client.stored()).toBe(true));
		}
		expect(await inRoom(room, (_r, state) => state.storage.getAlarm())).toBeLessThanOrEqual(T0);
		await runDurableObjectAlarm(stub(room));
		expect(await inRoom(room, (r) => r.metrics().epoch)).toBe(1);
	});

	it('never when it is off', async () => {
		const room = 'reseed-off-room';
		await clockTo(room, T0);
		const { document, client } = await writer(room, 'ana', [para('p1', 'hello')]);
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		churn(document, 'p1', 60);
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		await clockTo(room, T0 + 61_000);
		await runDurableObjectAlarm(stub(room));
		expect(await inRoom(room, (r) => [r.metrics().epoch, r.reseed()])).toEqual([0, null]);
	});
});

describe('the shipped client after a re-seed (room.reseed.protocol)', () => {
	const url = `${ORIGIN.replace('https', 'wss')}/rooms`;
	/** The shipped provider over `SELF`, for `user`. */
	const provider = (room: string, doc: E.YDoc, user: string, connect = true) =>
		new crdt.providers.WebsocketProvider(url, room, doc, {
			params: { user },
			WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
			disableBc: true,
			connect
		});
	const refusals = (p: ReturnType<typeof provider>) => {
		const heard: { code: number; reason: string }[] = [];
		p.on('refused', ({ code, reason }) => heard.push({ code, reason }));
		return heard;
	};

	it('with nothing unsaved, hears the re-seed as a 4410 refusal; a new document syncs the new epoch', async () => {
		const room = 'reseed-client-saved';
		await clockTo(room, T0);
		const a = E.createDocument({
			value: { children: [para('p1', 'hello')] },
			actor: { id: 'ana' }
		});
		const pa = provider(room, a.doc, 'ana');
		const heard = refusals(pa);
		await vi.waitFor(() => expect(pa.synced && pa.saved).toBe(true));
		await inRoom(room, (r) => r.reseed());
		await vi.waitFor(() => expect(heard).toEqual([{ code: CLOSE.reseeded, reason: '1' }]));
		// A new document holds nothing: it dials as new, and syncs the epoch's document.
		const b = E.createDocument({ actor: { id: 'ana' } });
		const pb = provider(room, b.doc, 'ana');
		await vi.waitFor(() => expect(pb.synced).toBe(true));
		b.sync();
		expect(b.facade.blockText('p1')).toBe('hello');
		pa.destroy();
		pb.destroy();
	});

	it('back online with unsaved edits, hands them over, then hears 4410', async () => {
		const room = 'reseed-client-offline';
		await clockTo(room, T0);
		const a = E.createDocument({
			value: { children: [para('p1', 'hello')] },
			actor: { id: 'ana' }
		});
		const pa = provider(room, a.doc, 'ana');
		const heard = refusals(pa);
		await vi.waitFor(() => expect(pa.synced && pa.saved).toBe(true));
		pa.disconnect();
		a.facade.insertText('p1', 5, ' offline');
		await inRoom(room, (r) => r.reseed());
		pa.connect();
		await vi.waitFor(() => expect(heard).toEqual([{ code: CLOSE.reseeded, reason: '1' }]));
		expect(texts(await roomJSON(room))).toEqual({ p1: 'hello offline' });
		pa.destroy();
	});

	it('an edit the room had not acknowledged when it re-seeded: the provider redials and hands it over', async () => {
		const room = 'reseed-client-inflight';
		await clockTo(room, T0);
		const a = E.createDocument({
			value: { children: [para('p1', 'hello')] },
			actor: { id: 'ana' }
		});
		const pa = provider(room, a.doc, 'ana');
		const heard = refusals(pa);
		await vi.waitFor(() => expect(pa.synced && pa.saved).toBe(true));
		a.facade.insertText('p1', 5, ' typed');
		expect(pa.unsaved).toBeGreaterThan(0);
		await inRoom(room, (r) => r.reseed());
		await vi.waitFor(() => expect(heard).toEqual([{ code: CLOSE.reseeded, reason: '1' }]));
		expect(texts(await roomJSON(room))).toEqual({ p1: 'hello typed' });
		pa.destroy();
	});
});
