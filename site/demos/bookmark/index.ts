import type { BookmarkPreview, JSONDoc } from 'edytor';
import { bookmark } from '$registry/edytor/chrome/index.js';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import BookmarkEditor from './BookmarkEditor.svelte';

/** Canned metadata, what an app's unfurl endpoint would answer, after a short delay. */
const unfurl = async (url: string): Promise<BookmarkPreview> => {
	await new Promise((resolve) => setTimeout(resolve, 400));
	const host = new URL(url).hostname.replace(/^www\./, '');
	return {
		title: `A page on ${host}`,
		description: `Canned metadata for ${host}: the title and this line come from the demo, not from the page.`
	};
};

const value: JSONDoc = {
	children: [
		{ id: 'intro', type: 'paragraph', content: [{ text: 'Reading list for the week.' }] },
		{
			id: 'saved',
			type: 'bookmark',
			data: {
				url: 'https://example.com/notes',
				title: 'Notes on editing engines',
				description: 'A saved bookmark: the title and description are stored on the block.'
			},
			content: [{ text: 'Start here' }]
		},
		{ id: 'empty', type: 'bookmark', content: [{ text: '' }] },
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	plugins: () => [bookmark({ unfurl }), ...basePlugins()],
	custom: BookmarkEditor
} satisfies PluginDemo;
