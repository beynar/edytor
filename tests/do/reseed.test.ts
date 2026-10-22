/**
 * The room's re-seed (`room.reseed.*` in `docs/editor-delete-contract.md`),
 * in workerd with the room's clock moved (`reseed-*` rooms: an 8,000-byte
 * quota, a re-seed due past 2,000 stored bytes after a minute idle):
 *
 * - a re-seed rebuilds the document from its content as the next epoch,
 *   stores less, keeps every block's attribution, and closes every socket
 *   `4410` with the epoch; a client of the new epoch syncs it;
 * - the door: a dial naming no epoch is refused `1008`; one the room
 *   cannot rebase (past the cuts kept, or later than its own) is closed
 *   `4410`;
 * - an offline writer that dials its old epoch is told the room's, hands
 *   over its old document and is closed `4410`: its unsaved edits are in
 *   the document, written as its user; a second upload of them (another
 *   tab) merges nothing; a reader dialing an old epoch is closed at once;
 * - a hand-over is admitted as its user's update: past the quota it is
 *   refused `4413`, from a socket downgraded to read it writes nothing; one
 *   that cannot be read is dropped (`4410`); one user's upload never claims
 *   another's edits; nothing is relayed to a stale socket, and a current
 *   socket that sends an older epoch's content is closed `4410`;
 * - the timing: due once nobody wrote for the idle time (each write pushes
 *   it back), skipped when it would give back too little, at once past 80 %
 *   of the quota, but not under the floor a skipped run left.
 */
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { CLOSE } from '../../src/lib/crdt/providers/room.js';
import type { JSONDoc } from '../../src/lib/crdt/index.js';
import { E, ORIGIN, RawClient, SelfWebSocket, Y, crdt, para } from './client';
import * as encoding from 'lib0-v14/encoding';
// @ts-ignore -- untyped JS module; typed through the engine's declarations below
import { UpdateEncoder as RawEncoder } from '../../src/lib/crdt/vendor/yjs/src/index.js';
import type { UpdateEncoder as Encoder } from '../../src/lib/crdt/vendor/yjs/dts/index.js';

/** The engine's update encoder: a forged struct, written by hand. */
const UpdateEncoder = RawEncoder as typeof Encoder;
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

	it('the door: no epoch is refused 1008, a later one closed 4410', async () => {
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
		const none = await RawClient.connect(room, E.createDocument({ actor: { id: 'cy' } }).doc, {
			user: 'cy'
		});
		await vi.waitFor(() =>
			expect(none.closed).toEqual({ code: CLOSE.refused, reason: 'refused: epoch' })
		);
		// A later epoch: the room lost it (a backup restored); the copy is dropped for the room's.
		const later = await RawClient.connect(room, E.createDocument({ actor: { id: 'cy' } }).doc, {
			user: 'cy',
			epoch: 2
		});
		await vi.waitFor(() => expect(later.closed).toEqual({ code: CLOSE.reseeded, reason: '1' }));
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
		// Another tab of hers hands the same document over (once her rebase rate allows): nothing merges twice.
		await clockTo(room, T0 + 10_000);
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

	it('an epoch past the cuts kept is closed 4410 (room.reseed.grace)', async () => {
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
		await vi.waitFor(() => expect(late.closed).toEqual({ code: CLOSE.reseeded, reason: '1' }));
	});
});

/** A writer's tab, offline since it stored its seed, and a re-seed meanwhile: its document and the room's epoch. */
const offlineAcrossReseed = async (room: string, user = 'ana') => {
	await clockTo(room, T0);
	const tab = await writer(room, user, [para('p1', 'hello')]);
	await vi.waitFor(() => expect(tab.client.stored()).toBe(true));
	tab.client.close();
	await inRoom(room, (r) => r.reseed());
	return tab.document;
};
/** `document` back at epoch 0 as `user`: told the room's epoch. */
const stale = async (room: string, document: { doc: E.YDoc }, user = 'ana') => {
	const client = await RawClient.connect(room, document.doc, { user, epoch: 0 });
	await vi.waitFor(() => expect(client.epoch).toBe(1));
	return client;
};
const rebases = (room: string) =>
	inRoom(room, (r) =>
		r.logged.filter((e) => e.edytor === 'rebase').map((e) => (e as { status: string }).status)
	);

describe('a hand-over goes through the admission (room.reseed.rebase)', () => {
	it('past the document quota it is refused 4413, and writes nothing', async () => {
		const room = 'reseed-quota';
		const document = await offlineAcrossReseed(room);
		document.facade.insertText('p1', 5, ' ' + 'x'.repeat(20_000));
		const before = await roomJSON(room);
		const back = await stale(room, document);
		back.rebase();
		await vi.waitFor(() =>
			expect(back.closed).toEqual({ code: CLOSE.quota, reason: 'quota: document' })
		);
		expect(await roomJSON(room)).toEqual(before);
		expect(await rebases(room)).toEqual(['refused']);
	});

	it('from a socket downgraded to read after it joined, it writes nothing', async () => {
		const room = 'reseed-downgraded';
		const document = await offlineAcrossReseed(room);
		document.facade.insertText('p1', 5, ' offline');
		const back = await stale(room, document);
		await inRoom(room, (r) => r.setAccess('ana', 'read'));
		back.rebase();
		await vi.waitFor(() => expect(back.closed?.code).toBe(CLOSE.reseeded));
		expect(texts(await roomJSON(room))).toEqual({ p1: 'hello' });
		expect(await rebases(room)).toEqual(['refused']);
	});

	it('one that cannot be read is dropped: closed 4410, never a fault the provider redials', async () => {
		const room = 'reseed-garbage';
		const document = await offlineAcrossReseed(room);
		const back = await stale(room, document);
		back.rebase(new Uint8Array([0, 1, 2, 3, 250, 251]));
		await vi.waitFor(() => expect(back.closed).toEqual({ code: CLOSE.reseeded, reason: '1' }));
		expect(await rebases(room)).toEqual(['failed']);
	});

	it("past its user's rebase rate, a stale dial is closed 1011 before it uploads anything", async () => {
		const room = 'reseed-rate';
		const ana = await offlineAcrossReseed(room);
		ana.facade.insertText('p1', 5, ' one');
		const first = await stale(room, ana);
		first.rebase();
		await vi.waitFor(() => expect(first.closed?.code).toBe(CLOSE.reseeded));
		// Another tab of hers, with an edit of its own, at once: not asked for its document yet.
		ana.facade.insertText('p1', 0, '>');
		const second = await RawClient.connect(room, ana.doc, { user: 'ana', epoch: 0 });
		await vi.waitFor(() =>
			expect(second.closed).toEqual({ code: CLOSE.fault, reason: 'rebase: rate' })
		);
		expect(second.epoch).toBe(null);
		// Ten seconds later it is.
		await clockTo(room, T0 + 10_000);
		const later = await stale(room, ana);
		later.rebase();
		await vi.waitFor(() => expect(later.closed?.code).toBe(CLOSE.reseeded));
		expect(texts(await roomJSON(room))).toEqual({ p1: '>hello one' });
	});

	it('a hand-over still in flight when the room re-seeds again merges across both cuts', async () => {
		const room = 'reseed-twice';
		const ana = await offlineAcrossReseed(room);
		ana.facade.insertText('p1', 5, ' there');
		const back = await stale(room, ana);
		expect(await inRoom(room, (r) => r.reseed())).toBe(2);
		expect(back.closed).toBe(null);
		back.rebase();
		await vi.waitFor(() => expect(back.closed).toEqual({ code: CLOSE.reseeded, reason: '2' }));
		expect(texts(await roomJSON(room))).toEqual({ p1: 'hello there' });
	});

	it("one user's upload never claims another's edits", async () => {
		const room = 'reseed-claims';
		const ana = await offlineAcrossReseed(room);
		ana.facade.insertText('p1', 5, ' beta');
		// Bob's old document, and a run of ana's client id he forged into it.
		const bob = E.createDocument({ actor: { id: 'bob' } });
		Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(ana.doc, Y.encodeStateVector(bob.doc)));
		const forged = new UpdateEncoder();
		encoding.writeVarUint(forged.restEncoder, 1);
		encoding.writeVarUint(forged.restEncoder, 1);
		forged.writeClient(ana.doc.clientID);
		encoding.writeVarUint(forged.restEncoder, 0);
		forged.writeInfo(0);
		forged.writeLen(1_000_000);
		encoding.writeVarUint(forged.restEncoder, 0);
		const mallory = await stale(room, bob, 'bob');
		mallory.rebase(
			Y.mergeUpdates([
				Y.encodeStateAsUpdate(bob.doc),
				forged.toUint8Array()
			] as Uint8Array<ArrayBuffer>[])
		);
		await vi.waitFor(() => expect(mallory.closed?.code).toBe(CLOSE.reseeded));
		const back = await stale(room, ana);
		back.rebase();
		await vi.waitFor(() => expect(back.closed?.code).toBe(CLOSE.reseeded));
		expect(texts(await roomJSON(room))).toEqual({ p1: 'hello beta' });
	});

	it('nothing is relayed to a stale socket; a current one sending the old epoch is closed 4410', async () => {
		const room = 'reseed-relay';
		const ana = await offlineAcrossReseed(room);
		const back = await stale(room, ana);
		const bob = await writer(room, 'bob', null, 1);
		await vi.waitFor(() => expect(bob.client.synced).toBe(true));
		bob.document.facade.insertText('p1', 5, ' world');
		await vi.waitFor(() => expect(bob.client.stored()).toBe(true));
		expect(back.syncFrames()).toBe(0);
		// A tab of the new epoch that took the old document from another tab.
		const mixed = await RawClient.connect(room, ana.doc, { user: 'ana', epoch: 1 });
		await vi.waitFor(() => expect(mixed.closed).toEqual({ code: CLOSE.reseeded, reason: '1' }));
		expect(texts(await roomJSON(room)).p1).toBe('hello world');
		back.close();
		bob.client.close();
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

	it('past 80 % too, not under the floor a skipped run left', async () => {
		const room = 'reseed-floor';
		await clockTo(room, T0);
		const { document, client } = await writer(room, 'ana', [para('p1', 'hello')]);
		await vi.waitFor(() => expect(client.stored()).toBe(true));
		// The floor a skipped run leaves (`reseed.floor`), above what the churn reaches.
		await inRoom(room, (_r, state) => {
			const sql = state.storage.sql;
			const { name } = sql
				.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE name LIKE '%meta'`)
				.one();
			sql.exec(`INSERT OR REPLACE INTO ${name} (key, value) VALUES ('reseed.floor', 7900)`);
		});
		const bytes = () => inRoom(room, (r) => r.metrics().documentBytes);
		while ((await bytes()) <= 6_400) {
			churn(document, 'p1', 10, 'a longer word to type '.repeat(2));
			await vi.waitFor(() => expect(client.stored()).toBe(true));
		}
		expect(await bytes()).toBeLessThan(7_900);
		const alarm = await inRoom(room, (_r, state) => state.storage.getAlarm());
		expect(alarm === null || alarm > T0).toBe(true);
		expect(await inRoom(room, (r) => r.logged.filter((e) => e.edytor === 'reseed'))).toEqual([]);
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
	/** A socket that drops what it sends while `held` (a frame lost in flight). */
	class HeldSocket extends SelfWebSocket {
		static held = false;
		override send(data: string | ArrayBuffer | Uint8Array) {
			if (!HeldSocket.held) super.send(data);
		}
	}
	/** The shipped provider over `SELF`, for `user`. */
	const provider = (
		room: string,
		doc: E.YDoc,
		user: string,
		connect = true,
		socket: typeof SelfWebSocket = SelfWebSocket
	) =>
		new crdt.providers.WebsocketProvider(url, room, doc, {
			params: { user },
			WebSocketPolyfill: socket as unknown as typeof WebSocket,
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
		const pa = provider(room, a.doc, 'ana', true, HeldSocket);
		const heard = refusals(pa);
		await vi.waitFor(() => expect(pa.synced && pa.saved).toBe(true));
		// The edit's frame never reaches the room: unsaved when the re-seed closes the socket.
		HeldSocket.held = true;
		a.facade.insertText('p1', 5, ' typed');
		expect(pa.unsaved).toBeGreaterThan(0);
		await inRoom(room, (r) => r.reseed());
		HeldSocket.held = false;
		await vi.waitFor(() => expect(heard).toEqual([{ code: CLOSE.reseeded, reason: '1' }]));
		expect(texts(await roomJSON(room))).toEqual({ p1: 'hello typed' });
		expect(await rebases(room)).toEqual(['applied']);
		pa.destroy();
	});
});
