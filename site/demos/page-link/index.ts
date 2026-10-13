import type { JSONDoc } from 'edytor';
import { pageLink } from 'edytor/starter';
import { basePlugins, searchBy } from '../base';
import type { PluginDemo } from '../types';
import PageLinkEditor from './PageLinkEditor.svelte';

const PAGES = [
	{ id: 'p1', title: 'Roadmap', icon: '🗺️' },
	{ id: 'p2', title: 'Meeting notes', icon: '📝' },
	{ id: 'p3', title: 'Design system', icon: '🎨' },
	{ id: 'p4', title: 'Release checklist', icon: '✅' },
	{ id: 'p5', title: 'Onboarding guide', icon: '👋' }
];

/** `page:roadmap` (a title's slug) or this app's URL for a page, `https://app.example.com/p/p3`. */
const fromPaste = (text: string) => {
	const slug = /^page:([\w-]+)$/.exec(text)?.[1];
	const id = /^https:\/\/app\.example\.com\/p\/(\w+)$/.exec(text)?.[1];
	const slugOf = (title: string) => title.toLowerCase().replace(/\s+/g, '-');
	return PAGES.find((page) => page.id === id || slugOf(page.title) === slug) ?? null;
};

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [
				{ text: 'The plan lives in ' },
				{ type: 'pageLink', id: 'l1', data: { id: 'p1', title: 'Roadmap', icon: '🗺️' } },
				{ text: ', and the decisions in ' },
				{ type: 'pageLink', id: 'l2', data: { id: 'p2', title: 'Meeting notes', icon: '📝' } },
				{ text: '.' }
			]
		},
		{ id: 'end', type: 'paragraph', content: [{ text: 'See also ' }] }
	]
};

export default {
	value,
	plugins: () => [pageLink({ search: searchBy(PAGES, (page) => page.title), fromPaste }), ...basePlugins()],
	custom: PageLinkEditor
} satisfies PluginDemo;
