/**
 * WU-06 (production-readiness plan, R5) — revocation and token expiry
 * (`room.access` in `docs/editor-delete-contract.md`).
 *
 * - `closeUser(userId, code?)` (also over RPC) closes every socket of the
 *   user, `4403` (`access revoked`) by default, and returns how many;
 * - `setAccess(userId, 'read')` downgrades the user's write sockets: each
 *   gets the read-only notice and stays, and its next write is denied;
 *   `'write'` closes the user's read-only sockets `1012`
 *   (`access changed`), which the provider redials so `authorize` decides
 *   again; `'none'` closes them all `4403`;
 * - `authorize` may return `expiresAt` (ms since the epoch): a dial past it
 *   is closed `4401` by the router; the room keeps it in the socket's
 *   attachment and closes the socket `4401` (`expired`) at its first frame
 *   past it, or at the alarm due then (task `expiry`), and the provider
 *   redials with its `params` read again.
 *
 * `timed-*` rooms (`TimedRoom`) run on a fake clock; the test Worker's
 * `authorize` reads `?expires=<ms>`.
 */
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { attachDocument, type DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import { setNow, type PlainObject, type TimedRoom } from './worker';
import { E, ORIGIN, RawClient, SelfWebSocket, crdt, dialOutcome, para, readFacade } from './client';

const SLOW = { timeout: 20_000, interval: 25 };

declare global {
	namespace Cloudflare {
		interface Env {
			TIMED: DurableObjectNamespace<TimedRoom>;
			PLAIN: DurableObjectNamespace<PlainObject>;
		}
	}
}

const textIn = (stub: DurableObjectStub<Room>, block: string) =>
	runInDurableObject(stub, (r: Room) => readFacade(r.doc!, (f) => f.blockText(block)));

/** A writer joining `room` with a document holding paragraph `p`. */
const writer = async (room: string, user: string, extra: Record<string, unknown> = {}) => {
	const document = E.createDocument({ value: { children: [para('p', '')] }, actor: { id: user } });
	const client = await RawClient.connect(room, document.doc, {
		user,
		replica: document.doc.clientID,
		...extra
	});
	await vi.waitFor(() => expect(client.synced && client.acks.length > 1).toBe(true), SLOW);
	return { document, client };
};

describe('WU-06 · revocation', () => {
	it('closeUser closes every socket of the user (4403), and only theirs', async () => {
		const room = 'wu06-close';
		const stub = env.ROOM.getByName(room);
		const a1 = await writer(room, 'ada');
		const a2 = await RawClient.connect(room, undefined, { user: 'ada', access: 'read' });
		const b = await writer(room, 'bob');
		await vi.waitFor(() => expect(a2.synced).toBe(true), SLOW);
		expect(await stub.closeUser('ada')).toEqual({ sockets: 2 });
		await vi.waitFor(() => {
			expect(a1.client.closed).toEqual({ code: 4403, reason: 'access revoked' });
			expect(a2.closed).toEqual({ code: 4403, reason: 'access revoked' });
		}, SLOW);
		expect(b.client.closed).toBe(null);
		expect(await stub.closeUser('nobody')).toEqual({ sockets: 0 });
		// A code of the host's own: 4401 makes the provider redial with fresh params.
		const a3 = await writer(room, 'ada');
		expect(await stub.closeUser('ada', 4401)).toEqual({ sockets: 1 });
		await vi.waitFor(() => expect(a3.client.closed?.code).toBe(4401), SLOW);
		b.client.close();
		for (const { document } of [a1, b, a3]) document.destroy();
	});

	it("setAccess read: the user's write sockets get the read-only notice, stay, and their writes are denied", async () => {
		const room = 'wu06-read';
		const stub = env.ROOM.getByName(room);
		const a = await writer(room, 'ada');
		const b = await writer(room, 'bob');
		expect(a.client.readOnly).toBe(false);
		expect(await stub.setAccess('ada', 'read')).toEqual({ sockets: 1 });
		await vi.waitFor(() => expect(a.client.readOnly).toBe(true), SLOW);
		a.document.transact(() => a.document.facade.insertText('p', 0, 'after'));
		await vi.waitFor(() => expect(a.client.denied).toEqual(['read-only']), SLOW);
		expect(await textIn(stub, 'p')).toBe('');
		expect(a.client.closed).toBe(null);
		// Bob still writes, and Ada still receives.
		b.document.transact(() => b.document.facade.insertText('p', 0, 'bob'));
		await vi.waitFor(
			() => expect(readFacade(a.client.doc, (f) => f.blockText('p'))).toContain('bob'),
			SLOW
		);
		expect(await stub.setAccess('ada', 'read')).toEqual({ sockets: 0 });
		a.client.close();
		b.client.close();
		a.document.destroy();
		b.document.destroy();
	});

	it("setAccess write closes the user's read-only sockets 1012; the provider redials", async () => {
		const room = 'wu06-write';
		const stub = env.ROOM.getByName(room);
		await writer(room, 'root');
		const raw = await RawClient.connect(room, undefined, { user: 'viv', access: 'read' });
		await vi.waitFor(() => expect(raw.readOnly).toBe(true), SLOW);
		let dials = 0;
		class CountingSocket extends SelfWebSocket {
			constructor(url: string) {
				super(url);
				dials++;
			}
		}
		const document = E.createDocument({ actor: { id: 'viv' } });
		const refusals: number[] = [];
		document.onSyncRefused((refusal) => refusals.push(refusal.code));
		const release = document.attachSync(
			crdt.providers.createWebsocketSync({
				server: `${ORIGIN.replace('https', 'wss')}/rooms`,
				room,
				params: { user: 'viv', access: 'read' },
				WebSocketPolyfill: CountingSocket as unknown as typeof WebSocket
			})
		);
		await vi.waitFor(() => expect(dials).toBe(1), SLOW);
		await vi.waitFor(async () => expect((await stub.metrics()).sockets).toBe(3), SLOW);
		expect(await stub.setAccess('viv', 'write')).toEqual({ sockets: 2 });
		await vi.waitFor(
			() => expect(raw.closed).toEqual({ code: 1012, reason: 'access changed' }),
			SLOW
		);
		await vi.waitFor(() => expect(dials).toBe(2), SLOW);
		// The redial is in: the root writer's socket and the provider's.
		await vi.waitFor(async () => expect((await stub.metrics()).sockets).toBe(2), SLOW);
		expect(refusals).toEqual([]);
		expect(await stub.setAccess('viv', 'none')).toEqual({ sockets: 1 });
		await vi.waitFor(() => expect(refusals).toEqual([4403]), SLOW);
		await release?.();
		document.destroy();
	});
});

describe('WU-06 · credential expiry', () => {
	it('the router closes a dial whose expiresAt has passed 4401, and an invalid one 4403', async () => {
		const room = 'wu06-dial';
		expect(await dialOutcome(room, { user: 'ada', expires: Date.now() - 1 })).toEqual({
			code: 4401,
			reason: 'expired'
		});
		expect(await dialOutcome(room, { user: 'ada', expires: 'soon' })).toEqual({
			code: 4403,
			reason: 'document access denied'
		});
		expect(await dialOutcome(room, { user: 'ada', expires: Date.now() + 60_000 })).toBe('open');
	});

	it('a socket past its expiry is closed 4401 at its next frame; its write is not applied', async () => {
		const room = 'timed-expiry-frame';
		const stub = env.TIMED.getByName(room);
		const expires = Date.now() + 60_000;
		const a = await writer(room, 'ada', { expires });
		await runInDurableObject(stub, (_r, state) => setNow(state.storage.sql, expires + 1));
		a.document.transact(() => a.document.facade.insertText('p', 0, 'late'));
		await vi.waitFor(
			() => expect(a.client.closed).toEqual({ code: 4401, reason: 'expired' }),
			SLOW
		);
		expect(await textIn(stub, 'p')).toBe('');
		a.document.destroy();
	});

	it('the alarm closes a silent socket at its expiry (4401) and re-arms for the next one', async () => {
		const room = 'timed-expiry-alarm';
		const stub = env.TIMED.getByName(room);
		const first = Date.now() + 60_000;
		const second = first + 60_000;
		const a = await writer(room, 'ada', { expires: first });
		const b = await writer(room, 'bob', { expires: second });
		const alarm = () => runInDurableObject(stub, (_r, state) => state.storage.getAlarm());
		expect(await alarm()).toBe(first);
		await runInDurableObject(stub, (_r, state) => setNow(state.storage.sql, first));
		await runDurableObjectAlarm(stub);
		await vi.waitFor(
			() => expect(a.client.closed).toEqual({ code: 4401, reason: 'expired' }),
			SLOW
		);
		expect(b.client.closed).toBe(null);
		expect(await alarm()).toBe(second);
		a.document.destroy();
		b.client.close();
		b.document.destroy();
	});

	it('the provider redials after an expiry close with the params it reads then', async () => {
		const room = 'wu06-expiry-provider';
		let dials = 0;
		class CountingSocket extends SelfWebSocket {
			constructor(url: string) {
				super(url);
				dials++;
			}
		}
		const document = E.createDocument({
			value: { children: [para('p', '')] },
			actor: { id: 'ada' }
		});
		const params = { user: 'ada', expires: String(Date.now() + 1500) };
		let expired = 0;
		const release = document.attachSync(
			crdt.providers.createWebsocketSync({
				server: `${ORIGIN.replace('https', 'wss')}/rooms`,
				room,
				params,
				onExpired: () => {
					expired++;
					params.expires = String(Date.now() + 3_600_000);
				},
				WebSocketPolyfill: CountingSocket as unknown as typeof WebSocket
			})
		);
		await vi.waitFor(() => expect(expired).toBe(1), SLOW);
		await vi.waitFor(() => expect(dials).toBe(2), SLOW);
		document.transact(() => document.facade.insertText('p', 0, 'again'));
		await vi.waitFor(
			async () => expect(await textIn(env.ROOM.getByName(room), 'p')).toBe('again'),
			SLOW
		);
		await release?.();
		document.destroy();
	});
});

describe('WU-06 · the alarm handler', () => {
	it('attachDocument installs alarm even with no save, history or purge (expiry and moves use it)', async () => {
		const installed = await runInDurableObject(
			env.PLAIN.getByName('plain-wu06-alarm'),
			(_o, state) => {
				const host = { ctx: state } as unknown as Parameters<typeof attachDocument>[0];
				attachDocument(host, { purgeAfterDays: false, tablePrefix: 'wu06_' });
				return typeof (host as unknown as { alarm?: unknown }).alarm;
			}
		);
		expect(installed).toBe('function');
	});
});
