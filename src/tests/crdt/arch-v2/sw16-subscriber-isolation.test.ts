/**
 * SW16-rest-1 — a throwing `facade.onChange` subscriber must not wedge the
 * engine. The change report runs inside the engine's `update` emit, which
 * sits in the transaction cleanup's `finally`: an error escaping it skipped
 * the reset of `_transactionCleanups`, so no later transaction ever ran
 * its cleanup again — no `update` event (nothing sent, nothing stored), no
 * observer, no report, on the client and in the room alike. A subscriber's
 * error is now logged and the other subscribers and the engine carry on.
 *
 * Expected values are hand-authored from the edits each test performs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from '$lib/crdt/vendor/yjs/src/index.js';
import { createDocument, defaultSemantics, loadDocument, SCHEMA_VERSION } from '$lib/crdt/index.js';

const make = () =>
	createDocument({
		value: { children: [{ id: 'p', type: 'paragraph', content: [{ text: 'hi' }] }] },
		semantics: defaultSemantics
	});

afterEach(() => vi.restoreAllMocks());

describe('SW16-rest-1: a throwing onChange subscriber', () => {
	it('is logged; the write returns, and later writes still emit updates and reports', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const document = make();
		const updates: Uint8Array[] = [];
		document.doc.on('update', (u: Uint8Array) => updates.push(u));
		const seen: string[] = [];
		const offBad = document.facade.onChange(() => {
			throw new Error('boom');
		});
		const offGood = document.facade.onChange(() => seen.push(document.facade.blockText('p')));
		expect(() => document.facade.insertText('p', 0, 'A')).not.toThrow();
		offBad();
		document.facade.insertText('p', 0, 'B');
		expect(document.facade.blockText('p')).toBe('BAhi');
		expect(updates.length).toBe(2);
		expect(seen).toEqual(['Ahi', 'BAhi']);
		expect(error).toHaveBeenCalledOnce();
		expect(String(error.mock.calls[0][1])).toBe('Error: boom');
		offGood();
		document.destroy();
	});

	it('a peer still receives every edit made after the throw', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const a = make();
		const b = loadDocument(a.encode(), { semantics: defaultSemantics });
		a.doc.on('update', (u: Uint8Array) => Y.applyUpdate(b.doc as never, u, 'peer'));
		a.facade.onChange(() => {
			throw new Error('boom');
		});
		a.facade.insertText('p', 2, '!');
		a.facade.insertText('p', 3, '?');
		expect(b.facade.blockText('p')).toBe('hi!?');
		a.destroy();
		b.destroy();
	});

	it('an onWritableChange listener that throws is logged too (the same update emit)', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const document = make();
		const live = document.doc as unknown as Y.Doc;
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
		const captured: Uint8Array[] = [];
		peer.on('update', (u: Uint8Array) => captured.push(u));
		peer.transact(() => peer.get('meta').setAttr('v', SCHEMA_VERSION + 90)); // a forged stamp
		peer.transact(() => peer.get('meta').setAttr('v', SCHEMA_VERSION)); // and back
		document.onWritableChange(() => {
			throw new Error('boom');
		});
		const updates: Uint8Array[] = [];
		live.on('update', (u: Uint8Array) => updates.push(u));
		Y.applyUpdate(live, captured[0], 'bypass'); // read-only: the listener throws
		expect(document.writable).toBe(false);
		Y.applyUpdate(live, captured[1], 'bypass'); // writable again
		expect(document.writable).toBe(true);
		expect(updates.length).toBe(2);
		expect(error).toHaveBeenCalledTimes(2);
		document.destroy();
	});
});
