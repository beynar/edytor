/** @jsxImportSource ../../jsx */
/**
 * Find and replace (WU-33, site `plugins/find`): an opt-in plugin. Mod+F
 * opens its bar only when the plugin is listed; it searches the document's
 * text in reading order (a closed toggle's body included, revealed when a
 * match there becomes the current one), highlights the matches in the
 * overlay, steps through them, and replaces one or all as ONE command
 * (`replaceMatches`) and one undo step, each replacement taking the marks
 * the replaced text had in common, as typing over a selection does.
 *
 * Expected values come from the site page and Notion's find bar, never from
 * a run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { JSONDoc } from '$lib/utils/json.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { findPlugin, findController } from '$lib/plugins/find/findPlugin.js';
import { findMatches } from '$lib/plugins/find/search.js';
import { dispatchDomKeyDown, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const VALUE = (): JSONDoc => ({
	children: [
		{ id: 'a', type: 'paragraph', content: [{ text: 'Hello world, hello World' }] },
		{
			id: 'b',
			type: 'paragraph',
			content: [{ text: 'say ' }, { text: 'hello', marks: { bold: true } }]
		},
		{
			id: 't',
			type: 'toggle',
			content: [{ text: 'Toggle hello' }],
			children: [{ id: 'h', type: 'paragraph', content: [{ text: 'hidden hello' }] }]
		},
		{ id: 'c', type: 'paragraph', content: [{ text: 'Goodbye' }] }
	]
});

const mount = (options: { plugins?: Plugin[]; readonly?: boolean } = {}) =>
	renderDomEdytor(
		<root>
			<paragraph>x</paragraph>
		</root>,
		{ plugins: [findPlugin, richTextPlugin], value: VALUE(), autoSelectFixture: false, ...options }
	);

const texts = (edytor: Edytor) => {
	const out: Record<string, string> = {};
	const walk = (blocks: JSONDoc['children']) => {
		for (const block of blocks ?? []) {
			out[block.id!] = (block.content ?? [])
				.map((part) => ('text' in part ? part.text : '@'))
				.join('');
			walk(block.children);
		}
	};
	walk(edytor.value.children);
	return out;
};

const caretIn = (edytor: Edytor, id: string, offset: number) =>
	edytor.selection.setAtTextOffset(edytor.idToBlock.get(id)!.firstText!, offset);

const bar = () => document.querySelector<HTMLElement>('[data-edytor-find]');
const queryField = () => document.querySelector<HTMLInputElement>('[data-edytor-find-query]')!;
const replaceField = () =>
	document.querySelector<HTMLInputElement>('[data-edytor-find-replacement]');
const count = () => document.querySelector('[data-edytor-find-count]')?.textContent?.trim();
const type = async (field: HTMLInputElement, value: string) => {
	field.value = value;
	field.dispatchEvent(new Event('input', { bubbles: true }));
	await flushDomUpdates();
};
const press = async (target: HTMLElement, key: string, modifiers: KeyboardEventInit = {}) => {
	const event = new KeyboardEvent('keydown', {
		key,
		bubbles: true,
		cancelable: true,
		...modifiers
	});
	target.dispatchEvent(event);
	await flushDomUpdates();
	return event.defaultPrevented;
};
/** The overlay measures in a frame. */
const frame = async () => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await flushDomUpdates();
};

const open = async (editor: HTMLElement) => {
	const { defaultPrevented } = await dispatchDomKeyDown(editor, { key: 'f', ctrlKey: true });
	return defaultPrevented;
};

describe('Mod+F — only when the plugin is listed', () => {
	it('without the plugin, Mod+F is not claimed and no bar opens', async () => {
		const { edytor, editor } = await mount({ plugins: [richTextPlugin] });
		caretIn(edytor, 'a', 0);
		await flushDomUpdates();
		expect(await open(editor)).toBe(false);
		expect(bar()).toBeNull();
		expect(findController(edytor)).toBeUndefined();
	});

	it('with it, Mod+F opens the bar and focuses its query field', async () => {
		const { edytor, editor } = await mount();
		caretIn(edytor, 'a', 0);
		await flushDomUpdates();
		expect(await open(editor)).toBe(true);
		expect(bar()).not.toBeNull();
		expect(document.activeElement).toBe(queryField());
		expect(findController(edytor)!.isOpen).toBe(true);
	});

	it('Mod+F over a text range in one block searches for it', async () => {
		const { edytor, editor } = await mount();
		const text = edytor.idToBlock.get('a')!.firstText!;
		edytor.selection.setAtRange(text, 19, text, 24);
		await flushDomUpdates();
		await open(editor);
		expect(queryField().value).toBe('World');
		// Case is ignored: "world" and "World", the selected one current.
		expect(count()).toBe('2/2');
	});
});

describe('search — the document text, in reading order', () => {
	it('matches ignore case by default; the case toggle narrows them', async () => {
		const { edytor } = await mount();
		expect(findMatches(edytor, 'hello')).toEqual([
			{ block: 'a', offset: 0, length: 5 },
			{ block: 'a', offset: 13, length: 5 },
			{ block: 'b', offset: 4, length: 5 },
			{ block: 't', offset: 7, length: 5 },
			{ block: 'h', offset: 7, length: 5 }
		]);
		expect(findMatches(edytor, 'Hello', { caseSensitive: true })).toEqual([
			{ block: 'a', offset: 0, length: 5 }
		]);
		expect(findMatches(edytor, '')).toEqual([]);
	});

	it('the bar counts them, starting at the caret, and highlights the shown ones', async () => {
		const { edytor, editor } = await mount();
		caretIn(edytor, 'b', 0);
		await flushDomUpdates();
		await open(editor);
		await type(queryField(), 'hello');
		expect(count()).toBe('3/5');
		await frame();
		// The closed toggle's body shows nothing to highlight.
		const marks = document.querySelectorAll('[data-edytor-find-match]');
		expect(marks.length).toBe(4);
		expect(document.querySelectorAll('[data-edytor-find-match][data-current]').length).toBe(1);
		// Chrome lives in the overlay, never in the host.
		expect(editor.querySelector('[data-edytor-find-match], [data-edytor-find]')).toBeNull();

		const toggle = document.querySelector<HTMLElement>('[data-edytor-find-case]')!;
		toggle.click();
		await flushDomUpdates();
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
		expect(count()).toBe('2/4');
	});

	it('an edit, a peer’s included, updates the matches', async () => {
		const { edytor, editor } = await mount();
		caretIn(edytor, 'a', 0);
		await flushDomUpdates();
		await open(editor);
		await type(queryField(), 'hello');
		expect(count()).toBe('1/5');
		edytor.facade.apply(edytor.facade.prepare.insertText('c', 0, 'hello '));
		await flushDomUpdates();
		expect(count()).toBe('1/6');
	});

	it('no match reads "No results"', async () => {
		const { edytor, editor } = await mount();
		caretIn(edytor, 'a', 0);
		await flushDomUpdates();
		await open(editor);
		await type(queryField(), 'zebra');
		expect(count()).toBe('No results');
	});
});

describe('next and previous — wrapping, revealing a closed toggle’s body', () => {
	it('Enter goes to the next match, Shift+Enter to the previous, both wrap', async () => {
		const { edytor, editor } = await mount();
		caretIn(edytor, 'b', 0);
		await flushDomUpdates();
		await open(editor);
		await type(queryField(), 'hello');
		expect(count()).toBe('3/5');
		const details = edytor.idToBlock.get('t')!.node as HTMLDetailsElement;
		expect(details.open).toBe(false);

		expect(await press(queryField(), 'Enter')).toBe(true);
		expect(count()).toBe('4/5');
		expect(details.open).toBe(false);
		await press(queryField(), 'Enter');
		expect(count()).toBe('5/5');
		// The match is in the closed toggle's body: the toggle opens (Notion).
		expect(details.open).toBe(true);
		await press(queryField(), 'Enter');
		expect(count()).toBe('1/5');
		await press(queryField(), 'Enter', { shiftKey: true });
		expect(count()).toBe('5/5');
		// The bar's buttons do the same.
		document.querySelector<HTMLElement>('[data-edytor-find-previous]')!.click();
		await flushDomUpdates();
		expect(count()).toBe('4/5');
		document.querySelector<HTMLElement>('[data-edytor-find-next]')!.click();
		await flushDomUpdates();
		expect(count()).toBe('5/5');
		// Searching never touched the document or the editor's selection.
		expect(texts(edytor).a).toBe('Hello world, hello World');
		expect(edytor.selection.state.startBlock?.id).toBe('b');
	});

	it('Escape closes the bar and selects the current match in the editor', async () => {
		const { edytor, editor } = await mount();
		caretIn(edytor, 'a', 0);
		await flushDomUpdates();
		await open(editor);
		await type(queryField(), 'hello');
		await press(queryField(), 'Enter');
		expect(count()).toBe('2/5');
		expect(await press(queryField(), 'Escape')).toBe(true);
		await frame();
		expect(bar()).toBeNull();
		expect(document.querySelectorAll('[data-edytor-find-match]').length).toBe(0);
		const { startBlock, yStart, yEnd, isCollapsed } = edytor.selection.state;
		expect([startBlock?.id, yStart, yEnd, isCollapsed]).toEqual(['a', 13, 18, false]);
		expect(document.activeElement).toBe(editor);
	});
});

describe('replace — one command, one undo step', () => {
	it('Replace changes the current match and goes to the next one', async () => {
		const { edytor, editor } = await mount();
		caretIn(edytor, 'a', 0);
		await flushDomUpdates();
		await open(editor);
		await type(queryField(), 'hello');
		await type(replaceField()!, 'bye');
		expect(await press(replaceField()!, 'Enter')).toBe(true);
		expect(texts(edytor).a).toBe('bye world, hello World');
		expect(edytor.dispatcher.last).toMatchObject({
			operation: 'replaceMatches',
			status: 'applied'
		});
		expect(count()).toBe('1/4');
		document.querySelector<HTMLElement>('[data-edytor-find-replace]')!.click();
		await flushDomUpdates();
		expect(texts(edytor).a).toBe('bye world, bye World');
		expect(count()).toBe('1/3');

		edytor.historyUndo();
		await flushDomUpdates();
		expect(texts(edytor).a).toBe('bye world, hello World');
		edytor.historyUndo();
		await flushDomUpdates();
		expect(texts(edytor).a).toBe('Hello world, hello World');
	});

	it('Replace all replaces every match, a closed toggle’s body included, as one undo step', async () => {
		const seen: string[] = [];
		const spy: Plugin = () => ({
			onBeforeOperation: ({ operation }) => void seen.push(operation)
		});
		const { edytor, editor } = await mount({ plugins: [spy, findPlugin, richTextPlugin] });
		caretIn(edytor, 'c', 0);
		await flushDomUpdates();
		await open(editor);
		await type(queryField(), 'hello');
		await type(replaceField()!, 'bye');
		document.querySelector<HTMLElement>('[data-edytor-find-replace-all]')!.click();
		await flushDomUpdates();

		expect(texts(edytor)).toEqual({
			a: 'bye world, bye World',
			b: 'say bye',
			t: 'Toggle bye',
			h: 'hidden bye',
			c: 'Goodbye'
		});
		// The replacement keeps the marks the replaced text had in common.
		expect(edytor.value.children![1]!.content).toEqual([
			{ text: 'say ' },
			{ text: 'bye', marks: { bold: true } }
		]);
		// One command, its steps shown to hooks under their names.
		expect(seen.filter((op) => op === 'replaceMatches')).toHaveLength(1);
		expect(seen.filter((op) => op === 'insertText')).toHaveLength(5);
		expect(seen.filter((op) => op === 'deleteContentAtRange')).toHaveLength(5);
		expect(count()).toBe('No results');

		edytor.historyUndo();
		await flushDomUpdates();
		expect(texts(edytor)).toEqual({
			a: 'Hello world, hello World',
			b: 'say hello',
			t: 'Toggle hello',
			h: 'hidden hello',
			c: 'Goodbye'
		});
		expect(edytor.value.children![1]!.content).toEqual([
			{ text: 'say ' },
			{ text: 'hello', marks: { bold: true } }
		]);
	});

	it('a veto of the command writes nothing', async () => {
		const veto: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				if ((operation as string) === 'replaceMatches') prevent();
			}
		});
		const { edytor } = await mount({ plugins: [veto, findPlugin, richTextPlugin] });
		const find = findController(edytor)!;
		find.open('hello');
		find.replacement = 'bye';
		await flushDomUpdates();
		expect(find.replaceAll()).toBe('refused');
		expect(texts(edytor).a).toBe('Hello world, hello World');
		expect(edytor.dispatcher.last?.status).toBe('refused');
	});

	it('a readonly view searches but offers no replace, and refuses one', async () => {
		const { edytor, editor } = await mount({ readonly: true });
		// The keymap does not run while readonly: Mod+F is the browser's own find.
		expect(await open(editor)).toBe(false);
		const find = findController(edytor)!;
		find.open();
		await flushDomUpdates();
		await type(queryField(), 'hello');
		expect(count()).toBe('1/5');
		expect(replaceField()).toBeNull();
		expect(document.querySelector('[data-edytor-find-replace-all]')).toBeNull();
		find.replacement = 'bye';
		expect(find.replaceAll()).toBe('refused');
		expect(texts(edytor).a).toBe('Hello world, hello World');
	});
});
