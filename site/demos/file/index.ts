import type { JSONDoc } from 'edytor';
import { file, mediaEmptyPlugin } from 'edytor/starter';
import { basePlugins, objectUrlUpload } from '../base';
import type { PluginDemo } from '../types';
import FileEditor from './FileEditor.svelte';

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [{ text: 'Attach the brief below, or press Upload on the empty block.' }]
		},
		{
			id: 'brief',
			type: 'file',
			data: { src: 'https://example.com/files/project-brief.pdf', name: 'project-brief.pdf', size: 482113 },
			content: [{ text: 'The latest brief' }]
		},
		{ id: 'empty', type: 'file', data: { src: '', name: '' }, content: [{ text: '' }] },
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

// Uploads keep the file in this tab: its object URL.

export default {
	value,
	plugins: () => [file({ upload: objectUrlUpload }), mediaEmptyPlugin, ...basePlugins()],
	custom: FileEditor,
	customPlugins: () => [mediaEmptyPlugin, ...basePlugins()]
} satisfies PluginDemo;
