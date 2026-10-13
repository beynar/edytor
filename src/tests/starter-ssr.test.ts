/**
 * The starter registry item server-renders: the page (cover, icon, title, properties)
 * from its seed, and the blocks, so the hydration draws the same markup
 * (the browser rows check that no hydration warning is logged).
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { StarterEditor } from '$registry/edytor/starter/index.js';

const value = {
	data: {
		title: 'Server title',
		icon: { emoji: '🌱' },
		cover: { url: 'https://example.com/c.jpg', position: 30 },
		properties: { status: 'done' }
	},
	children: [{ type: 'paragraph', content: [{ text: 'server text' }] }]
};
const properties = [
	{ id: 'status', name: 'Status', type: 'select' as const, options: [{ value: 'done' }] }
];

describe('the server render of <StarterEditor>', () => {
	it('renders with no props', () => {
		const { body } = render(StarterEditor);
		expect(body).toContain('data-edytor-starter');
		expect(body).toContain('data-edytor');
	});
	it('renders the page from the value, and the blocks', () => {
		const { body } = render(StarterEditor, { props: { value, properties } });
		expect(body).toContain('Server title');
		expect(body).toContain('🌱');
		expect(body).toContain('https://example.com/c.jpg');
		expect(body).toContain('Status');
		expect(body).toContain('server text');
		// The add and hide controls wait for the live view.
		expect(body).not.toContain('data-edytor-starter-add-cover');
	});
	it('renders a date in the locale, the same text as the browser writes', () => {
		const dated = {
			...value,
			data: { ...value.data, properties: { due: '2026-10-13', later: 'kept' } }
		};
		const schema = [
			{ id: 'due', name: 'Due', type: 'date' as const },
			{ id: 'later', name: 'Later', type: 'text' as const, hidden: true }
		];
		const english = render(StarterEditor, { props: { value: dated, properties: schema } }).body;
		expect(english).toContain('<time datetime="2026-10-13">Oct 13, 2026</time>');
		// The hidden one is under the collapsible, its value kept.
		expect(english).toContain('1 hidden property');
		const french = render(StarterEditor, {
			props: { value: dated, properties: schema, locale: 'fr-FR' }
		}).body;
		expect(french).toContain('13 oct. 2026');
	});
	it('with a room, renders the snapshot page', () => {
		const snapshot = { ...value, data: { title: 'Snapshot title' } };
		const { body } = render(StarterEditor, { props: { room: 'notes', snapshot } });
		expect(body).toContain('Snapshot title');
	});
});
