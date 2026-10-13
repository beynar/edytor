import type { JSONDoc } from 'edytor';
import { codePlugin } from '$registry/edytor/chrome/index.js';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import CodeEditor from './CodeEditor.svelte';

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [
				{ text: 'Pick a language in a block’s header, or type ' },
				{ text: '```', marks: { code: true } },
				{ text: ' on an empty line for a new block.' }
			]
		},
		{
			id: 'ts',
			type: 'code',
			data: { language: 'typescript' },
			content: [{ text: '' }],
			children: [
				{ id: 'ts-1', type: 'codeLine', content: [{ text: 'type Note = { title: string; done: boolean };' }] },
				{ id: 'ts-2', type: 'codeLine', content: [{ text: '' }] },
				{ id: 'ts-3', type: 'codeLine', content: [{ text: 'const open = (notes: Note[]) =>' }] },
				{ id: 'ts-4', type: 'codeLine', content: [{ text: '\tnotes.filter((note) => !note.done);' }] }
			]
		},
		{
			id: 'py',
			type: 'code',
			data: { language: 'python' },
			content: [{ text: '' }],
			children: [
				{ id: 'py-1', type: 'codeLine', content: [{ text: 'def greet(name: str) -> str:' }] },
				{ id: 'py-2', type: 'codeLine', content: [{ text: '    return f"Hello, {name}!"' }] }
			]
		},
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	plugins: () => [codePlugin, ...basePlugins()],
	custom: CodeEditor
} satisfies PluginDemo;
