import { withRulesAndTriggers, type JSONDoc, type Plugin } from 'edytor';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';

const EMOJI: Record<string, string> = { smile: '😄', heart: '❤️', tada: '🎉', fire: '🔥' };

/** Typing `:smile:` gives 😄, `->` gives →, `(c)` gives ©. */
const rulesPlugin: Plugin = (edytor) =>
	withRulesAndTriggers(
		edytor,
		{},
		{
			inputRules: [
				{ find: /:(\w+):$/, replace: ([, name]) => EMOJI[name!] ?? null },
				{ find: /->$/, replace: () => '→' },
				{ find: /\(c\)$/, replace: () => '©' }
			]
		}
	);

const value: JSONDoc = {
	children: [
		{
			id: 'intro',
			type: 'paragraph',
			content: [{ text: 'Type :smile: or :tada: for an emoji, -> for an arrow, (c) for a copyright sign. Undo gives the typed text back.' }]
		},
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	plugins: () => [rulesPlugin, ...basePlugins()]
} satisfies PluginDemo;
