/**
 * Refusals and expired credentials on the component path:
 *
 * - RW-05: a view mounted on a document a provider's server refused does
 *   not seed it — the empty document stays `pending`. A document that
 *   already holds content hydrates at the refusal and renders (FW-10).
 * - RW-19: `<Edytor server room params>` reports `4401` through
 *   `onSyncExpired`, so the app refreshes `params` before the redial; and
 *   refusals through `onSyncRefused` (a standing one at mount, then each
 *   new one).
 *
 * The sockets are stubs: `refuse(url)` names the close code a dial gets
 * after its first frame (none: it stays open and silent).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';

import Edytor from '$lib/components/Edytor.svelte';
import ExpiredTokenView from './ExpiredTokenView.svelte';
import { createDocument, SyncRefusedError } from '$lib/crdt/index.js';
import { attachDocument } from '$lib/crdt/document.js';
import { Y } from '$lib/crdt/engine.js';
import type { EdytorSync } from '$lib/collaboration/index.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';

const dials: string[] = [];
let refuse: (url: string) => [number, string] | undefined = () => undefined;

class StubSocket {
	static OPEN = 1;
	OPEN = 1;
	readyState = 0;
	binaryType = '';
	onopen: ((event: unknown) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessage: ((event: unknown) => void) | null = null;
	constructor(readonly url: string) {
		dials.push(url);
		setTimeout(() => {
			if (this.readyState !== 0) return;
			this.readyState = 1;
			this.onopen?.({});
		});
	}
	send() {
		const closing = refuse(this.url);
		if (closing) setTimeout(() => this.close(...closing));
	}
	close(code = 1005, reason = '') {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
}

const realWebSocket = globalThis.WebSocket;
afterEach(() => {
	globalThis.WebSocket = realWebSocket;
	dials.length = 0;
	refuse = () => undefined;
});

/** A provider whose server refused this client at once. */
const refusedSync = (code: number, reason: string): EdytorSync =>
	Object.assign(
		({ failed }: Parameters<EdytorSync>[0]) => {
			failed?.(new SyncRefusedError(code, reason), null);
			return () => {};
		},
		{ bound: Infinity }
	);

describe('a view mounted after a refusal (RW-05)', () => {
	it('does not seed the refused, empty injected document: it stays pending', async () => {
		const document = createDocument();
		document.attachSync(refusedSync(4403, 'document access denied'));
		expect(document.syncRefusal?.code).toBe(4403);
		const view = render(Edytor, {
			props: {
				document,
				plugins: [richTextPlugin],
				value: { children: [{ type: 'paragraph', content: [{ text: 'draft' }] }] }
			}
		});
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(document.readiness).toBe('pending');
		expect(document.raw.isInitialized()).toBe(false);
		expect(view.container.querySelector('[data-edytor]')).toBeNull();
		view.unmount();
		document.destroy();
	});

	it('hydrates a refused document that already holds content, and renders it (FW-10)', async () => {
		const source = createDocument({
			value: { children: [{ type: 'paragraph', content: [{ text: 'stored' }] }] }
		});
		const doc = new Y.Doc();
		Y.applyUpdate(doc, source.encode());
		const document = attachDocument(doc);
		document.attachSync(refusedSync(4403, 'document access denied'));
		expect(document.syncRefusal?.code).toBe(4403);
		expect(document.readiness).toBe('hydrated');
		const view = render(Edytor, {
			props: {
				document,
				plugins: [richTextPlugin],
				value: { children: [{ type: 'paragraph', content: [{ text: 'draft' }] }] }
			}
		});
		await tick();
		expect(view.container.querySelector('[data-edytor]')?.textContent?.trim()).toBe('stored');
		view.unmount();
		document.destroy();
		source.destroy();
	});

	it('onSyncRefused reports the standing refusal at mount', async () => {
		const document = createDocument();
		document.attachSync(refusedSync(4409, 'replica bound to another user'));
		const refusals: SyncRefusedError[] = [];
		const view = render(Edytor, {
			props: {
				document,
				plugins: [richTextPlugin],
				onSyncRefused: (refusal: SyncRefusedError) => refusals.push(refusal)
			}
		});
		await tick();
		expect(refusals.map((refusal) => refusal.code)).toEqual([4409]);
		view.unmount();
		document.destroy();
	});

	it('an onSyncRefused that throws on the standing refusal still receives the later ones (XW-14)', async () => {
		const document = createDocument();
		document.attachSync(refusedSync(4409, 'replica bound to another user'));
		const refusals: number[] = [];
		const logged: unknown[] = [];
		const error = console.error;
		console.error = (...args: unknown[]) => void logged.push(args[0]);
		try {
			const view = render(Edytor, {
				props: {
					document,
					plugins: [richTextPlugin],
					onSyncRefused: (refusal: SyncRefusedError) => {
						refusals.push(refusal.code);
						if (refusal.code === 4409) throw new Error('app bug');
					}
				}
			});
			await tick();
			document.attachSync(refusedSync(4403, 'document access denied'));
			expect(refusals).toEqual([4409, 4403]);
			expect(logged.length).toBe(1);
			view.unmount();
		} finally {
			console.error = error;
			document.destroy();
		}
	});
});

describe('<Edytor server room params> sync events (RW-19)', () => {
	it('onSyncExpired fires on 4401; the refreshed params reach the redial', async () => {
		globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;
		refuse = (url) => (url.includes('token=stale') ? [4401, 'expired'] : undefined);
		const expired: { reason: string; attempts: number; nextRetryMs: number }[] = [];
		const view = render(ExpiredTokenView, {
			props: { expired, getToken: async () => 'fresh' }
		});
		await waitFor(() => expect(dials.length).toBe(2));
		expect(expired).toEqual([{ reason: 'expired', attempts: 1, nextRetryMs: 200 }]);
		expect(dials[0]).toMatch(/token=stale$/);
		expect(dials[1]).toMatch(/token=fresh$/);
		view.unmount();
	});

	it('onSyncRefused fires once when the room refuses the view', async () => {
		globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;
		refuse = () => [4403, 'document access denied'];
		const refusals: SyncRefusedError[] = [];
		const view = render(Edytor, {
			props: {
				plugins: [richTextPlugin],
				server: 'ws://rooms.test/rooms',
				room: 'doc-refused',
				onSyncRefused: (refusal: SyncRefusedError) => refusals.push(refusal)
			}
		});
		await waitFor(() => expect(refusals).toHaveLength(1));
		expect(refusals[0]).toBeInstanceOf(SyncRefusedError);
		expect([refusals[0].code, refusals[0].reason]).toEqual([4403, 'document access denied']);
		expect(dials).toHaveLength(1);
		view.unmount();
	});
});
