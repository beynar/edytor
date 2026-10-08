/**
 * WU-07 (production-readiness plan, R6, R7, decision D5) — attribution
 * trust and Origin (`room.attribution.trust` in
 * `docs/editor-delete-contract.md`).
 *
 * - a replica binds only itself: a `c/<n>` entry written under another
 *   client id than `n` is collected from the frame (a GC in its place, the
 *   rest of the frame applied) and logged `forged`;
 * - the room binds each of the sender's replicas to the verified user: a
 *   `c/<own id>` naming another actor is applied, then rewritten by the
 *   room to the user (an anonymous document's binding included);
 * - only a user writes its own profile: a `u/<other>` entry is collected,
 *   logged `forged`; a delete of another user's `u/` entry, or of a `c/`
 *   entry of a replica the sender does not own, is dropped;
 * - the room stamps the `actor.id` of every relayed presence state that
 *   names an actor with the verified user (a state with none is relayed
 *   as it is);
 * - a relayed id's binding to another user is collected too (the room
 *   cannot vouch for it); the author's claim of the id (its dial, an
 *   `orphan`) binds it to them;
 * - `allowedOrigins` on `routeDocumentSocket` / `routeDocumentHistory`: a
 *   request whose `Origin` is not listed is refused before `authorize`
 *   (`4403` `origin not allowed` for a dial, `403` for HTTP); a request
 *   with no `Origin` (not a browser) passes. `origin-*` rooms list
 *   {@link ORIGIN}.
 */
import { env } from 'cloudflare:workers';
import { SELF, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import { E, ORIGIN, RawClient, Y, dialResponse, para, readFacade } from './client';

const SLOW = { timeout: 20_000, interval: 25 };

type Attrs = { getAttr(key: string): unknown; setAttr(key: string, value: unknown): void };
type AttrRoot = Attrs & { deleteAttr(key: string): void };
const attributionOf = (doc: unknown): AttrRoot =>
	(doc as { get(name: string): AttrRoot }).get('attribution');

/** The room's value of the attribution entry `key`. */
const roomAttr = (stub: DurableObjectStub<Room>, key: string) =>
	runInDurableObject(stub, (r: Room) => attributionOf(r.doc).getAttr(key) ?? null);

const roomText = (stub: DurableObjectStub<Room>, block: string) =>
	runInDurableObject(stub, (r: Room) => readFacade(r.doc!, (f) => f.blockText(block)));

const forged = (stub: DurableObjectStub<Room>) =>
	runInDurableObject(stub, (r: Room) =>
		r.refusals.filter((refusal) => refusal.reason === 'forged').map((refusal) => refusal.detail)
	);

/** A writer joining `room` as `user`, its document's actor `actor` (absent: anonymous). */
const join = async (room: string, user: string, actor?: { id: string; name?: string }) => {
	const document = E.createDocument({
		value: { children: [para('p', '')] },
		...(actor ? { actor } : {})
	});
	const client = await RawClient.connect(room, document.doc, {
		user,
		replica: document.doc.clientID
	});
	await vi.waitFor(() => expect(client.synced && client.acks.length > 1).toBe(true), SLOW);
	return { document, client, root: attributionOf(document.doc) };
};

describe('WU-07 · attribution trust (D5)', () => {
	it("a write to another user's profile is collected, the rest of the frame applied", async () => {
		const room = 'wu07-profile';
		const stub = env.ROOM.getByName(room);
		const bob = await join(room, 'bob', { id: 'bob', name: 'Bob' });
		const ada = await join(room, 'ada', { id: 'ada', name: 'Ada' });
		await vi.waitFor(() => expect(ada.root.getAttr('u/bob')).toEqual({ name: 'Bob' }), SLOW);
		// One frame: a forged profile, and an edit of Ada's own.
		ada.document.doc.transact(() => {
			ada.root.setAttr('u/bob', { name: 'Mallory' });
			ada.document.facade.insertText('p', 0, 'hi');
		});
		await vi.waitFor(async () => expect(await roomText(stub, 'p')).toBe('hi'), SLOW);
		expect(await roomAttr(stub, 'u/bob')).toEqual({ name: 'Bob' });
		expect(await roomAttr(stub, 'u/ada')).toEqual({ name: 'Ada' });
		expect(await forged(stub)).toEqual([{ user: 'ada', keys: ['u/bob'] }]);
		await vi.waitFor(
			() => expect(readFacade(bob.client.doc, (f) => f.blockText('p'))).toBe('hi'),
			SLOW
		);
		expect(bob.root.getAttr('u/bob')).toEqual({ name: 'Bob' });
		// Ada is acknowledged: the collected entry counts as stored.
		const clock = ada.document.doc.store.clients.get(ada.document.doc.clientID)!;
		const last = clock.at(-1)!;
		await vi.waitFor(
			() =>
				expect(ada.client.acks.at(-1)?.get(ada.document.doc.clientID)).toBe(
					last.id.clock + last.length
				),
			SLOW
		);
		// A delete of Bob's profile (by a peer that holds it) is dropped.
		const eve = await join(room, 'eve', { id: 'eve' });
		expect(eve.root.getAttr('u/bob')).toEqual({ name: 'Bob' });
		eve.document.doc.transact(() => eve.root.deleteAttr('u/bob'));
		await vi.waitFor(
			async () => expect((await forged(stub)).at(-1)).toEqual({ user: 'eve', keys: ['u/bob'] }),
			SLOW
		);
		expect(await roomAttr(stub, 'u/bob')).toEqual({ name: 'Bob' });
		// Ada's own profile is hers to change.
		ada.document.attribution.setProfile({ name: 'Ada L.' });
		await vi.waitFor(
			async () => expect(await roomAttr(stub, 'u/ada')).toEqual({ name: 'Ada L.' }),
			SLOW
		);
		for (const { client, document } of [ada, bob, eve]) {
			client.close();
			document.destroy();
		}
	});

	it("a replica binds only itself; the room binds the sender's replica to the verified user", async () => {
		const room = 'wu07-bindings';
		const stub = env.ROOM.getByName(room);
		const bob = await join(room, 'bob', { id: 'bob' });
		const ada = await join(room, 'ada', { id: 'ada' });
		const bobId = bob.document.doc.clientID;
		const adaId = ada.document.doc.clientID;
		expect(await roomAttr(stub, `c/${bobId}`)).toBe('bob');
		// Rebinding Bob's replica to Ada: collected.
		ada.document.doc.transact(() => ada.root.setAttr(`c/${bobId}`, 'ada'));
		await vi.waitFor(
			async () => expect(await forged(stub)).toEqual([{ user: 'ada', keys: [`c/${bobId}`] }]),
			SLOW
		);
		expect(await roomAttr(stub, `c/${bobId}`)).toBe('bob');
		// Deleting Bob's binding (by a peer that holds it): dropped.
		const eve = await join(room, 'eve', { id: 'eve' });
		eve.document.doc.transact(() => eve.root.deleteAttr(`c/${bobId}`));
		await vi.waitFor(
			async () =>
				expect((await forged(stub)).at(-1)).toEqual({ user: 'eve', keys: [`c/${bobId}`] }),
			SLOW
		);
		expect(await roomAttr(stub, `c/${bobId}`)).toBe('bob');
		// Ada's own replica named after Bob: the room binds it to Ada, everywhere.
		ada.document.doc.transact(() => ada.root.setAttr(`c/${adaId}`, 'bob'));
		await vi.waitFor(async () => expect(await roomAttr(stub, `c/${adaId}`)).toBe('ada'), SLOW);
		await vi.waitFor(() => expect(ada.root.getAttr(`c/${adaId}`)).toBe('ada'), SLOW);
		await vi.waitFor(() => expect(bob.root.getAttr(`c/${adaId}`)).toBe('ada'), SLOW);
		expect(ada.document.attribution.actorOf(adaId)).toBe('ada');
		expect(await forged(stub)).toHaveLength(2);
		for (const { client, document } of [ada, bob, eve]) {
			client.close();
			document.destroy();
		}
	});

	it("a relayed replica's binding to another user is collected; its author's claim binds it again", async () => {
		const room = 'wu07-relayed';
		const stub = env.ROOM.getByName(room);
		// Bob edits offline; Ada holds his edits (a restored room's lost
		// edits, say) and joins first: his id is fresh, so she relays it.
		const bob = E.createDocument({ value: { children: [para('p', '')] }, actor: { id: 'bob' } });
		bob.transact(() => bob.facade.insertText('p', 0, 'bob'));
		const bobId = bob.doc.clientID;
		const ada = E.createDocument({ value: { children: [para('p', '')] }, actor: { id: 'ada' } });
		Y.applyUpdate(ada.doc, Y.encodeStateAsUpdate(bob.doc));
		const adaClient = await RawClient.connect(room, ada.doc, {
			user: 'ada',
			replica: ada.doc.clientID
		});
		await vi.waitFor(() => expect(adaClient.synced && adaClient.acks.length > 1).toBe(true), SLOW);
		await vi.waitFor(
			async () =>
				expect((await forged(stub)).at(-1)).toEqual({ user: 'ada', keys: [`c/${bobId}`] }),
			SLOW
		);
		// Bob's edits are stored, relayed; the binding Ada cannot vouch for is not.
		expect(await roomText(stub, 'p')).toBe('bob');
		expect(await roomAttr(stub, `c/${bobId}`)).toBe(null);
		// Bob's own dial claims his id: the room binds it to him, for everyone.
		const bobClient = await RawClient.connect(room, bob.doc, { user: 'bob', replica: bobId });
		await vi.waitFor(async () => expect(await roomAttr(stub, `c/${bobId}`)).toBe('bob'), SLOW);
		await vi.waitFor(() => expect(attributionOf(ada.doc).getAttr(`c/${bobId}`)).toBe('bob'), SLOW);
		expect(await runInDurableObject(stub, (r: Room) => r.refusals.map((x) => x.reason))).toContain(
			'orphan'
		);
		for (const client of [adaClient, bobClient]) client.close();
		ada.destroy();
		bob.destroy();
	});

	it("the room's own binding, relayed to a room that lacks it, is kept: it names the replica's owner", async () => {
		// Room A rebinds Ada's replica (named after Bob) to Ada: a write
		// under room A's own client id, which Ada's document now holds.
		const roomA = 'wu07-room-binding-a';
		const ada = await join(roomA, 'ada', { id: 'bob' });
		const adaId = ada.document.doc.clientID;
		await vi.waitFor(() => expect(ada.root.getAttr(`c/${adaId}`)).toBe('ada'), SLOW);
		const roomAClient = await runInDurableObject(
			env.ROOM.getByName(roomA),
			(r: Room) => r.doc!.clientID
		);
		expect(ada.document.doc.store.clients.has(roomAClient)).toBe(true);
		ada.client.close();
		// Room B (a reset container, say) lacks it: Ada's reconnect relays it.
		// It names Ada, her replica's owner: kept, not collected as forged.
		const roomB = 'wu07-room-binding-b';
		const stubB = env.ROOM.getByName(roomB);
		const adaB = await RawClient.connect(roomB, ada.document.doc, { user: 'ada', replica: adaId });
		await vi.waitFor(() => expect(adaB.synced && adaB.acks.length > 1).toBe(true), SLOW);
		await vi.waitFor(async () => expect(await roomAttr(stubB, `c/${adaId}`)).toBe('ada'), SLOW);
		expect(await forged(stubB)).toEqual([]);
		const kept = await runInDurableObject(stubB, (r: Room) =>
			(r.doc!.store.clients.get(roomAClient) ?? []).map(
				(struct) => (struct as { content?: unknown }).content !== undefined
			)
		);
		expect(kept.length).toBeGreaterThan(0);
		expect(kept.every(Boolean)).toBe(true);
		adaB.close();
		ada.document.destroy();
	});

	it("an anonymous document's replica is bound to the dial's user; its edits apply", async () => {
		const room = 'wu07-anonymous';
		const stub = env.ROOM.getByName(room);
		const carol = await join(room, 'carol');
		const id = carol.document.doc.clientID;
		expect(carol.document.actor.id).not.toBe('carol');
		await vi.waitFor(async () => expect(await roomAttr(stub, `c/${id}`)).toBe('carol'), SLOW);
		await vi.waitFor(() => expect(carol.document.attribution.actorOf(id)).toBe('carol'), SLOW);
		carol.document.transact(() => carol.document.facade.insertText('p', 0, 'mine'));
		await vi.waitFor(async () => expect(await roomText(stub, 'p')).toBe('mine'), SLOW);
		expect(await forged(stub)).toEqual([]);
		carol.client.close();
		carol.document.destroy();
	});

	it("the room stamps a relayed presence state's actor id with the verified user", async () => {
		const room = 'wu07-presence';
		const peer = await RawClient.connect(room, undefined, { user: 'pam' });
		const ada = await RawClient.connect(room, undefined, { user: 'ada', replica: 701 });
		await vi.waitFor(() => expect(peer.synced && ada.synced).toBe(true), SLOW);
		ada.setPresence(701, 1, { actor: { id: 'bob', name: 'Bob' }, user: { name: 'Bob' } });
		await vi.waitFor(
			() =>
				expect(peer.presence.get(701)?.state).toEqual({
					actor: { id: 'ada', name: 'Bob' },
					user: { name: 'Bob' }
				}),
			SLOW
		);
		// An actor that is not an object is replaced by the verified one.
		ada.setPresence(701, 2, { actor: 'bob', user: { name: 'Ada' } });
		await vi.waitFor(
			() =>
				expect(peer.presence.get(701)?.state).toEqual({
					actor: { id: 'ada' },
					user: { name: 'Ada' }
				}),
			SLOW
		);
		const stored = await runInDurableObject(
			env.ROOM.getByName(room),
			(r: Room) => r.presence.get(701)?.state
		);
		expect(stored).toEqual({ actor: { id: 'ada' }, user: { name: 'Ada' } });
		// A state naming no actor claims no identity: relayed as it is.
		ada.setPresence(701, 3, { user: { name: 'Ada' } });
		await vi.waitFor(
			() => expect(peer.presence.get(701)?.state).toEqual({ user: { name: 'Ada' } }),
			SLOW
		);
		peer.close();
		ada.close();
	});
});

/** How a dial ends: `'open'` once the room speaks, or its close. */
const outcome = async (response: Response): Promise<'open' | { code: number; reason: string }> => {
	const ws = response.webSocket;
	if (!ws) throw new Error(`upgrade refused: ${response.status}`);
	ws.accept();
	return new Promise((resolve) => {
		ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }));
		ws.addEventListener('message', () => {
			resolve('open');
			ws.close(1000, 'done');
		});
	});
};

describe('WU-07 · allowedOrigins (R7)', () => {
	it('a dial from an Origin not listed is closed 4403; a listed one, or none, opens', async () => {
		const room = 'origin-dial';
		expect(
			await outcome(await dialResponse(room, { user: 'ada' }, { Origin: 'https://evil.test' }))
		).toEqual({ code: 4403, reason: 'origin not allowed' });
		expect(await outcome(await dialResponse(room, { user: 'ada' }, { Origin: ORIGIN }))).toBe(
			'open'
		);
		expect(await outcome(await dialResponse(room, { user: 'ada' }))).toBe('open');
		// Another room's router lists no origins: any passes.
		expect(
			await outcome(
				await dialResponse('wu07-any-origin', { user: 'ada' }, { Origin: 'https://evil.test' })
			)
		).toBe('open');
	});

	it('a probe or a history request from an Origin not listed is refused 403', async () => {
		const room = 'origin-http';
		const evil = { Origin: 'https://evil.test' };
		const post = (headers: HeadersInit) =>
			SELF.fetch(`${ORIGIN}/history/${room}?user=ada&undo`, { method: 'POST', headers });
		const refused = await post(evil);
		expect(refused.status).toBe(403);
		expect(await refused.text()).toBe('origin not allowed');
		expect((await post({ Origin: ORIGIN })).status).not.toBe(403);
		expect((await SELF.fetch(`${ORIGIN}/history/${room}?user=ada`, { headers: evil })).status).toBe(
			403
		);
		expect(
			(await SELF.fetch(`${ORIGIN}/rooms/${room}?user=ada&lastUpdated`, { headers: evil })).status
		).toBe(403);
		expect(
			(
				await SELF.fetch(`${ORIGIN}/rooms/${room}?user=ada&lastUpdated`, {
					headers: { Origin: ORIGIN }
				})
			).status
		).toBe(200);
	});
});
