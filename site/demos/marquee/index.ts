import type { JSONDoc } from 'edytor';
import { marqueePlugin } from 'edytor/starter';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import MarqueeEditor from './MarqueeEditor.svelte';

const value: JSONDoc = {
	children: [
		{ id: 'title', type: 'heading', data: { level: 2 }, content: [{ text: 'Trip checklist' }] },
		{
			id: 'intro',
			type: 'paragraph',
			content: [{ text: 'Press in the empty margin beside the blocks and drag across them.' }]
		},
		{ id: 'a', type: 'paragraph', content: [{ text: 'Book the train tickets' }] },
		{ id: 'b', type: 'paragraph', content: [{ text: 'Reserve a table for Friday' }] },
		{ id: 'c', type: 'paragraph', content: [{ text: 'Pack the camera and a charger' }] },
		{ id: 'd', type: 'paragraph', content: [{ text: 'Print the museum pass' }] },
		{ id: 'e', type: 'paragraph', content: [{ text: 'Check the weather the night before' }] },
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	plugins: () => [marqueePlugin, ...basePlugins()],
	custom: MarqueeEditor
} satisfies PluginDemo;
