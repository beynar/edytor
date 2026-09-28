/**
 * `<Edytor {room} {server} {params} {actor}>` builds its own sync: the
 * websocket room (dialed with the replica and the params) plus a local
 * copy named per author; `room` alone is a local copy only.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/svelte';

import Edytor from '$lib/components/Edytor.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';

const dials: string[] = [];
class StubSocket {
	static OPEN = 1;
	OPEN = 1;
	readyState = 0;
	binaryType = '';
	constructor(url: string) {
		dials.push(url);
	}
	send() {}
	close() {}
}

const databases = async () => (await indexedDB.databases()).map((db) => db.name);
const realWebSocket = globalThis.WebSocket;
afterEach(() => {
	globalThis.WebSocket = realWebSocket;
	dials.length = 0;
});

describe('room props', () => {
	it('server + room: dials the room with replica and params, keeps a per-author local copy', async () => {
		globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;
		const view = render(Edytor, {
			props: {
				plugins: [richTextPlugin],
				actor: { id: 'u1' },
				server: 'ws://rooms.test/rooms',
				room: 'doc-1',
				params: { token: 't1' }
			}
		});
		await waitFor(() => expect(dials.length).toBe(1));
		expect(dials[0]).toMatch(/^ws:\/\/rooms\.test\/rooms\/doc-1\?replica=\d+&token=t1$/);
		await waitFor(async () =>
			expect(await databases()).toContain('edytor-v14:edytor:u1@ws://rooms.test/rooms/doc-1')
		);
		view.unmount();
	});

	it('room alone: a local copy under that name, no socket', async () => {
		globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;
		const view = render(Edytor, { props: { plugins: [richTextPlugin], room: 'notes/today' } });
		await waitFor(async () => expect(await databases()).toContain('edytor-v14:notes/today'));
		expect(dials).toEqual([]);
		view.unmount();
	});
});
