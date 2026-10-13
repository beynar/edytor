import { render } from 'svelte/server';
import { StarterEditor } from 'edytor/starter';

/** SSR entry: the packed starter editor renders its page and its blocks on the server. */
export const html = render(StarterEditor, {
	props: {
		value: {
			data: { title: 'Starter on the server', properties: { status: 'done' } },
			children: [{ type: 'paragraph', content: [{ text: 'starter body' }] }]
		},
		properties: [{ id: 'status', name: 'Status', type: 'select', options: [{ value: 'done' }] }]
	}
}).body;
