/**
 * A re-seed on the component path (`room.reseed.protocol`): the room closes
 * the socket `4410` (the new epoch its reason), a refusal of the document.
 *
 * - `<Edytor server room>` owns its document: it builds itself again on a
 *   new one (a new view, a new document, a new dial naming none of the old
 *   epoch's content: `epoch=new`), and `onSyncRefused` hears the `4410`;
 * - with an app's `document`, the view does not: the app hears it and
 *   builds a new one.
 *
 * The sockets are stubs: `refuse(url, n)` names the close code the `n`th
 * dial gets after its first frame (none: it stays open and silent).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';

import Edytor from '$lib/components/EdytorRoot.svelte';
import RootViews from '../../../dom/RootViews.svelte';
import type { EdytorContext } from '$lib/components/Edytor.svelte';
import { createDocument, SyncRefusedError } from '$lib/crdt/index.js';
import type { EdytorSync } from '$lib/collaboration/index.js';
import { richTextPlugin } from '$registry/edytor/chrome/plugins.js';

const dials: string[] = [];
let refuse: (url: string, n: number) => [number, string] | undefined = () => undefined;

class StubSocket {
	static OPEN = 1;
	OPEN = 1;
	readyState = 0;
	binaryType = '';
	onopen: ((event: unknown) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessage: ((event: unknown) => void) | null = null;
	readonly n: number;
	constructor(readonly url: string) {
		this.n = dials.push(url);
		setTimeout(() => {
			if (this.readyState !== 0) return;
			this.readyState = 1;
			this.onopen?.({});
		});
	}
	send() {
		const closing = refuse(this.url, this.n);
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

describe('a re-seed (4410) on <Edytor>', () => {
	it('the view built again waits for the room: it never seeds its value over it', async () => {
		globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;
		refuse = (_url, n) => (n === 1 ? [4410, '1'] : undefined);
		const views: EdytorContext[] = [];
		const view = render(RootViews, {
			props: {
				plugins: [richTextPlugin],
				server: 'ws://rooms.test/rooms',
				room: 'doc-rebuilt',
				value: { children: [{ type: 'paragraph', content: [{ text: 'local seed' }] }] },
				onView: (edytor: EdytorContext) => views.push(edytor)
			}
		});
		await waitFor(() => expect(views).toHaveLength(2));
		// A seed of the value would write under the epoch it was first seeded in (`room.reseed.protocol`).
		expect(views.map((v) => v.document.requireHydration)).toEqual([false, true]);
		view.unmount();
	});

	it('a view that owns its document builds itself again on a new one, and dials again', async () => {
		globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;
		refuse = (_url, n) => (n === 1 ? [4410, '1'] : undefined);
		const deleted: string[] = [];
		const deleteDatabase = indexedDB.deleteDatabase.bind(indexedDB);
		indexedDB.deleteDatabase = (name: string) => (deleted.push(name), deleteDatabase(name));
		const refusals: SyncRefusedError[] = [];
		const view = render(Edytor, {
			props: {
				plugins: [richTextPlugin],
				server: 'ws://rooms.test/rooms',
				room: 'doc-reseeded',
				onSyncRefused: (refusal: SyncRefusedError) => refusals.push(refusal)
			}
		});
		await waitFor(() => expect(dials).toHaveLength(2));
		expect(refusals.map((refusal) => [refusal.code, refusal.reason])).toEqual([[4410, '1']]);
		// Its local copy is deleted, and the new view's document holds nothing yet: it names no epoch of its own.
		expect(deleted).toEqual([
			expect.stringMatching(/edytor:ws:\/\/rooms\.test\/rooms\/doc-reseeded$/)
		]);
		expect(dials[1]).toMatch(/epoch=new/);
		indexedDB.deleteDatabase = deleteDatabase;
		view.unmount();
	});

	it("with the app's document, the view does not build itself again: the app hears it", async () => {
		const document = createDocument();
		let failed: ((error: unknown, provider: unknown) => void) | undefined;
		document.attachSync(
			Object.assign(
				(payload: Parameters<EdytorSync>[0]) => {
					failed = payload.failed;
					return () => {};
				},
				{ bound: Infinity }
			)
		);
		const refusals: number[] = [];
		const view = render(Edytor, {
			props: {
				document,
				plugins: [richTextPlugin],
				onSyncRefused: (refusal: SyncRefusedError) => refusals.push(refusal.code)
			}
		});
		await tick();
		failed?.(new SyncRefusedError(4410, '1'), null);
		await tick();
		expect(refusals).toEqual([4410]);
		expect(document.syncRefusal?.code).toBe(4410);
		view.unmount();
		document.destroy();
	});
});
