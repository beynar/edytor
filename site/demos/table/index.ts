import { tableBlock, type JSONDoc } from 'edytor';
import { tablePlugin } from '../../chrome/plugins';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import TableEditor from './TableEditor.svelte';

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [{ text: 'A small team, in a table. Hover it to reach the grips and the + bars.' }]
		},
		{
			...tableBlock({
				cells: [
					['Name', 'Role', 'City'],
					['Ada', 'Engineering', 'London'],
					['Grace', 'Compilers', 'New York'],
					['Linus', 'Kernels', 'Helsinki']
				],
				headerRow: true,
				widths: [110, 150, 120]
			}),
			id: 'team'
		},
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	plugins: () => [tablePlugin, ...basePlugins()],
	custom: TableEditor
} satisfies PluginDemo;
