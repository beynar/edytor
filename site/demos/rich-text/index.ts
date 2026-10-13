import type { JSONDoc } from 'edytor';
import { calloutIconsPlugin, richTextPlugin } from '../../chrome/plugins';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import RichTextEditor from './RichTextEditor.svelte';

const value: JSONDoc = {
	children: [
		{ id: 'title', type: 'heading', data: { level: 'h1' }, content: [{ text: 'Launch week' }] },
		{
			id: 'intro',
			type: 'paragraph',
			content: [
				{ text: 'Select text for ' },
				{ text: 'bold', marks: { bold: true } },
				{ text: ', ' },
				{ text: 'italic', marks: { italic: true } },
				{ text: ' or a ' },
				{ text: 'link', marks: { link: { href: 'https://svelte.dev' } } },
				{ text: ', or type ' },
				{ text: '/', marks: { code: true } },
				{ text: ' for more blocks.' }
			]
		},
		{
			id: 'todo-1',
			type: 'todo-item',
			data: { checked: true },
			content: [{ text: 'Write the announcement' }]
		},
		{
			id: 'todo-2',
			type: 'todo-item',
			data: { checked: false },
			content: [{ text: 'Check the docs links' }]
		},
		{ id: 'b1', type: 'bulleted-list-item', content: [{ text: 'Headings, lists and quotes' }] },
		{ id: 'b2', type: 'bulleted-list-item', content: [{ text: 'Toggles and callouts' }] },
		{
			id: 'toggle',
			type: 'toggle',
			content: [{ text: 'Open this toggle' }],
			children: [{ id: 'toggle-1', type: 'paragraph', content: [{ text: 'Its body holds any blocks.' }] }]
		},
		{ id: 'empty-toggle', type: 'toggle', content: [{ text: 'An empty toggle' }] },
		{
			id: 'callout',
			type: 'callout',
			data: { icon: '💡' },
			content: [{ text: 'Tip' }],
			children: [{ id: 'callout-1', type: 'paragraph', content: [{ text: 'Click the icon to change it.' }] }]
		},
		{ id: 'quote', type: 'quote', content: [{ text: 'Write it down, then make it better.' }] },
		{ id: 'divider', type: 'divider' },
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	plugins: () => [calloutIconsPlugin, ...basePlugins()],
	custom: RichTextEditor,
	// The Customize file lists its own rich text plugin: leave the chrome's out.
	customPlugins: () => [calloutIconsPlugin, ...basePlugins(richTextPlugin)]
} satisfies PluginDemo;
