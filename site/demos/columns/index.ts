import type { JSONDoc } from 'edytor';
import { createColumnsPlugin } from 'edytor';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import ColumnsEditor from './ColumnsEditor.svelte';

const value: JSONDoc = {
	children: [
		{ id: 'title', type: 'heading', data: { level: 2 }, content: [{ text: 'Trip plan' }] },
		{
			id: 'row',
			type: 'columns',
			children: [
				{
					id: 'left',
					type: 'column',
					data: { width: 2 },
					children: [
						{ id: 'l1', type: 'paragraph', content: [{ text: 'Two thirds wide. Drag the gap to resize.' }] },
						{ id: 'l2', type: 'paragraph', content: [{ text: 'Book the train' }] },
						{ id: 'l3', type: 'paragraph', content: [{ text: 'Pack light' }] }
					]
				},
				{
					id: 'right',
					type: 'column',
					children: [
						{ id: 'r1', type: 'paragraph', content: [{ text: 'One third.' }] },
						{ id: 'r2', type: 'paragraph', content: [{ text: 'Drag a block by its grip to the edge of this one.' }] }
					]
				}
			]
		},
		{ id: 'tail', type: 'paragraph', content: [] }
	]
};

export default {
	value,
	plugins: () => [createColumnsPlugin(), ...basePlugins()],
	custom: ColumnsEditor
} satisfies PluginDemo;
