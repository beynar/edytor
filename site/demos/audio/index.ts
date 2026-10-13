import type { JSONDoc } from 'edytor';
import { audio, mediaEmptyPlugin } from '$registry/edytor/chrome/index.js';
import { basePlugins, objectUrlUpload } from '../base';
import type { PluginDemo } from '../types';
import AudioEditor from './AudioEditor.svelte';

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [{ text: 'An audio block starts as an empty slot. Add a link or upload a sound from your computer.' }]
		},
		{ id: 'clip', type: 'audio', data: {}, content: [{ text: '' }] },
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	plugins: () => [
		audio({ upload: objectUrlUpload }),
		mediaEmptyPlugin,
		...basePlugins()
	],
	custom: AudioEditor
} satisfies PluginDemo;
