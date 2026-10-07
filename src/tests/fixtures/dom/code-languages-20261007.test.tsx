/** @jsxImportSource ../../jsx */
/**
 * Code block languages (WU-26, F9), after Notion:
 *
 * - `code.language`: a code block's language is its `data.language`; a block
 *   without one is in the plugin's default language, JavaScript.
 * - `code.language.label`: the header names the language by its label.
 * - `code.language.picker`: the header's picker sets `data.language`, one
 *   undo step; a readonly view shows the label only.
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
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

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

const label = (editor: HTMLElement) => {
	const element = editor.querySelector<HTMLElement>('[data-edytor-code-language]')!;
	return element instanceof HTMLSelectElement
		? element.selectedOptions[0]?.textContent
		: element.textContent;
};

const picker = (editor: HTMLElement) =>
	editor.querySelector<HTMLSelectElement>('select[data-edytor-code-language]');

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
	it('offers every language, labeled, the current one selected', async () => {
		const { editor } = await render(code(['x'], { language: 'sql' }));
		const select = picker(editor)!;
		expect([...select.options].map((option) => option.textContent)).toEqual(
			CODE_LANGUAGES.map((row) => row.label)
		);
		expect(select.value).toBe('sql');
	});

	it('picking one stores it and highlights with it, as one undo step', async () => {
		await loadCodeLanguage(language('python'));
		const { edytor, editor } = await render(code(['def f(): pass']));
		const select = picker(editor)!;
		select.value = 'python';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await flushDomUpdates();
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

	it('a readonly view shows the label, no picker', async () => {
		const { editor } = await render(code(['x'], { language: 'python' }), { readonly: true });
		expect(picker(editor)).toBeNull();
		expect(label(editor)).toBe('Python');
	});
});
