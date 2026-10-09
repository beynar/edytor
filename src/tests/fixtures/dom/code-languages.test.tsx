/** @jsxImportSource ../../jsx */
/**
 * Code block languages (WU-26, F9), after Notion:
 *
 * - `code.language`: a code block's language is its `data.language`; a block
 *   without one is in the plugin's default language, JavaScript.
 * - `code.language.label`: the header names the language by its label.
 * - `code.language.picker`: the header's language is a button opening a
 *   searchable list of the languages in the overlay (Notion): a pick sets
 *   `data.language`, one undo step; the keys (Alt+F10 from a code line, then
 *   Enter or an arrow, a query, the arrows, Enter or Escape) do all the
 *   mouse does. A readonly view shows the label only.
 * - `code.language.lazy`: a language's grammar loads the first time one of
 *   its lines renders; until then its lines are plain text, then they
 *   highlight. Tokens are decorations: never stored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { codePlugin, createCodePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { CODE_LANGUAGES, loadCodeLanguage } from '$lib/plugins/code/languages.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { dispatchDomKeyDown, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const language = (id: string) => CODE_LANGUAGES.find((row) => row.id === id)!;

const code = (lines: string[], data?: Record<string, string>): JSONBlock => ({
	id: 'c',
	type: 'code',
	...(data && { data }),
	children: lines.map((text, index) => ({
		id: `l${index}`,
		type: 'codeLine',
		content: [{ text }]
	}))
});

const render = async (
	block: JSONBlock,
	options: { readonly?: boolean; plugins?: (typeof codePlugin)[] } = {}
) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [richTextPlugin, ...(options.plugins ?? [codePlugin])],
			value: { children: [block] },
			autoSelectFixture: false,
			readonly: options.readonly
		}
	);

/** The class of each token rendered in `editor`, in order. */
const tokens = (editor: HTMLElement) =>
	[...editor.querySelectorAll('[data-edytor-mark="codeToken"] > span')].map((span) => [
		span.className,
		span.textContent
	]);

const label = (editor: HTMLElement) =>
	editor.querySelector<HTMLElement>('[data-edytor-code-language]')!.textContent?.trim();

/** The header's language button, in an editable view. */
const picker = (editor: HTMLElement) =>
	editor.querySelector<HTMLButtonElement>('button[data-edytor-code-language]');

/** The open language menu (in the overlay), its field and its rows. */
const menu = () => document.querySelector<HTMLElement>('[data-edytor-code-language-menu]');
const field = () => menu()?.querySelector<HTMLInputElement>('input') ?? null;
const rows = () => [
	...document.querySelectorAll<HTMLElement>('[data-edytor-code-language-option]')
];
const rowLabels = () => rows().map((row) => row.textContent?.trim());
const active = () => rows().find((row) => row.getAttribute('aria-selected') === 'true');

/** The overlay measures in its next frame. */
const frame = async () => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await flushDomUpdates();
};
/** A press (its `pointerdown`, then `mousedown`) and its click. */
const click = async (element: Element) => {
	element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await frame();
};
const key = async (target: Element, key: string, init: KeyboardEventInit = {}) => {
	target.dispatchEvent(
		new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
	);
	await frame();
};
const search = async (query: string) => {
	const input = field()!;
	input.value = query;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await frame();
};

const stored = (edytor: Edytor) => edytor.idToBlock.get('c')!.value;

describe('code.language.lazy: a grammar loads with its first line', () => {
	it('a Go line is plain text until its grammar lands, then highlighted', async () => {
		const { editor } = await render(code(['func main() {}'], { language: 'go' }));
		expect(tokens(editor)).toEqual([]);
		await loadCodeLanguage(language('go'));
		await flushDomUpdates();
		expect(tokens(editor)).toContainEqual(['th-keyword', 'func']);
	});
});

describe('code.language: the stored language highlights its lines', () => {
	it('no language: JavaScript, highlighted at once', async () => {
		const { editor } = await render(code(['const a = 1']));
		expect(label(editor)).toBe('JavaScript');
		expect(tokens(editor)).toContainEqual(['th-keyword', 'const']);
	});

	it('Python: its label, its keywords', async () => {
		await loadCodeLanguage(language('python'));
		const { editor } = await render(code(['def f(): pass'], { language: 'python' }));
		expect(label(editor)).toBe('Python');
		expect(tokens(editor)).toContainEqual(['th-keyword', 'def']);
	});

	it('Plain text: no tokens', async () => {
		const { editor } = await render(code(['const a = 1'], { language: 'plaintext' }));
		expect(label(editor)).toBe('Plain text');
		expect(tokens(editor)).toEqual([]);
	});

	it('a language the plugin does not know: its id as the label, plain text', async () => {
		const { editor } = await render(code(['fn main() {}'], { language: 'rust' }));
		expect(label(editor)).toBe('rust');
		expect(tokens(editor)).toEqual([]);
	});

	it('the default language is an option', async () => {
		await loadCodeLanguage(language('python'));
		const plugin = createCodePlugin({ defaultLanguage: 'python' });
		const { editor } = await render(code(['def f(): pass']), { plugins: [plugin] });
		expect(label(editor)).toBe('Python');
		expect(tokens(editor)).toContainEqual(['th-keyword', 'def']);
	});
});

describe('code.language.picker: the header picks the language', () => {
	it('the header names the language on a button that opens the list', async () => {
		const { editor } = await render(code(['x'], { language: 'sql' }));
		const button = picker(editor)!;
		expect(button.textContent?.trim()).toBe('SQL');
		expect(button.getAttribute('aria-haspopup')).toBe('listbox');
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(button.getAttribute('aria-label')).toBe('Code language: SQL');
		expect(menu()).toBeNull();
	});

	it('a click opens every language, labeled, the current one marked and highlighted', async () => {
		const { editor } = await render(code(['x'], { language: 'sql' }));
		await click(picker(editor)!);
		expect(menu()).not.toBeNull();
		expect(picker(editor)!.getAttribute('aria-expanded')).toBe('true');
		expect(rowLabels()).toEqual(CODE_LANGUAGES.map((row) => row.label));
		expect(active()?.dataset.edytorCodeLanguageOption).toBe('sql');
		expect(
			rows()
				.filter((row) => row.hasAttribute('data-current'))
				.map((row) => row.dataset.edytorCodeLanguageOption)
		).toEqual(['sql']);
		// The field takes the keys, naming the highlighted row.
		expect(document.activeElement).toBe(field());
		expect(field()!.getAttribute('role')).toBe('combobox');
		expect(field()!.getAttribute('aria-activedescendant')).toBe(active()!.id);
		// A second click closes it.
		await click(picker(editor)!);
		expect(menu()).toBeNull();
	});

	it('picking one stores it and highlights with it, as one undo step', async () => {
		await loadCodeLanguage(language('python'));
		const { edytor, editor } = await render(code(['def f(): pass']));
		await click(picker(editor)!);
		await click(rows().find((row) => row.textContent?.trim() === 'Python')!);
		expect(menu()).toBeNull();
		expect(stored(edytor).data).toEqual({ language: 'python' });
		expect(label(editor)).toBe('Python');
		expect(tokens(editor)).toContainEqual(['th-keyword', 'def']);
		// Tokens are never stored.
		expect(stored(edytor).children?.[0]?.content).toEqual([{ text: 'def f(): pass' }]);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(stored(edytor).data ?? {}).toEqual({});
		expect(label(editor)).toBe('JavaScript');
	});

	it('a query narrows the rows; the arrows move; Enter picks the highlighted one', async () => {
		const { edytor, editor } = await render(code(['x']));
		await click(picker(editor)!);
		await search('script');
		expect(rowLabels()).toEqual(['JavaScript', 'TypeScript']);
		expect(active()?.textContent?.trim()).toBe('JavaScript');
		await key(field()!, 'ArrowDown');
		expect(active()?.textContent?.trim()).toBe('TypeScript');
		await key(field()!, 'ArrowDown');
		expect(active()?.textContent?.trim()).toBe('JavaScript');
		await key(field()!, 'ArrowUp');
		await key(field()!, 'Enter');
		expect(menu()).toBeNull();
		expect(stored(edytor).data).toEqual({ language: 'typescript' });
	});

	it('a query matches a language by its id too; no match shows none and Enter picks nothing', async () => {
		const { edytor, editor } = await render(code(['x']));
		await click(picker(editor)!);
		await search('cpp');
		expect(rowLabels()).toEqual(['C++']);
		await search('cobol');
		expect(rows()).toEqual([]);
		expect(menu()!.textContent).toContain('No results');
		await key(field()!, 'Enter');
		expect(stored(edytor).data ?? {}).toEqual({});
	});

	it('Escape closes the list and writes nothing', async () => {
		const { edytor, editor } = await render(code(['x']));
		await click(picker(editor)!);
		await key(field()!, 'ArrowDown');
		await key(field()!, 'Escape');
		expect(menu()).toBeNull();
		expect(stored(edytor).data ?? {}).toEqual({});
	});

	it('a press outside closes the list', async () => {
		const { edytor, editor } = await render(code(['x']));
		await click(picker(editor)!);
		await click(document.body);
		expect(menu()).toBeNull();
		expect(stored(edytor).data ?? {}).toEqual({});
	});

	it('Alt+F10 at a caret in a code line focuses the language; an arrow opens the list', async () => {
		const { edytor, editor } = await render(code(['x']));
		edytor.selection.setAtTextOffset(edytor.idToBlock.get('l0')!.firstText!, 1);
		await flushDomUpdates();
		await dispatchDomKeyDown(editor, { key: 'F10', code: 'F10', altKey: true });
		expect(document.activeElement).toBe(picker(editor));
		await key(picker(editor)!, 'ArrowDown');
		expect(menu()).not.toBeNull();
		expect(document.activeElement).toBe(field());
		await key(field()!, 'Escape');
		// Opened by the keys, the list gives the focus back to its button.
		expect(document.activeElement).toBe(picker(editor));
	});

	it('a readonly view shows the label, no picker', async () => {
		const { editor } = await render(code(['x'], { language: 'python' }), { readonly: true });
		expect(picker(editor)).toBeNull();
		expect(label(editor)).toBe('Python');
	});

	it('a language the plugin does not list is the first row, marked current', async () => {
		const { editor } = await render(code(['fn main() {}'], { language: 'rust' }));
		await click(picker(editor)!);
		expect(rowLabels()[0]).toBe('rust');
		expect(rows()[0]!.hasAttribute('data-current')).toBe(true);
	});
});
