/**
 * DR-sync-2: the server render of `<Edytor server room>` builds no
 * provider (it never dials), so a room id `createWebsocketSync` would
 * throw for (`.`, over 256 characters) never throws there, and a
 * readonly view renders its `value`.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Edytor from '$lib/components/Edytor.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';

const value = { children: [{ type: 'paragraph', content: [{ text: 'rendered' }] }] };

describe('the server render of <Edytor server room> (DR-sync-2)', () => {
	for (const room of ['.', 'x'.repeat(300), 'doc-1']) {
		for (const readonly of [true, false]) {
			it(`${room.length > 8 ? `${room.length} characters` : room}, ${readonly ? 'readonly' : 'editable'}: renders without a provider`, () => {
				const { body } = render(Edytor, {
					props: {
						plugins: [richTextPlugin],
						server: 'ws://rooms.test/rooms',
						room,
						readonly,
						value
					}
				});
				// A readonly view shows its value; an editable one waits for its sync, on the client.
				if (readonly) expect(body).toContain('rendered');
			});
		}
	}
});
