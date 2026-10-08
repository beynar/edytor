/**
 * Independent review 2026-09-29 — the real room's boundaries (workerd,
 * SQLite). The first three rows are the reviewer's reproductions, kept
 * verbatim as regression rows; the rest are the variants added with the
 * fixes: a failed append with a peer connected, a pending forgery the room
 * never serves, and an offline deletion-only undo (no clock advances)
 * saved only once the room stores it.
 */
import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import {
	E,
	Y,
	crdt,
	RawClient,
	SelfWebSocket,
	ORIGIN,
	para,
	readFacade,
	storedUpdate
} from './client';

/** The schema version of an engine doc (typed through the facade's parameter). */
const versionOf = (doc: unknown) => E.schemaVersion(doc as Parameters<typeof E.schemaVersion>[0]);

describe('independent review: real room boundaries', () => {
	it('out-of-order schema forgery is not stored or able to poison restart', async () => {
		const room = 'review-pending-schema';
		const stub = env.ROOM.getByName(room);
		const writer = E.createDocument({ value: { children: [para('p', 'hello')] } });
		const initial = writer.encode();
		let forged: Uint8Array = new Uint8Array();
		writer.doc.once('update', (u: Uint8Array) => {
			forged = u;
		});
		writer.doc.get('meta').setAttr('v', 99);
		const socket = await RawClient.bare(room, { user: 'writer' });
		socket.send(E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, forged)));
		await vi.waitFor(() => expect(socket.acks.length).toBeGreaterThan(0));
		socket.send(E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, initial)));
		await vi.waitFor(async () =>
			expect(await runInDurableObject(stub, (r: Room) => r.records().length)).toBeGreaterThan(1)
		);
		const beforeRestart = await runInDurableObject(stub, (r: Room) => {
			const stored = crdt.createDoc();
			Y.applyUpdate(stored, storedUpdate(r.records()));
			return {
				live: r.doc && versionOf(r.doc),
				stored: versionOf(stored),
				refusals: r.refusals
			};
		});
		socket.close();
		writer.destroy();
		await evictDurableObject(stub);
		const afterRestart = await runInDurableObject(stub, (r: Room) => ({
			hasDocument: r.doc !== null,
			failure: r.failure?.message
		}));
		expect(
			{ beforeRestart, afterRestart },
			JSON.stringify({ beforeRestart, afterRestart })
		).toMatchObject({
			beforeRestart: { live: E.SCHEMA_VERSION, stored: E.SCHEMA_VERSION },
			afterRestart: { hasDocument: true }
		});
	});

	it('an offline undo is unsaved while SQLite still holds the pre-undo text', async () => {
		const room = 'review-delete-ack';
		const document = E.createDocument({
			value: { children: [para('p', 'hello')] },
			history: { captureTimeout: 0 }
		});
		const provider = new crdt.providers.WebsocketProvider(
			`${ORIGIN.replace('https', 'wss')}/rooms`,
			room,
			document.doc,
			{
				awareness: document.awareness,
				WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
				disableBc: true
			}
		);
		await vi.waitFor(() => expect(provider.saved).toBe(true));
		document.transact(() => document.facade.insertText('p', 5, '!'));
		await vi.waitFor(() => expect(provider.saved).toBe(true));
		provider.disconnect();
		document.history.undo();
		const observed = {
			local: document.facade.blockText('p'),
			saved: provider.saved,
			unsaved: provider.unsaved,
			server: await runInDurableObject(env.ROOM.getByName(room), (r: Room) =>
				readFacade(r.doc!, (f) => f.blockText('p'))
			)
		};
		provider.destroy();
		document.destroy();
		expect(observed, JSON.stringify(observed)).toEqual({
			local: 'hello',
			server: 'hello!',
			saved: false,
			unsaved: 1
		});
	});

	it('a failed SQLite append cannot subsequently be acknowledged as durable', async () => {
		const room = 'review-store-failure';
		const stub = env.ROOM.getByName(room);
		const document = E.createDocument({ value: { children: [para('p', 'hello')] } });
		const author = await RawClient.connect(room, document.doc);
		await vi.waitFor(() => expect(author.stored()).toBe(true));
		await vi.waitFor(async () =>
			expect(
				await runInDurableObject(stub, (r: Room) => readFacade(r.doc!, (f) => f.blockText('p')))
			).toBe('hello')
		);
		await runInDurableObject(stub, (_r: Room, state) =>
			state.storage.sql.exec(
				"CREATE TRIGGER review_fail_append BEFORE INSERT ON rows WHEN NEW.kind = 'update' BEGIN SELECT RAISE(ABORT, 'review injected storage failure'); END"
			)
		);
		document.transact(() => document.facade.insertText('p', 5, '!'));
		await vi.waitFor(() => expect(author.closed).not.toBeNull());
		const afterFailure = await runInDurableObject(stub, (r: Room, state) => {
			const stored = crdt.createDoc();
			Y.applyUpdate(stored, storedUpdate(r.records()));
			const observed = {
				live: readFacade(r.doc!, (f) => f.blockText('p')),
				stored: readFacade(stored, (f) => f.blockText('p'))
			};
			state.storage.sql.exec('DROP TRIGGER review_fail_append');
			return observed;
		});
		const reconnect = await RawClient.connect(room, document.doc);
		await vi.waitFor(() => expect(reconnect.stored()).toBe(true));
		const afterReconnect = await runInDurableObject(stub, (r: Room) => {
			const stored = crdt.createDoc();
			Y.applyUpdate(stored, storedUpdate(r.records()));
			return readFacade(stored, (f) => f.blockText('p'));
		});
		const clock = Y.decodeStateVector(Y.encodeStateVector(document.doc)).get(document.doc.clientID);
		const acknowledgedClock = reconnect.acks.at(-1)?.get(document.doc.clientID);
		reconnect.close();
		document.destroy();
		await evictDurableObject(stub);
		const afterRestart = await runInDurableObject(stub, (r: Room) =>
			readFacade(r.doc!, (f) => f.blockText('p'))
		);
		const observed = { afterFailure, afterReconnect, afterRestart, clock, acknowledgedClock };
		expect(observed, JSON.stringify(observed)).toMatchObject({
			afterReconnect: 'hello!',
			afterRestart: 'hello!'
		});
	});

	const storedText = (r: Room) => {
		const stored = crdt.createDoc();
		Y.applyUpdate(stored, storedUpdate(r.records()));
		return readFacade(stored, (f) => f.blockText('p'));
	};

	it('a failed append with a peer connected: the peer never receives it or an ack covering it; the resend reaches both', async () => {
		const room = 'review-store-failure-peer';
		const stub = env.ROOM.getByName(room);
		const document = E.createDocument({ value: { children: [para('p', 'hello')] } });
		const author = await RawClient.connect(room, document.doc);
		await vi.waitFor(() => expect(author.stored()).toBe(true));
		const peer = await RawClient.connect(room);
		await vi.waitFor(() => expect(readFacade(peer.doc, (f) => f.blockText('p'))).toBe('hello'));
		await runInDurableObject(stub, (_r: Room, state) =>
			state.storage.sql.exec(
				"CREATE TRIGGER review_fail_append BEFORE INSERT ON rows WHEN NEW.kind = 'update' BEGIN SELECT RAISE(ABORT, 'review injected storage failure'); END"
			)
		);
		document.transact(() => document.facade.insertText('p', 5, '!'));
		const own = document.doc.clientID;
		const clock = Y.decodeStateVector(Y.encodeStateVector(document.doc)).get(own)!;
		await vi.waitFor(() => expect(author.closed).not.toBeNull());
		// The peer asks for an acknowledgement: it must not cover the unstored edit.
		const acks = peer.acks.length;
		peer.send(E.frame(E.messageSync, (e) => crdt.sync.writeSyncStep1(e, peer.doc)));
		await vi.waitFor(() => expect(peer.acks.length).toBeGreaterThan(acks));
		const afterFailure = {
			closed: author.closed?.code,
			peer: readFacade(peer.doc, (f) => f.blockText('p')),
			peerAckCovers: (peer.acks.at(-1)?.get(own) ?? 0) >= clock,
			room: await runInDurableObject(stub, (r: Room, state) => {
				const observed = {
					live: readFacade(r.doc!, (f) => f.blockText('p')),
					stored: storedText(r),
					refusals: r.refusals.map((x) => x.reason)
				};
				state.storage.sql.exec('DROP TRIGGER review_fail_append');
				return observed;
			})
		};
		const reconnect = await RawClient.connect(room, document.doc);
		await vi.waitFor(() => expect(reconnect.acks.at(-1)?.get(own)).toBe(clock));
		await vi.waitFor(() => expect(readFacade(peer.doc, (f) => f.blockText('p'))).toBe('hello!'));
		const afterResend = await runInDurableObject(stub, (r: Room) => storedText(r));
		reconnect.close();
		peer.close();
		document.destroy();
		await evictDurableObject(stub);
		const afterRestart = await runInDurableObject(stub, (r: Room) =>
			readFacade(r.doc!, (f) => f.blockText('p'))
		);
		const observed = { afterFailure, afterResend, afterRestart };
		expect(observed, JSON.stringify(observed)).toEqual({
			afterFailure: {
				closed: 1011,
				peer: 'hello',
				peerAckCovers: false,
				room: { live: 'hello', stored: 'hello', refusals: ['storage'] }
			},
			afterResend: 'hello!',
			afterRestart: 'hello!'
		});
	});

	it('a pending forgery is never served: a joiner holding its origin syncs, and the forgery is discarded', async () => {
		const room = 'review-pending-served';
		const stub = env.ROOM.getByName(room);
		const author = E.createDocument({ value: { children: [para('p', 'hello')] } });
		const initial = author.encode();
		const seeder = await RawClient.connect(room, author.doc);
		await vi.waitFor(() => expect(seeder.stored()).toBe(true));
		// The forger rewrites the stamp (same value), then forges it over that rewrite.
		const writer = crdt.createDoc();
		Y.applyUpdate(writer, initial);
		const updates: Uint8Array[] = [];
		writer.on('update', (u: Uint8Array) => updates.push(u));
		writer.get('meta').setAttr('v', E.SCHEMA_VERSION);
		writer.get('meta').setAttr('v', 99);
		const [rewrite, forged] = updates;
		const socket = await RawClient.bare(room, { user: 'writer' });
		socket.send(E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, forged)));
		await vi.waitFor(() => expect(socket.acks.length).toBeGreaterThan(0));
		// A joiner that holds the rewrite (the forgery's origin) dials: the
		// room's Step2 must not carry the pending forgery (the joiner would
		// refuse it), and the joiner's own Step2 releases it — discarded.
		const joinerDoc = crdt.createDoc();
		Y.applyUpdate(joinerDoc, initial);
		Y.applyUpdate(joinerDoc, rewrite);
		const joiner = await RawClient.connect(room, joinerDoc, { user: 'writer' });
		await vi.waitFor(() => expect(joiner.synced).toBe(true));
		await vi.waitFor(() => expect(joiner.acks.length).toBeGreaterThan(1));
		const beforeRestart = await runInDurableObject(stub, (r: Room) => {
			const stored = crdt.createDoc();
			Y.applyUpdate(stored, storedUpdate(r.records()));
			return {
				live: r.doc && versionOf(r.doc),
				stored: versionOf(stored),
				pending: r.doc?.store.pendingStructs !== null,
				discarded: r.refusals.some(
					(x) => x.reason === 'schema' && (x.detail as { discarded?: unknown }).discarded
				)
			};
		});
		const joinerVersion = versionOf(joiner.doc);
		for (const client of [seeder, socket, joiner]) client.close();
		author.destroy();
		writer.destroy();
		await evictDurableObject(stub);
		const afterRestart = await runInDurableObject(stub, (r: Room) => ({
			version: r.doc && versionOf(r.doc),
			text: r.doc && readFacade(r.doc, (f) => f.blockText('p'))
		}));
		const observed = { beforeRestart, joinerVersion, afterRestart };
		expect(observed, JSON.stringify(observed)).toEqual({
			beforeRestart: {
				live: E.SCHEMA_VERSION,
				stored: E.SCHEMA_VERSION,
				pending: false,
				discarded: true
			},
			joinerVersion: E.SCHEMA_VERSION,
			afterRestart: { version: E.SCHEMA_VERSION, text: 'hello' }
		});
	});

	it('an offline block-deletion undo (no clock advances) is unsaved until the room stores it; it survives a restart', async () => {
		const room = 'review-delete-only-undo';
		const stub = env.ROOM.getByName(room);
		const document = E.createDocument({
			value: { children: [para('p', 'hello'), para('q', 'bye')] },
			history: { captureTimeout: 0 }
		});
		const provider = new crdt.providers.WebsocketProvider(
			`${ORIGIN.replace('https', 'wss')}/rooms`,
			room,
			document.doc,
			{
				awareness: document.awareness,
				WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
				disableBc: true
			}
		);
		const serverHas = (id: string) =>
			runInDurableObject(stub, (r: Room) => readFacade(r.doc!, (f) => f.isVisibleBlock(id)));
		await vi.waitFor(() => expect(provider.saved).toBe(true));
		document.transact(() => document.facade.deleteBlock('q'));
		await vi.waitFor(() => expect(provider.saved).toBe(true));
		expect(await serverHas('q')).toBe(false);
		provider.disconnect();
		const vector = Array.from(Y.encodeStateVector(document.doc)).join();
		document.history.undo();
		const offline = {
			local: document.facade.isVisibleBlock('q'),
			vectorUnchanged: Array.from(Y.encodeStateVector(document.doc)).join() === vector,
			saved: provider.saved,
			unsaved: provider.unsaved,
			server: await serverHas('q')
		};
		provider.connect();
		await vi.waitFor(() => expect(provider.saved).toBe(true));
		const online = { server: await serverHas('q') };
		provider.destroy();
		document.destroy();
		await evictDurableObject(stub);
		const afterRestart = await serverHas('q');
		const observed = { offline, online, afterRestart };
		expect(observed, JSON.stringify(observed)).toEqual({
			offline: { local: true, vectorUnchanged: true, saved: false, unsaved: 1, server: false },
			online: { server: true },
			afterRestart: true
		});
	});
});
