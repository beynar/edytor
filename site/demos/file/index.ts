import { createUploadsPlugin, type JSONDoc } from 'edytor';
import { filePlugin, mediaEmptyPlugin } from '../../chrome/plugins';
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
const uploads = () => createUploadsPlugin({ upload: objectUrlUpload });

export default {
	value,
	plugins: () => [uploads(), filePlugin, mediaEmptyPlugin, ...basePlugins()],
	custom: FileEditor,
	customPlugins: () => [uploads(), mediaEmptyPlugin, ...basePlugins()]
} satisfies PluginDemo;
