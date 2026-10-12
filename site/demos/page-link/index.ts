import type { JSONDoc } from 'edytor';
import { pageLink } from '../../chrome/plugins';
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
	plugins: () => [pageLink({ search: searchBy(PAGES, (page) => page.title) }), ...basePlugins()],
	custom: PageLinkEditor
} satisfies PluginDemo;
