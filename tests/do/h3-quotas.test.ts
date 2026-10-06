/**
 * Phase 2, H3 — room quotas (`room.quota` in
 * `docs/editor-delete-contract.md`). The `quota-*` rooms (`QuotaRoom`)
 * set them low through the `EDYTOR_MAX_*` vars: 20,000 document bytes,
 * 30,000-byte frames, 2 sync messages a second (a burst of 20).
 *
 * - a write past a quota is not applied, and its socket is closed `4413`
 *   (`quota: document | rate | frame`), logged as a `quota` refusal;
 * - a frame that deletes at least what it adds still applies to a full
 *   document;
 * - a chunked frame announcing more than the frame quota is refused at its
 *   first chunk;
 * - the shipped provider reports the close as a refusal (`onSyncRefused`,
 *   `syncRefusal`, code `4413`) and does not redial.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { QuotaRoom } from './worker';
import { E, ORIGIN, RawClient, SelfWebSocket, Y, crdt, para, readFacade } from './client';

/** `vi.waitFor` under a loaded pool: the default 1 s is short for a room's round trips. */
const SLOW = { timeout: 10_000, interval: 25 };

declare global {
	namespace Cloudflare {
		interface Env {
			QUOTA: DurableObjectNamespace<QuotaRoom>;
		}
	}
}

const stubOf = (room: string) => env.QUOTA.getByName(room);
const inRoom = <T>(room: string, fn: (r: QuotaRoom) => T) =>
	runInDurableObject(stubOf(room), (r: QuotaRoom) => fn(r));
const textOf = (room: string) => inRoom(room, (r) => readFacade(r.doc!, (f) => f.blockText('p')));
const quotaRefusals = (room: string) =>
	inRoom(room, (r) =>
		r.refusals
			.filter((refusal) => refusal.reason === 'quota')
			.map((refusal) => (refusal.detail as { quota: string }).quota)
	);
const syncFrame = (update: Uint8Array) =>
	E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, update));

/** Incompressible text: what a document quota measures is what it stores. */
const noise = (length: number, seed: number) =>
	Array.from({ length }, () => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return String.fromCharCode(48 + ((seed >>> 16) % 64));
	}).join('');

describe('H3 · room quotas', () => {
	it('document: the write that would pass it is refused (4413); a frame that deletes more than it adds applies', async () => {
		const room = 'quota-document';
		const a = E.createDocument({ value: { children: [para('p', '')] }, actor: { id: 'ada' } });
		const ca = await RawClient.connect(room, a.doc, { user: 'ada', replica: a.doc.clientID });
		await vi.waitFor(() => expect(ca.synced).toBe(true), SLOW);
		let typed = '';
		for (let i = 0; i < 9 && ca.closed === null; i++) {
			const chunk = noise(3000, i + 1);
			a.transact(() => a.facade.insertText('p', typed.length, chunk));
			typed += chunk;
			await vi.waitFor(
				async () => expect(ca.closed !== null || (await textOf(room)) === typed).toBe(true),
				SLOW
			);
		}
		await vi.waitFor(
			() => expect(ca.closed).toEqual({ code: 4413, reason: 'quota: document' }),
			SLOW
		);
		const stored = (await textOf(room))!;
		expect(stored.length).toBeLessThan(typed.length);
		expect(typed.startsWith(stored)).toBe(true);
		expect(stored.length).toBeGreaterThanOrEqual(15_000);
		expect(await quotaRefusals(room)).toEqual(['document']);

		// Bob trims the full document: a delete frees more than its mark adds.
		const b = E.createDocument({ actor: { id: 'bob' } });
		const cb = await RawClient.connect(room, b.doc, { user: 'bob', replica: b.doc.clientID });
		await vi.waitFor(() => expect(cb.synced).toBe(true), SLOW);
		b.transact(() => b.facade.deleteText('p', 0, 5000));
		await vi.waitFor(async () => expect(await textOf(room)).toBe(stored.slice(5000)), SLOW);
		expect(cb.closed).toBe(null);
		// …and may type again within the room it freed.
		b.transact(() => b.facade.insertText('p', 0, 'room again'));
		await vi.waitFor(
			async () => expect(await textOf(room)).toBe(`room again${stored.slice(5000)}`),
			SLOW
		);
		cb.close();
		a.destroy();
		b.destroy();
	});

	it('rate: a socket past its burst is refused (4413); what it sent before applied', async () => {
		const room = 'quota-rate';
		const a = E.createDocument({ value: { children: [para('p', '')] }, actor: { id: 'ada' } });
		const ca = await RawClient.connect(room, a.doc, { user: 'ada', replica: a.doc.clientID });
		await vi.waitFor(() => expect(ca.synced).toBe(true), SLOW);
		for (let i = 0; i < 40; i++) a.transact(() => a.facade.insertText('p', i, 'x'));
		await vi.waitFor(() => expect(ca.closed).toEqual({ code: 4413, reason: 'quota: rate' }), SLOW);
		const stored = (await textOf(room))!;
		// The burst (20 messages, the handshake's among them) applied; the rest did not.
		expect(stored.length).toBeGreaterThan(10);
		expect(stored.length).toBeLessThan(40);
		expect(await quotaRefusals(room)).toEqual(['rate']);
		a.destroy();
	});

	it('frame: a frame, or a chunk sequence, larger than the quota is refused (4413) unread', async () => {
		const room = 'quota-frame';
		const a = E.createDocument({ value: { children: [para('p', '')] }, actor: { id: 'ada' } });
		const ca = await RawClient.connect(room, a.doc, { user: 'ada', replica: a.doc.clientID });
		await vi.waitFor(() => expect(ca.synced).toBe(true), SLOW);
		const updates: Uint8Array[] = [];
		a.doc.on('update', (update: Uint8Array) => updates.push(update));
		ca.close();
		a.transact(() => a.facade.insertText('p', 0, noise(31_000, 3)));
		const whole = syncFrame(updates[0]);
		expect(whole.length).toBeGreaterThan(30_000);

		const direct = await RawClient.bare(room, { user: 'ada', replica: a.doc.clientID });
		direct.send(whole);
		await vi.waitFor(
			() => expect(direct.closed).toEqual({ code: 4413, reason: 'quota: frame' }),
			SLOW
		);

		const chunked = await RawClient.bare(room, { user: 'ada', replica: a.doc.clientID });
		const pieces = E.chunkFrame(whole, 8192);
		expect(pieces.length).toBeGreaterThan(2);
		for (const piece of pieces) chunked.send(piece);
		await vi.waitFor(
			() => expect(chunked.closed).toEqual({ code: 4413, reason: 'quota: frame' }),
			SLOW
		);
		expect(await textOf(room)).toBe('');
		expect(await quotaRefusals(room)).toEqual(['frame', 'frame']);
		a.destroy();
	});

	it('the shipped provider reports a quota close as a refusal and stops dialing', async () => {
		const room = 'quota-provider';
		let dials = 0;
		class CountingSocket extends SelfWebSocket {
			constructor(url: string) {
				super(url);
				dials++;
			}
		}
		const document = E.createDocument({
			value: { children: [para('p', noise(25_000, 9))] },
			actor: { id: 'ada' }
		});
		const refusals: Array<{ code: number; reason: string }> = [];
		document.onSyncRefused((refusal) =>
			refusals.push({ code: refusal.code, reason: refusal.reason })
		);
		const release = document.attachSync(
			crdt.providers.createWebsocketSync({
				server: `${ORIGIN.replace('https', 'wss')}/rooms`,
				room,
				params: { user: 'ada' },
				WebSocketPolyfill: CountingSocket as unknown as typeof WebSocket
			})
		);
		await vi.waitFor(
			() => expect(refusals).toEqual([{ code: 4413, reason: 'quota: document' }]),
			SLOW
		);
		expect(document.syncRefusal?.code).toBe(4413);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(dials).toBe(1);
		expect(Y.encodeStateVector(document.doc).length).toBeGreaterThan(1); // kept locally
		await release?.();
		document.destroy();
	});
});
