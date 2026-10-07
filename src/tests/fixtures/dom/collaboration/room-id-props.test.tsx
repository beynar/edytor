/**
 * DR-sync-2: `<Edytor server room>` with a room id no dial can carry (`.`,
 * `..`, empty, over 256 characters). `createWebsocketSync` throws for it,
 * but the view never does:
 *
 * a view, editable or readonly (a live viewer, D3), reports the id
 * through `onSyncRefused` as the room's router would (`4400 invalid
 * document id`), without dialing; its empty document stays pending, and
 * its local copy is still kept.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';

import Edytor from '$lib/components/Edytor.svelte';
import { SyncRefusedError } from '$lib/crdt/index.js';
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

const realWebSocket = globalThis.WebSocket;
afterEach(() => {
	globalThis.WebSocket = realWebSocket;
	dials.length = 0;
});

const server = 'ws://rooms.test/rooms';
const value = { children: [{ type: 'paragraph', content: [{ text: 'preview' }] }] };
const databases = async () => (await indexedDB.databases()).map((db) => db.name);

describe('<Edytor server room> with an id no dial can carry (DR-sync-2)', () => {
	for (const room of ['.', 'x'.repeat(300)]) {
		const label = room.length > 8 ? `${room.length} characters` : JSON.stringify(room);

		for (const readonly of [false, true])
			it(`${readonly ? 'readonly' : 'editable'}, ${label}: refused 4400 through onSyncRefused, no dial`, async () => {
				globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;
				const refusals: SyncRefusedError[] = [];
				const view = render(Edytor, {
					props: {
						plugins: [richTextPlugin],
						readonly,
						server,
						room,
						value,
						onSyncRefused: (refusal: SyncRefusedError) => refusals.push(refusal)
					}
				});
				await tick();
				expect(refusals.map(({ code, reason }) => [code, reason])).toEqual([
					[4400, 'invalid document id']
				]);
				expect(refusals[0]).toBeInstanceOf(SyncRefusedError);
				await waitFor(async () =>
					expect(await databases()).toContain(`edytor-v14-g5:edytor:${server}/${room}`)
				);
				// The refused, empty document is not seeded.
				expect(view.container.querySelector('[data-edytor]')).toBeNull();
				expect(dials).toEqual([]);
				view.unmount();
			});
	}
});
