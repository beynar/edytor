/**
 * The version history panel's `item` snippet: one object argument, the row
 * shape every menu shares (`item`/`version`, `id`, `label`, `selected`,
 * `run`, `select`, `option`). A row that spreads `option` is a listbox
 * option the list's keys walk as they walk the built-in rows (WAI-ARIA 1.2
 * listbox: the arrows, Home and End move the selection and the focus; one
 * tab stop, the selected row). Expected states come from that pattern.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import HistoryItems from '../../dom/HistoryItems.svelte';
import type { HistoryClient, HistoryVersion } from '$lib/collaboration/history/client.js';
import { createDocument } from '$lib/crdt/index.js';
import type { JSONBlock, JSONDoc } from '$lib/utils/json.js';
import { flushDomUpdates } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const p = (id: string, text: string): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });
const version = (key: string, slot: 'am' | 'pm', editors: string[]): HistoryVersion => ({
	key,
	date: '2026-10-06',
	slot,
	bytes: 100,
	blocks: 1,
	editors,
	more: 0,
	at: Date.UTC(2026, 9, 6, slot === 'am' ? 10 : 22),
	expiresAt: null
});
const versions = [version('v-pm', 'pm', ['ada', 'bob']), version('v-am', 'am', [])];
const live: JSONDoc = { children: [p('a', 'now')] };
const reads: string[] = [];
const client: HistoryClient = {
	list: async () => structuredClone(versions),
	read: async (key) => {
		reads.push(key);
		return { children: [p('a', key)] };
	},
	restore: async () => ({ status: 'applied' }) as Awaited<ReturnType<HistoryClient['restore']>>,
	undo: async () => ({ status: 'noop' }) as Awaited<ReturnType<HistoryClient['undo']>>
};

const settle = async () => {
	for (let round = 0; round < 5; round++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await flushDomUpdates();
	}
};
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="custom-version"]')];
const key = async (target: Element, init: KeyboardEventInit) => {
	target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
	await settle();
};

describe('the history panel’s `item` snippet', () => {
	it('renders each version with its label; the rows are the listbox’s options', async () => {
		render(HistoryItems, { props: { client, document: createDocument({ value: live }) } });
		await settle();
		expect(rows().map((row) => row.dataset.key)).toEqual(['v-pm', 'v-am']);
		expect(rows()[0]!.textContent).toMatch(/· 2$/);
		expect(rows().every((row) => row.getAttribute('role') === 'option')).toBe(true);
		expect(new Set(rows().map((row) => row.id)).size).toBe(2);
		// The newest is selected first: it is the list's one tab stop.
		expect(rows().map((row) => row.getAttribute('aria-selected'))).toEqual(['true', 'false']);
		expect(rows().map((row) => row.tabIndex)).toEqual([0, -1]);
	});

	it('the list’s arrows walk the custom rows; a click (`run`) previews its version', async () => {
		reads.length = 0;
		render(HistoryItems, { props: { client, document: createDocument({ value: live }) } });
		await settle();
		await key(rows()[0]!, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(rows()[1]);
		expect(rows().map((row) => row.dataset.current)).toEqual(['false', 'true']);
		expect(rows().map((row) => row.tabIndex)).toEqual([-1, 0]);
		await key(rows()[1]!, { key: 'Home' });
		expect(document.activeElement).toBe(rows()[0]);
		rows()[1]!.click();
		await settle();
		expect(rows()[1]!.getAttribute('aria-selected')).toBe('true');
		expect(reads.at(-1)).toBe('v-am');
	});
});
