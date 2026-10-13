import type { JSONDoc } from 'edytor';
import { blockMenu, blockMenuPlugin } from 'edytor/starter';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import MenuEditor from './MenuEditor.svelte';

const value: JSONDoc = {
	children: [
		{ id: 'title', type: 'heading', data: { level: 2 }, content: [{ text: 'Trip notes' }] },
		{
			id: 'intro',
			type: 'paragraph',
			content: [{ text: 'Hover a block and click its ⋮⋮ grip to open its menu.' }]
		},
		{ id: 'todo', type: 'todo', data: { checked: false }, content: [{ text: 'Book the train' }] },
		{ id: 'quote', type: 'quote', content: [{ text: 'Travel light, and write things down.' }] },
		{ id: 'end', type: 'paragraph', content: [{ text: 'Try Turn into, Color or Duplicate here.' }] }
	]
};

/** The editor around the block menu: base chrome without its own block menu. */
const around = () => basePlugins(blockMenuPlugin);

export default {
	value,
	plugins: () => [
		blockMenu({ linkTo: (block) => `${location.origin}${location.pathname}#block-${block.id}` }),
		...around()
	],
	custom: MenuEditor,
	customPlugins: around
} satisfies PluginDemo;
