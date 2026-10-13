import type { JSONDoc } from 'edytor';
import { findPlugin } from '$registry/edytor/chrome/index.js';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import FindEditor from './FindEditor.svelte';

const value: JSONDoc = {
	children: [
		{ id: 'title', type: 'heading', data: { level: 2 }, content: [{ text: 'Garden notes' }] },
		{
			id: 'p1',
			type: 'paragraph',
			content: [
				{ text: 'The garden is quiet in the morning. A small garden needs water, light and patience.' }
			]
		},
		{
			id: 'p2',
			type: 'paragraph',
			content: [
				{ text: 'Tomatoes love the light, ' },
				{ text: 'basil', marks: { bold: true } },
				{ text: ' loves water, and the garden loves both.' }
			]
		},
		{
			id: 'l1',
			type: 'bulleted-list-item',
			content: [{ text: 'Water the garden before noon' }]
		},
		{
			id: 'l2',
			type: 'bulleted-list-item',
			content: [{ text: 'Move the pots into the light' }]
		},
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	plugins: () => [findPlugin, ...basePlugins()],
	custom: FindEditor
} satisfies PluginDemo;
