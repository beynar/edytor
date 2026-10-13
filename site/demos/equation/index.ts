import type { JSONDoc } from 'edytor';
import { equation } from '$registry/edytor/chrome/index.js';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import EquationEditor from './EquationEditor.svelte';

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [
				{ text: 'Click an equation to edit its TeX. Euler’s identity is ' },
				{ type: 'inlineEquation', data: { expression: 'e^{i\\pi} + 1 = 0' } },
				{ text: ', and an empty one waits here: ' },
				{ type: 'inlineEquation', data: { expression: '' } },
				{ text: '.' }
			]
		},
		{ id: 'integral', type: 'equation', data: { expression: '\\int_0^1 x^2\\,dx = \\frac{1}{3}' } },
		{ id: 'broken', type: 'equation', data: { expression: '\\frac{1}{' } },
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	plugins: () => [equation(), ...basePlugins()],
	custom: EquationEditor
} satisfies PluginDemo;
