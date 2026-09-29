/**
 * What the websocket provider counts as unsaved (FW-07, SW-collab-1): the
 * writes of the document's actor, recognized through the actor dictionary
 * (`c/<client>` → actor id), plus seeds; never another actor's content nor
 * the dictionary records themselves.
 *
 * The room is simulated by acknowledgements (`_writes.acknowledge`) carrying the
 * state vector of a room document, as a `messageSaved` frame does. Bob's
 * reload is a fresh document whose local copy is replayed after the
 * provider started, under a foreign origin (the store's).
 */
// @ts-nocheck -- tests reach raw provider internals (excluded lane).
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { createDocument } from '../../../lib/crdt/index.js';
import { bindProviders } from '../../../lib/crdt/providers/index.js';

const providers = bindProviders(Y);
const STORE = { store: true };
const value = { children: [{ type: 'paragraph', id: 'p', content: [{ text: 'seed' }] }] };

/** A provider that never dials: acknowledgements are fed by hand. */
const offline = (doc) =>
	new providers.WebsocketProvider('ws://saved-own.test', 'room', doc, {
		connect: false,
		disableBc: true
	});
const exchange = (from, to) => Y.applyUpdate(to.doc, from.encode(), 'remote');
const ack = (provider, roomDoc) => provider._writes.acknowledge(Y.encodeStateVector(roomDoc));

describe('saved counts the actor’s own writes', () => {
	it("after a reload, a peer's lost text and its deletion never hold saved", () => {
		// The room holds the seed and Bob's session; Ada's text, and her
		// deletion of part of it, only reached Bob before the room lost them.
		const bob = createDocument({ value, actor: { id: 'bob' } });
		const room = new Y.Doc();
		Y.applyUpdate(room, bob.encode());
		const ada = createDocument({ actor: { id: 'ada' } });
		exchange(bob, ada);
		ada.sync();
		const heard = [];
		ada.doc.on('update', (update) => heard.push(update));
		ada.transact(() => ada.facade.insertText('p', 4, ' ada'));
		ada.transact(() => ada.facade.deleteText('p', 4, 2));
		expect(Y.decodeUpdate(heard.at(-1)).structs).toEqual([]); // delete-only

		// Bob reloads: his local copy replays his state, then Ada's two updates.
		const reloaded = createDocument({ actor: { id: 'bob' } });
		const provider = offline(reloaded.doc);
		Y.applyUpdate(reloaded.doc, bob.encode(), STORE);
		for (const update of heard) Y.applyUpdate(reloaded.doc, update, STORE);
		expect(reloaded.facade.blockText('p')).toBe('seedda');
		ack(provider, room);
		expect([provider.saved, provider.unsaved]).toEqual([true, 0]);
		provider.destroy();
		for (const document of [bob, ada, reloaded]) document.destroy();
	});

	it('after a reload, the actor’s own offline edit counts until the room holds it', () => {
		const bob = createDocument({ value, actor: { id: 'bob' } });
		const room = new Y.Doc();
		Y.applyUpdate(room, bob.encode());
		bob.transact(() => bob.facade.insertText('p', 4, ' offline'));
		const copy = bob.encode();

		const reloaded = createDocument({ actor: { id: 'bob' } });
		const provider = offline(reloaded.doc);
		Y.applyUpdate(reloaded.doc, copy, STORE);
		ack(provider, room);
		expect([provider.saved, provider.unsaved]).toEqual([false, 1]);
		Y.applyUpdate(room, copy);
		ack(provider, room);
		expect([provider.saved, provider.unsaved]).toEqual([true, 0]);
		provider.destroy();
		for (const document of [bob, reloaded]) document.destroy();
	});

	it("a document's actor record alone is not unsaved; a local seed is", () => {
		const viewer = createDocument({ actor: { id: 'viv' } });
		const provider = offline(viewer.doc);
		expect([provider.saved, provider.unsaved]).toEqual([true, 0]);
		provider.destroy();
		viewer.destroy();

		const seeded = createDocument({ value, actor: { id: 'sam' } });
		const seededProvider = offline(seeded.doc);
		expect([seededProvider.saved, seededProvider.unsaved]).toEqual([false, 1]);
		seededProvider.destroy();
		seeded.destroy();
	});

	it('an earlier session’s actor record replayed from the local copy is not unsaved (SW7)', () => {
		// The previous session held a room document it only read, and its record.
		const room = createDocument({ value, actor: { id: 'ada' } });
		const before = createDocument({ actor: { id: 'viv' } });
		exchange(room, before);
		before.sync();
		const copy = before.encode();

		const reloaded = createDocument({ actor: { id: 'viv' } });
		const provider = offline(reloaded.doc);
		Y.applyUpdate(reloaded.doc, copy, STORE);
		expect(reloaded.facade.blockText('p')).toBe('seed');
		// The seed counts until the room covers it; the record never does.
		ack(provider, room.doc);
		expect([provider.saved, provider.unsaved]).toEqual([true, 0]);
		provider.destroy();
		for (const document of [room, before, reloaded]) document.destroy();
	});

	it('a bare engine doc, with no actor binding, counts everything it holds', () => {
		const source = createDocument({ value, actor: { id: 'ada' } });
		const doc = new Y.Doc();
		Y.applyUpdate(doc, source.encode());
		const provider = offline(doc);
		expect(provider.saved).toBe(false);
		ack(provider, new Y.Doc());
		expect(provider.saved).toBe(false);
		provider.destroy();
		source.destroy();
	});
});
