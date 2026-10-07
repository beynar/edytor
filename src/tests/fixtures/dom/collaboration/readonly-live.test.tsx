/**
 * D3 (WU-11, API-04): a readonly view is a live viewer. `<Edytor readonly>`
 * given `sync`, or `room` and `server`, attaches it as an editable view
 * does: it shows the provider's content and every later peer edit, its
 * readiness waits for the provider as an editable view's does, and
 * flipping `readonly` keeps the connection (one dial, never closed).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';

import Edytor from '$lib/components/Edytor.svelte';
import { createDocument } from '$lib/crdt/index.js';
import { Y } from '$lib/crdt/engine.js';
import type { EdytorSync } from '$lib/collaboration/index.js';
import type { Edytor as EdytorClass } from '$lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';

const dials: string[] = [];
const closed: string[] = [];
class StubSocket {
	static OPEN = 1;
	OPEN = 1;
	readyState = 0;
	binaryType = '';
	constructor(readonly url: string) {
		dials.push(url);
	}
	send() {}
	close() {
		closed.push(this.url);
	}
}

const realWebSocket = globalThis.WebSocket;
afterEach(() => {
	globalThis.WebSocket = realWebSocket;
	dials.length = 0;
	closed.length = 0;
});

/** A sync that links the view's doc to `peer`'s, both ways, then reports synced. */
const linkedTo = (peer: ReturnType<typeof createDocument>, counts = { attach: 0 }): EdytorSync => {
	const link = {};
	return ({ doc, synced }) => {
		counts.attach++;
		const toView = (update: Uint8Array, origin: unknown) => {
			if (origin !== link) Y.applyUpdate(doc, update, link);
		};
		const toPeer = (update: Uint8Array, origin: unknown) => {
			if (origin !== link) Y.applyUpdate(peer.doc, update, link);
		};
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer.doc), link);
		peer.doc.on('update', toView);
		doc.on('update', toPeer);
		synced();
		return () => {
			peer.doc.off('update', toView);
			doc.off('update', toPeer);
		};
	};
};

const textOf = (container: HTMLElement) =>
	container.querySelector('[data-edytor]')?.textContent?.trim();

describe('a readonly view is a live viewer (D3)', () => {
	it('attaches its sync: it shows the provider content and a later peer edit', async () => {
		const peer = createDocument({
			value: { children: [{ type: 'paragraph', id: 'p', content: [{ text: 'shared' }] }] }
		});
		const counts = { attach: 0 };
		const view = render(Edytor, {
			props: {
				plugins: [richTextPlugin],
				readonly: true,
				sync: linkedTo(peer, counts),
				value: { children: [{ type: 'paragraph', content: [{ text: 'fallback' }] }] }
			}
		});
		await tick();
		expect(counts.attach).toBe(1);
		await waitFor(() => expect(textOf(view.container)).toBe('shared'));

		peer.transact(() => peer.facade.insertText('p', 6, ' live'));
		await waitFor(() => expect(textOf(view.container)).toBe('shared live'));
		view.unmount();
		peer.destroy();
	});

	it('server + room: dials the room as an editable view does', async () => {
		globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;
		const view = render(Edytor, {
			props: {
				plugins: [richTextPlugin],
				readonly: true,
				server: 'ws://rooms.test/rooms',
				room: 'doc-ro'
			}
		});
		await waitFor(() => expect(dials.length).toBe(1));
		expect(dials[0]).toMatch(/^ws:\/\/rooms\.test\/rooms\/doc-ro\?replica=\d+$/);
		view.unmount();
	});

	it('flipping readonly keeps the connection, and the view edits what the room sent', async () => {
		globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;
		const peer = createDocument({
			value: { children: [{ type: 'paragraph', id: 'p', content: [{ text: 'shared' }] }] }
		});
		let edytor: EdytorClass | undefined;
		const view = render(Edytor, {
			props: {
				plugins: [richTextPlugin],
				readonly: true,
				sync: linkedTo(peer),
				get edytor() {
					return edytor;
				},
				set edytor(next) {
					edytor = next;
				}
			}
		});
		await waitFor(() => expect(textOf(view.container)).toBe('shared'));
		expect(edytor!.readonly).toBe(true);

		await view.rerender({ readonly: false });
		await tick();
		expect(edytor!.readonly).toBe(false);
		// The provider is the same: a local edit reaches the peer.
		edytor!.root!.children[0]!.firstText!.insertText({ value: '!', start: 6, end: 6 });
		await waitFor(() =>
			expect(peer.facade.toJSON().children[0]?.content).toEqual([{ text: 'shared!' }])
		);

		await view.rerender({ readonly: true });
		await tick();
		peer.transact(() => peer.facade.insertText('p', 0, '> '));
		await waitFor(() => expect(textOf(view.container)).toBe('> shared!'));
		view.unmount();
		peer.destroy();
	});

	it('a room flipped readonly → editable dials once and never closes', async () => {
		globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;
		let edytor: EdytorClass | undefined;
		const view = render(Edytor, {
			props: {
				plugins: [richTextPlugin],
				readonly: true,
				server: 'ws://rooms.test/rooms',
				room: 'doc-flip',
				get edytor() {
					return edytor;
				},
				set edytor(next) {
					edytor = next;
				}
			}
		});
		await waitFor(() => expect(dials.length).toBe(1));
		await view.rerender({ readonly: false });
		await tick();
		await view.rerender({ readonly: true });
		await tick();
		expect(dials.length).toBe(1);
		expect(closed).toEqual([]);
		view.unmount();
	});
});
