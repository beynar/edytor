import { createMemoryCommentsClient, type JSONDoc } from 'edytor';
import { comments } from 'edytor/starter';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import CommentsEditor from './CommentsEditor.svelte';

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [
				{ text: 'Select some text and press Comment in the toolbar to start a thread. This ' },
				{ text: 'sentence already has one', marks: { 'comment:t1': { id: 't1' } } },
				{ text: ': click it to open the card.' }
			]
		},
		{
			id: 'body',
			type: 'paragraph',
			content: [{ text: 'Comments live beside the document, never in it: the text only keeps each thread’s anchor.' }]
		},
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

const PEOPLE: Record<string, { name: string; color: string }> = {
	ada: { name: 'Ada Lovelace', color: '#9065b0' },
	bob: { name: 'Bob Martin', color: '#337ea9' }
};

/** An in-memory client holding the seed's thread: Bob asked, Ada answered. */
const client = () => {
	const ada = createMemoryCommentsClient({ user: 'ada' });
	void ada
		.as('bob')
		.send({
			op: 'add',
			thread: 't1',
			body: 'Is this the right wording?',
			quote: 'sentence already has one',
			block: 'intro'
		})
		.then(() => ada.send({ op: 'reply', thread: 't1', body: 'Yes, ship it.' }));
	return ada;
};

export default {
	value,
	plugins: () => [
		comments({ client: client(), user: { id: 'ada', ...PEOPLE.ada }, users: (id) => PEOPLE[id] }),
		...basePlugins()
	],
	custom: CommentsEditor
} satisfies PluginDemo;
