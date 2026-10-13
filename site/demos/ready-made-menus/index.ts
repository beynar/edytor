import { richTextPlaceholder, type JSONDoc } from 'edytor';
import {
	blockHandlesPlugin,
	blockMenuPlugin,
	calloutIconsPlugin,
	codePlugin,
	imageToolbarPlugin,
	mediaEmptyPlugin,
	richTextPlugin,
	slashMenuPlugin,
	toolbarPlugin
} from 'edytor/starter';
import type { PluginDemo } from '../types';

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [
				{ text: 'Select text for the toolbar, hover a block for its handles, or type ' },
				{ text: '/', marks: { code: true } },
				{ text: ' on an empty line.' }
			]
		},
		{
			id: 'tip',
			type: 'callout',
			data: { icon: '💡' },
			content: [{ text: 'Tip' }],
			children: [
				{ id: 'tip-1', type: 'paragraph', content: [{ text: 'Click the icon to pick another one.' }] }
			]
		},
		{
			id: 'code',
			type: 'code',
			data: { language: 'typescript' },
			content: [{ text: '' }],
			children: [{ id: 'code-1', type: 'codeLine', content: [{ text: "const menus = 'ready-made';" }] }]
		},
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

// The plugins of the page's NotionEditor.svelte, with Notion's hints in empty blocks.
export default {
	value,
	plugins: () => [
		() => ({ placeholder: richTextPlaceholder }),
		slashMenuPlugin,
		toolbarPlugin,
		blockHandlesPlugin,
		blockMenuPlugin,
		codePlugin,
		imageToolbarPlugin,
		mediaEmptyPlugin,
		calloutIconsPlugin,
		richTextPlugin
	]
} satisfies PluginDemo;
