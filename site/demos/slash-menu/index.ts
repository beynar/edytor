import type { JSONDoc } from 'edytor';
import { slashMenuPlugin } from '../../chrome/plugins';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import SlashEditor from './SlashEditor.svelte';

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [
				{ text: 'Type ' },
				{ text: '/', marks: { code: true } },
				{ text: ' on the empty line below, then ' },
				{ text: 'h2', marks: { code: true } },
				{ text: ' or ' },
				{ text: 'todo', marks: { code: true } },
				{ text: ' to filter.' }
			]
		},
		{ id: 'empty', type: 'paragraph', content: [{ text: '' }] }
	]
};

/** The editor around the Customize component: base chrome without the stock slash menu. */
const customPlugins = () => basePlugins(slashMenuPlugin);

export default {
	value,
	plugins: () => [...basePlugins()],
	custom: SlashEditor,
	customPlugins
} satisfies PluginDemo;
