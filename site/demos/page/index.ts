import { createPagePlugin, type JSONDoc } from 'edytor';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import PageCards from './PageCards.svelte';

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [{ text: 'Subpages are blocks that link to another document:' }]
		},
		{ id: 'roadmap', type: 'page', data: { pageId: 'roadmap', title: 'Roadmap' } },
		{ id: 'notes', type: 'page', data: { pageId: 'notes', title: 'Meeting notes' } },
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

// Opening a page changes nothing outside the editor; a new page is just an id.
const open = () => {};
let created = 0;
const create = () => ({ pageId: `new-${++created}`, title: 'Untitled' });

export default {
	value,
	plugins: () => [createPagePlugin({ open, create }), ...basePlugins()],
	custom: PageCards
} satisfies PluginDemo;

