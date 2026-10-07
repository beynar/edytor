/**
 * DR-sync-2: the server render of `<Edytor server room>` builds no
 * provider (it never dials), so a room id `createWebsocketSync` would
 * throw for (`.`, over 256 characters) never throws there. A readonly
 * view is a live viewer (D3): like an editable one it waits for its sync
 * on the client, so the server renders its `snapshot`, never its `value`
 * (the room's content would replace it at hydration).
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Edytor from '$lib/components/Edytor.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';

const value = { children: [{ type: 'paragraph', content: [{ text: 'seed value' }] }] };
const snapshot = { children: [{ type: 'paragraph', content: [{ text: 'room snapshot' }] }] };

describe('the server render of <Edytor server room> (DR-sync-2)', () => {
	for (const room of ['.', 'x'.repeat(300), 'doc-1']) {
		for (const readonly of [true, false]) {
			it(`${room.length > 8 ? `${room.length} characters` : room}, ${readonly ? 'readonly' : 'editable'}: renders without a provider`, () => {
				const props = {
					plugins: [richTextPlugin],
					server: 'ws://rooms.test/rooms',
					room,
					readonly,
					value
				};
				// Both wait for their sync, on the client.
				expect(render(Edytor, { props }).body).not.toContain('seed value');
				const { body } = render(Edytor, { props: { ...props, snapshot } });
				expect(body).toContain('room snapshot');
				expect(body).not.toContain('seed value');
			});
		}
	}
});
