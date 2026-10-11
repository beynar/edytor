/**
 * Localization of the version history (`VersionHistory`, drawn by the demo's
 * panel): the controller says no word (its `status` is a code), the panel's
 * words are the demo chrome's `history` words (`englishWords.history`, the
 * French fixture's here, `setWords`); a word about a count is a function of
 * it. Expected words come from the dictionary, never from a run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { englishWords, setWords } from '../../../routes/chrome/words.svelte.js';
import { render } from '@testing-library/svelte';
import HistoryPanel from '../../../routes/chrome/HistoryPanel.svelte';
import type { HistoryClient, HistoryVersion } from '$lib/collaboration/history/client.js';
import { createDocument } from '$lib/crdt/index.js';
import type { JSONBlock, JSONDoc } from '$lib/utils/json.js';
import { flushDomUpdates } from '../../dom/test.utils.js';
import { frWords } from '../words.fr.js';

afterEach(() => {
	document.body.innerHTML = '';
	setWords();
});

const p = (id: string, text: string): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });

const live: JSONDoc = { children: [p('a', 'Intro'), p('b', 'Nouveau'), p('n', 'Ajouté')] };
const versions: HistoryVersion[] = [
	{
		key: 'v-pm',
		date: '2026-10-06',
		slot: 'pm',
		bytes: 300,
		blocks: 3,
		editors: ['ada', 'bob'],
		more: 2,
		at: Date.UTC(2026, 9, 6, 22),
		expiresAt: null
	},
	{
		key: 'v-am',
		date: '2026-10-06',
		slot: 'am',
		bytes: 280,
		blocks: 3,
		editors: [],
		more: 0,
		at: Date.UTC(2026, 9, 6, 10),
		expiresAt: null
	}
];
const stored: Record<string, JSONDoc> = {
	'v-pm': { children: [p('a', 'Intro'), p('b', 'Ancien'), p('r', 'Retiré')] },
	'v-am': structuredClone(live)
};
const client: HistoryClient = {
	list: async () => structuredClone(versions),
	read: async (key) => (key in stored ? structuredClone(stored[key]!) : null),
	restore: async () => ({ status: 'applied' }) as Awaited<ReturnType<HistoryClient['restore']>>,
	undo: async () => ({ status: 'noop' }) as Awaited<ReturnType<HistoryClient['undo']>>
};

const settle = async () => {
	for (let round = 0; round < 5; round++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await flushDomUpdates();
	}
};

const one = (selector: string) => {
	const found = document.querySelector<HTMLElement>(selector);
	if (!found) throw new Error(`nothing matches ${selector}`);
	return found;
};

const mount = async (french = false) => {
	if (french) setWords({ history: frWords.history });
	render(HistoryPanel, {
		props: { client, document: createDocument({ value: live }), defaultPlugins: false }
	});
	await settle();
	one('[data-edytor-history-version="v-pm"]').click();
	await settle();
};

describe('the history panel speaks the chrome’s words', () => {
	it('English by default: the words’ history section', async () => {
		await mount();
		expect(one('[data-edytor-history]').getAttribute('aria-label')).toBe(
			englishWords.history.title
		);
	});

	it('French: its name, list, editors, counts and buttons', async () => {
		await mount(true);
		const panel = one('[data-edytor-history]');
		expect(panel.getAttribute('aria-label')).toBe(frWords.history.title);
		expect(one('[data-edytor-history-heading]').textContent).toBe(frWords.history.versions);
		expect(one('[data-edytor-history-list]').getAttribute('aria-label')).toBe(
			frWords.history.versions
		);
		expect(
			one('[data-edytor-history-version="v-pm"] [data-edytor-history-version-editors]').textContent
		).toBe(`ada, bob ${frWords.history.moreEditors(2)}`);
		expect(
			one('[data-edytor-history-version="v-am"] [data-edytor-history-version-editors]').textContent
		).toBe(frWords.history.noEditors);
		expect(one('[data-edytor-history-count="added"]').textContent).toBe(frWords.history.added(1));
		expect(one('[data-edytor-history-count="removed"]').textContent?.trim()).toBe(
			frWords.history.removed(1)
		);
		expect(one('[data-edytor-history-count="changed"]').textContent?.trim()).toBe(
			frWords.history.changed(1)
		);
		expect(one('[data-edytor-history-restore]').textContent?.trim()).toBe(frWords.history.restore);
		expect(one('[data-edytor-history-title]').textContent).toContain(frWords.history.evening);
	});

	it('French: no English word of the section reaches the panel', async () => {
		await mount(true);
		const french = new Set(
			Object.values(frWords.history).map((word) => (typeof word === 'function' ? word(3) : word))
		);
		const english = Object.values(englishWords.history)
			.map((word) => (typeof word === 'function' ? word(3) : word))
			.filter((word) => /[A-Za-z]{3}/.test(word) && !french.has(word));
		const shown = document.body.textContent ?? '';
		const named = [...document.querySelectorAll('[aria-label]')]
			.map((node) => node.getAttribute('aria-label'))
			.join('\n');
		expect(english.filter((word) => shown.includes(word) || named.includes(word))).toEqual([]);
	});
});
