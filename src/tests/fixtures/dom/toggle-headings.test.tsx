/** @jsxImportSource ../../jsx */
/**
 * WU-31, toggle headings (Notion's "Toggle heading 1/2/3"): a heading's
 * text as a toggle's header over its children, the `toggle-heading` kind
 * with the heading's `data.level`. It is a `details` (the browser owns
 * `open`) whose `summary` holds the h1–h3; it behaves as the toggle does
 * (a container: Enter at the end of an open one opens a first child, a
 * closed one a line after it; a closed one hides its body), and Turn into
 * moves between it, the heading and the toggle keeping the text, the
 * children and the level. Markdown, as Notion: `>` + space at a heading's
 * start, `#`/`##`/`###` + space at a toggle's, so `> # ` typed on a new line
 * is a toggle heading 1. Expected states are hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import { richTextPlugin, richTextPlaceholder } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
import { convertToKind } from '$lib/kinds.js';
import { hidden } from '$lib/selection/visibility.js';
import { serializeClipboardFragmentToHtml } from '$lib/clipboard/serializeClipboardFragment.js';
import {
	dispatchClipboardPaste,
	dispatchDomBeforeInput,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const render = (children: JSONBlock[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [
				markdownShortcutsPlugin,
				() => ({ placeholder: richTextPlaceholder }),
				richTextPlugin
			],
			value: { children }
		}
	);
type View = Awaited<ReturnType<typeof render>>;

const get = ({ edytor }: View, id: string) => edytor.idToBlock.get(id)!;
const row = (view: View, label: string) => view.edytor.kinds.find((kind) => kind.label === label)!;
const element = (id: string) => document.querySelector(`[data-edytor-id="${id}"]`)!;
const shape = ({ edytor }: View) => {
	const show = (b: JSONBlock): unknown => {
		const own = (b.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('');
		const level = typeof b.data?.level === 'string' ? `:${b.data.level}` : '';
		const line = `${b.type}${level} "${own}"`;
		return b.children?.length ? [line, b.children.map(show)] : line;
	};
	return (edytor.value.children ?? []).map(show);
};
const at = async (view: View, id: string, offset: number) => {
	await setNativeSelection(view.edytor, get(view, id).firstText!, offset);
};
const type = async (view: View, ...chars: string[]) => {
	for (const data of chars)
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertText', data });
	await flushDomUpdates();
};
const enter = async (view: View) => {
	await dispatchDomBeforeInput(view.editor, { inputType: 'insertParagraph' });
	await flushDomUpdates();
};
const th = (id: string, level: string, text: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type: 'toggle-heading',
	data: { level },
	content: [{ text }],
	...(children && { children })
});
const p = (id: string, text = id): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text }]
});

describe('The kind: presets, element, placeholder', () => {
	it('three presets, "Toggle heading 1" to "3", with the level as data', async () => {
		const view = await render([p('a')]);
		const rows = view.edytor.kinds.filter((kind) => kind.value.type === 'toggle-heading');
		expect(rows.map((r) => [r.label, r.value.data])).toEqual([
			['Toggle heading 1', { level: 'h1' }],
			['Toggle heading 2', { level: 'h2' }],
			['Toggle heading 3', { level: 'h3' }]
		]);
	});

	it('renders a details whose summary holds the heading; children inside it', async () => {
		await render([th('t', 'h2', 'Title', [p('c', 'body')])]);
		const block = element('t');
		expect(block.localName).toBe('details');
		const summary = block.querySelector(':scope > summary')!;
		expect(summary.querySelector(':scope > h2')?.textContent).toBe('Title');
		expect(block.querySelector(':scope > [data-edytor-children] [data-edytor-id="c"]')).not.toBe(
			null
		);
	});

	it('an empty one shows "Toggle heading N" as its placeholder', async () => {
		await render([th('t', 'h3', '')]);
		const text = element('t').querySelector('[data-edytor-text]')!;
		expect(text.getAttribute('data-placeholder')).toBe('Toggle heading 3');
	});

	it('a closed one hides its body; open, it shows', async () => {
		const view = await render([th('t', 'h1', 'Title', [p('c', 'body')]), p('z')]);
		const details = element('t') as HTMLDetailsElement;
		details.open = false;
		expect(hidden(get(view, 'c'))).toBe(true);
		details.open = true;
		expect(hidden(get(view, 'c'))).toBe(false);
	});
});

describe('Turn into: heading, toggle heading and toggle keep text, children and level', () => {
	it('Heading 2 → Toggle heading 2 → Toggle list → Heading 2', async () => {
		const view = await render([
			{ id: 'h', type: 'heading', data: { level: 'h2' }, content: [{ text: 'Plan' }] }
		]);
		expect(convertToKind(view.edytor, get(view, 'h'), row(view, 'Toggle heading 2'))).toBe(true);
		await flushDomUpdates();
		expect(shape(view)).toEqual(['toggle-heading:h2 "Plan"']);
		expect(element('h').localName).toBe('details');
		expect(convertToKind(view.edytor, get(view, 'h'), row(view, 'Toggle list'))).toBe(true);
		await flushDomUpdates();
		expect(view.edytor.value.children![0]!.type).toBe('toggle');
		expect(convertToKind(view.edytor, get(view, 'h'), row(view, 'Heading 2'))).toBe(true);
		await flushDomUpdates();
		expect(shape(view)).toEqual(['heading:h2 "Plan"']);
	});

	it('a toggle with children turned into Toggle heading 1 keeps them under it', async () => {
		const view = await render([
			{ id: 't', type: 'toggle', content: [{ text: 'Q' }], children: [p('c', 'A')] }
		]);
		expect(convertToKind(view.edytor, get(view, 't'), row(view, 'Toggle heading 1'))).toBe(true);
		await flushDomUpdates();
		expect(shape(view)).toEqual([['toggle-heading:h1 "Q"', ['paragraph "A"']]]);
	});
});

describe('Markdown (Notion): > at a heading, # at a toggle', () => {
	it('"> " at the start of a Heading 2 makes it a Toggle heading 2', async () => {
		const view = await render([
			{ id: 'h', type: 'heading', data: { level: 'h2' }, content: [{ text: 'Plan' }] }
		]);
		await at(view, 'h', 0);
		await type(view, '>', ' ');
		expect(shape(view)).toEqual(['toggle-heading:h2 "Plan"']);
	});

	it('"## " at the start of a toggle makes it a Toggle heading 2', async () => {
		const view = await render([{ id: 't', type: 'toggle', content: [{ text: 'Q' }] }]);
		await at(view, 't', 0);
		await type(view, '#', '#', ' ');
		expect(shape(view)).toEqual(['toggle-heading:h2 "Q"']);
	});

	it('"> # " typed on an empty line is a Toggle heading 1', async () => {
		const view = await render([{ id: 'a', type: 'paragraph', content: [] }]);
		await at(view, 'a', 0);
		await type(view, '>', ' ', '#', ' ');
		expect(shape(view)).toEqual(['toggle-heading:h1 ""']);
	});

	it('"### " at a Toggle heading 1 makes it a Toggle heading 3 (not a plain heading)', async () => {
		const view = await render([th('t', 'h1', 'Q')]);
		await at(view, 't', 0);
		await type(view, '#', '#', '#', ' ');
		expect(shape(view)).toEqual(['toggle-heading:h3 "Q"']);
	});

	it('"# " in a paragraph is still a heading', async () => {
		const view = await render([{ id: 'a', type: 'paragraph', content: [] }]);
		await at(view, 'a', 0);
		await type(view, '#', ' ');
		expect(shape(view)).toEqual(['heading:h1 ""']);
	});
});

describe('Enter, as a toggle’s header', () => {
	it('at the end of an open one: a first child (the default kind)', async () => {
		const view = await render([th('t', 'h2', 'Title'), p('z')]);
		(element('t') as HTMLDetailsElement).open = true;
		await at(view, 't', 5);
		await enter(view);
		expect(shape(view)).toEqual([['toggle-heading:h2 "Title"', ['paragraph ""']], 'paragraph "z"']);
	});

	it('at the end of a closed one with children: a paragraph after it, the body untouched', async () => {
		const view = await render([th('t', 'h2', 'Title', [p('c', 'body')]), p('z')]);
		(element('t') as HTMLDetailsElement).open = false;
		await at(view, 't', 5);
		await enter(view);
		expect(shape(view)).toEqual([
			['toggle-heading:h2 "Title"', ['paragraph "body"']],
			'paragraph ""',
			'paragraph "z"'
		]);
	});
});

describe('HTML: its export and import', () => {
	it('exports a details with the heading in its summary, and imports it back', async () => {
		const view = await render([p('a', '')]);
		const html = serializeClipboardFragmentToHtml(
			{
				version: 1,
				source: 'edytor',
				kind: 'blocks',
				blocks: [
					{
						type: 'toggle-heading',
						data: { level: 'h2' },
						content: [{ text: 'Plan' }],
						children: [{ type: 'paragraph', content: [{ text: 'step' }] }]
					}
				]
			},
			view.edytor
		);
		expect(html).toContain('<details><summary><h2>Plan</h2></summary><p>step</p></details>');
		const external = html.replace(/<span data-edytor-fragment[^>]*><\/span>/, '');
		await at(view, 'a', 0);
		await dispatchClipboardPaste(view.editor, { 'text/html': external, 'text/plain': 'x' });
		expect(shape(view)).toContainEqual(['toggle-heading:h2 "Plan"', ['paragraph "step"']]);
	});
});
