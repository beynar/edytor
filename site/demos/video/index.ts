import { createUploadsPlugin, type JSONDoc } from 'edytor';
import { mediaEmptyPlugin, videoPlugin } from '../../chrome/plugins';
import { basePlugins, objectUrlUpload } from '../base';
import type { PluginDemo } from '../types';
import VideoEditor from './VideoEditor.svelte';

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [{ text: 'A video block starts empty. Link a video file or upload one from your computer.' }]
		},
		{ id: 'clip', type: 'video' },
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	plugins: () => [
		createUploadsPlugin({ upload: objectUrlUpload }),
		videoPlugin,
		mediaEmptyPlugin,
		...basePlugins()
	],
	custom: VideoEditor
} satisfies PluginDemo;
