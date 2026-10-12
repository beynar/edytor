/**
 * The getting-started pages mount `<Edytor>` in any route, server-rendered
 * or not: an editable view renders on the server without throwing, its
 * `value` as an editable tree, and keeps nothing running after the render.
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
});
