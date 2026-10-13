import type { JSONDoc } from 'edytor';
import { embedPlugin, mediaEmptyPlugin } from '../../chrome/plugins';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import EmbedEditor from './EmbedEditor.svelte';

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [{ text: 'A link an allowed provider plays becomes a player, any other link stays a link.' }]
		},
		{ id: 'video', type: 'embed', data: { url: 'https://youtu.be/dQw4w9WgXcQ' }, content: [{ text: 'An allowed provider, in a sandboxed frame.' }] },
		{ id: 'other', type: 'embed', data: { url: 'https://example.com/articles/hello' }, content: [{ text: 'No provider plays this one.' }] },
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	plugins: () => [embedPlugin, mediaEmptyPlugin, ...basePlugins()],
	custom: EmbedEditor,
	customPlugins: () => [mediaEmptyPlugin, ...basePlugins()]
} satisfies PluginDemo;
