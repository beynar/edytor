import type { JSONDoc } from 'edytor';
import { toolbarPlugin } from 'edytor/starter';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import ToolbarEditor from './ToolbarEditor.svelte';

const value: JSONDoc = {
	children: [
		{ id: 'title', type: 'heading', data: { level: 'h2' }, content: [{ text: 'Select some text' }] },
		{
			id: 'intro',
			type: 'paragraph',
			content: [
				{ text: 'Drag over any words to open the toolbar: make them ' },
				{ text: 'bold', marks: { bold: true } },
				{ text: ', turn the block into something else, or color them.' }
			]
		},
		{
			id: 'link',
			type: 'paragraph',
			content: [
				{ text: 'Hover the ' },
				{ text: 'Svelte site', marks: { link: { href: 'https://svelte.dev' } } },
				{ text: ' link for its card, or select a word and press ' },
				{ text: 'Mod+K', marks: { code: true } },
				{ text: ' to link it.' }
			]
		},
		{ id: 'end', type: 'paragraph', content: [{ text: 'Try it on this line, then press Alt+F10 to reach the bar.' }] }
	]
};

export default {
	value,
	plugins: () => [...basePlugins()],
	custom: ToolbarEditor,
	// The Customize file lists its own toolbar plugin: leave the chrome's out.
	customPlugins: () => basePlugins(toolbarPlugin)
} satisfies PluginDemo;
