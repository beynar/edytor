import { createMarkdownShortcutsPlugin, type JSONDoc } from 'edytor';
import { codePlugin } from '../../chrome/plugins';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [{ text: 'Type a prefix at the start of an empty line below, or close a marker such as **bold**.' }]
		},
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	plugins: () => [createMarkdownShortcutsPlugin(), codePlugin, ...basePlugins()]
} satisfies PluginDemo;
