import type { JSONDoc } from 'edytor';
import { mention } from '../../chrome/plugins';
import { basePlugins, searchBy } from '../base';
import type { PluginDemo } from '../types';
import MentionEditor from './MentionEditor.svelte';

const PEOPLE = [
	{ id: 'u1', label: 'Ada Lovelace', description: 'Engineering' },
	{ id: 'u2', label: 'Alan Turing', description: 'Research' },
	{ id: 'u3', label: 'Grace Hopper', description: 'Compilers' },
	{ id: 'u4', label: 'Katherine Johnson', description: 'Orbits' },
	{ id: 'u5', label: 'Margaret Hamilton', description: 'Flight software' }
];

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [
				{ text: 'Thanks ' },
				{ type: 'mention', id: 'm1', data: { id: 'u1', label: 'Ada Lovelace' } },
				{ text: ' for the review. Who else should look at it?' }
			]
		},
		{ id: 'end', type: 'paragraph', content: [{ text: 'Ask ' }] }
	]
};

export default {
	value,
	plugins: () => [mention({ items: searchBy(PEOPLE, (person) => person.label) }), ...basePlugins()],
	custom: MentionEditor
} satisfies PluginDemo;
