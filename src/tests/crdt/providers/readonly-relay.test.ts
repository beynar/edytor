/**
 * YW-09 (re-score 5) — a socket the room made read-only gets this
 * document's own edits only (each one is denied). What another tab relayed,
 * what a store (the IndexedDB copy, its channel) applied, and the actor
 * records would draw denials nobody made; a socket that may write gets
 * them all again. Also YW-05: the dial URL carries the room as one encoded
 * path segment.
 */
// @ts-nocheck -- tests reach raw provider internals (excluded lane).
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { createDocument } from '../../../lib/crdt/index.js';
import { bindProviders } from '../../../lib/crdt/providers/index.js';

const providers = bindProviders(Y);
const value = { children: [{ type: 'paragraph', id: 'p', content: [{ text: 'seed' }] }] };

/** A provider whose socket is open and records what it is sent. */
const onSocket = (doc) => {
	const provider = new providers.WebsocketProvider('ws://relay.test', 'room', doc, {
		connect: false,
		disableBc: true
	});
	const sent = [];
	provider.ws = { readyState: 1, OPEN: 1, send: (frame) => sent.push(frame), close() {} };
	provider.wsconnected = true;
	return { provider, sent };
};

describe('a read-only socket', () => {
	it("gets this document's own edits, never what a tab or a store delivered", () => {
		const viewer = createDocument({ value, actor: { id: 'viv' } });
		const peer = createDocument({ actor: { id: 'ada' } });
		Y.applyUpdate(peer.doc, viewer.encode());
		peer.sync();
		const { provider, sent } = onSocket(viewer.doc);
		provider._writes.deny();
		const count = () => sent.length;

		viewer.transact(() => viewer.facade.insertText('p', 0, 'mine '));
		const own = count();
		peer.transact(() => peer.facade.insertText('p', 0, 'tab '));
		Y.applyUpdate(viewer.doc, peer.encode(), provider._fromTab);
		const afterTab = count();
		peer.transact(() => peer.facade.insertText('p', 0, 'store '));
		Y.applyUpdate(viewer.doc, peer.encode(), { store: true });
		const afterStore = count();
		viewer.attribution.setProfile({ name: 'Viv' });
		const afterRecord = count();

		// Granted write: what the stores deliver goes to the socket again.
		provider._writes.allow();
		peer.transact(() => peer.facade.insertText('p', 0, 'later '));
		Y.applyUpdate(viewer.doc, peer.encode(), { store: true });
		expect({ own, afterTab, afterStore, afterRecord, granted: count() }).toEqual({
			own: 1,
			afterTab: 1,
			afterStore: 1,
			afterRecord: 1,
			granted: 2
		});
		provider.destroy();
		viewer.destroy();
		peer.destroy();
	});

	it('dials the room as one encoded path segment', () => {
		const document = createDocument({ value });
		const provider = new providers.WebsocketProvider(
			'wss://h/rooms/',
			'a/b#c?d 100%',
			document.doc,
			{
				connect: false,
				disableBc: true,
				params: { token: 't' }
			}
		);
		expect(provider.url).toBe(
			`wss://h/rooms/a%2Fb%23c%3Fd%20100%25?replica=${document.doc.clientID}&token=t`
		);
		provider.destroy();
		document.destroy();
	});
});
