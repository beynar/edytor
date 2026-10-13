import type { JSONDoc } from 'edytor';
import { blockHandlesPlugin } from '../../chrome/plugins';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import HandlesEditor from './HandlesEditor.svelte';

const value: JSONDoc = {
	children: [
		{ id: 'title', type: 'heading', data: { level: 2 }, content: [{ text: 'Trip checklist' }] },
		{ id: 'a', type: 'paragraph', content: [{ text: 'Book the flights and the first night.' }] },
		{ id: 'b', type: 'paragraph', content: [{ text: 'Pack light: one bag, no more.' }] },
		{ id: 'c', type: 'paragraph', content: [{ text: 'Print the tickets, just in case.' }] },
		{ id: 'd', type: 'paragraph', content: [{ text: 'Water the plants before leaving.' }] },
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	plugins: () => [...basePlugins()],
	custom: HandlesEditor,
	// The Customize file lists its own block handles plugin: leave the demo's out.
	customPlugins: () => basePlugins(blockHandlesPlugin)
} satisfies PluginDemo;
