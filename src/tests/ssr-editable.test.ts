/**
 * The getting-started pages mount `<Edytor>` in any route, server-rendered
 * or not, with no mounted flag: an editable view renders its `value` on the
 * server as an editable tree; one given a room renders its `snapshot` (or
 * nothing) and leaves its provider to the browser.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Edytor from '$lib/components/Edytor.svelte';
import { createCodePlugin, createTablePlugin } from '$lib/index.js';

const value = {
	children: [
		{ type: 'heading', data: { level: 'h1' }, content: [{ text: 'Meeting notes' }] },
		{ type: 'paragraph', content: [{ text: 'server text' }] }
	]
};

describe('the server render of an editable <Edytor>', () => {
	it('renders with no props', () => {
		expect(render(Edytor).body).toContain('data-edytor');
	});
	it('renders its value, editable, with a plugin added', () => {
		for (const plugins of [[createTablePlugin()], [createCodePlugin()]]) {
			const { body } = render(Edytor, { props: { value, plugins } });
			expect(body).toContain('server text');
			expect(body).toContain('contenteditable="true"');
		}
	});
	it('with a room, renders its snapshot (or nothing) and opens no provider, with no guard', () => {
		// The provider (IndexedDB, the socket) attaches in the browser only.
		const props = { value, plugins: [createCodePlugin()], room: 'notes' };
		expect(render(Edytor, { props }).body).not.toContain('server text');
		const snapshot = { children: [{ type: 'paragraph', content: [{ text: 'snapshot text' }] }] };
		for (const server of [undefined, 'wss://rooms.test/rooms']) {
			const { body } = render(Edytor, { props: { ...props, server, snapshot } });
			expect(body).toContain('snapshot text');
			expect(body).toContain('data-edytor-snapshot');
		}
	});
});
