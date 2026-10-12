import { createTocPlugin, type JSONDoc } from 'edytor';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import TocEditor from './TocEditor.svelte';

const value: JSONDoc = {
	children: [
		{ id: 'title', type: 'heading', data: { level: 'h1' }, content: [{ text: 'Launch plan' }] },
		{ id: 'toc', type: 'toc' },
		{ id: 'a', type: 'heading', data: { level: 'h2' }, content: [{ text: 'Goals' }] },
		{ id: 'a-p', type: 'paragraph', content: [{ text: 'Ship the beta to the first hundred teams.' }] },
		{ id: 'b', type: 'heading', data: { level: 'h2' }, content: [{ text: 'Timeline' }] },
		{ id: 'b-1', type: 'heading', data: { level: 'h3' }, content: [{ text: 'Week one' }] },
		{ id: 'b-2', type: 'heading', data: { level: 'h3' }, content: [{ text: 'Week two' }] },
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	plugins: () => [createTocPlugin(), ...basePlugins()],
	custom: TocEditor
} satisfies PluginDemo;
