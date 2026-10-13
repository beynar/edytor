import type { JSONDoc } from 'edytor';
import { image, imageToolbarPlugin, mediaEmptyPlugin } from 'edytor/starter';
import { basePlugins, objectUrlUpload } from '../base';
import type { PluginDemo } from '../types';
import ImageEditor from './ImageEditor.svelte';

const svg = (from: string, to: string, shape: string) =>
	'data:image/svg+xml,' +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">` +
			`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/>` +
			`<stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
			`<rect width="480" height="270" fill="url(#g)"/>${shape}</svg>`
	);

const landscape = svg(
	'#ffd6a5',
	'#a0c4ff',
	'<circle cx="360" cy="80" r="36" fill="#fff" fill-opacity=".85"/>' +
		'<path d="M0 270V190l110-80 90 70 70-50 210 110v30z" fill="#355070" fill-opacity=".85"/>'
);

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [{ text: 'Hover the picture for its toolbar and resize handles. The block below is empty.' }]
		},
		{
			id: 'photo',
			type: 'image',
			data: { src: landscape, alt: 'A mountain range under a pale sun', width: 320, align: 'center' },
			content: [{ text: 'Sunrise over the ridge' }]
		},
		{ id: 'empty', type: 'image', content: [{ text: '' }] },
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

// Uploads stay in this tab: the file's object URL.
const images = () => image({ upload: objectUrlUpload });

export default {
	value,
	plugins: () => [images(), imageToolbarPlugin, mediaEmptyPlugin, ...basePlugins()],
	custom: ImageEditor,
	customPlugins: () => [images(), ...basePlugins()]
} satisfies PluginDemo;
