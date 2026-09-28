/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint S6 rows (dom lane): a kind is one record (O68, L47,
 * §10 extension-cost check (a) and (b)).
 *
 * - Extension cost: a NEW block kind (`banner`) and a NEW mark (`glow`), each
 *   declared by ONE record in their own extension (`S6BannerKind.svelte`),
 *   appear in the slash menu (label, icon, keywords, data preset), convert
 *   from their markdown prefix, are listed in the kind catalogue block menus
 *   read (`edytor.kinds`), and export their HTML and plain forms on copy —
 *   without any other module naming them.
 * - Slash menu: the built-in kinds keep their command ids, order, icons and
 *   keywords; one label per kind (the slash menu and the demo block menu
 *   agree: `Text`, `To-do list`, `Toggle list`); the code kind's record is a
 *   slash command wherever the code extension is loaded (not a demo-only
 *   command).
 * - Markdown: every prefix of today's table converts to today's kind and data.
 * - Clipboard export: today's HTML and plain forms for every built-in kind,
 *   mark and atom are unchanged when they come from records; marks wrap in
 *   registration order (first innermost), the order the toolbar shows.
 * - Toolbar: the mark buttons are the mark records' toolbar entries; a new
 *   mark record with one gets a button.
 *
 * Expected values come from the plan rows and today's tables, never from
 * running the code.
 */
import { describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
import { bannerPlugin } from '../../dom/S6BannerKind.svelte';
import {
	canonicalTree,
	dispatchCopy,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

/** Red on the reference; green since S6. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

const empty = (
	<root>
		<paragraph>|</paragraph>
	</root>
);

const render = (plugins: Plugin[], value?: { children: JSONBlock[] }) =>
	renderDomEdytor(empty, { plugins: [richTextPlugin, mentionPlugin, ...plugins], value });

const type = async (editor: HTMLElement, value: string) => {
	for (const data of value) await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
};

const enter = () => dispatchDomKeyDown(document, { key: 'Enter', code: 'Enter' });

/** Slash items as rendered: `id icon label`. */
const items = () =>
	[...document.querySelectorAll('[data-testid="slash-menu-item"]')].map(
		(item) =>
			`${item.getAttribute('data-command-id')} ${item.getAttribute('data-icon')} ${item.textContent}`
	);

/** Copy every top-level block as a block selection; the written flavours. */
const copyAll = async (edytor: Edytor, editor: HTMLElement) => {
	// Every block, nested ones included (select-all; a block selection is exactly its members).
	edytor.selection.selectBlocks(...edytor.facade.order().map((id) => edytor.idToBlock.get(id)!));
	await flushDomUpdates();
	const { clipboardData } = await dispatchCopy(editor);
	const html = clipboardData['text/html'] ?? '';
	// Past the embedded fragment span: the readable HTML flavour.
	return {
		html: html.slice(html.indexOf('</span>') + '</span>'.length),
		plain: clipboardData['text/plain']
	};
};

describe('extension cost: a new kind and a new mark are one record each (§10 (a), (b))', () => {
	row('slash: the kind preset is a command with its label, icon and keywords', async () => {
		const { edytor, editor } = await render([slashMenuPlugin, bannerPlugin]);
		await type(editor, '/announce');
		expect(items()).toEqual(['block.banner ⚑ Banner']);
		await enter();
		expect(canonicalTree(edytor)).toEqual([{ type: 'banner', data: { tone: 'info' } }]);
	});

	row('markdown: the kind prefix converts, with the preset data', async () => {
		const { edytor, editor } = await render([markdownShortcutsPlugin, bannerPlugin]);
		await type(editor, '!! ');
		expect(canonicalTree(edytor)).toEqual([{ type: 'banner', data: { tone: 'info' } }]);
		expect(edytor.selection.state.yStart).toBe(0);
	});

	row('catalogue: block menus read the kind row from edytor.kinds', async () => {
		const { edytor } = await render([bannerPlugin]);
		expect(edytor.kinds.find((kind) => kind.id === 'block.banner')).toMatchObject({
			label: 'Banner',
			icon: '⚑',
			value: { type: 'banner', data: { tone: 'info' } }
		});
	});

	row('clipboard: copy exports the kind and mark HTML forms and the kind plain form', async () => {
		const { edytor, editor } = await render([bannerPlugin], {
			children: [
				{ type: 'banner', data: { tone: 'info' }, content: [{ text: 'Hi' }] },
				{ type: 'paragraph', content: [{ text: 'g', marks: { glow: true } }] }
			]
		});
		expect(await copyAll(edytor, editor)).toEqual({
			html: '<aside data-tone="info">Hi</aside><p><mark>g</mark></p>',
			plain: '! Hi\ng'
		});
	});
});

describe('slash menu: generated from kind records', () => {
	pin('built-in kinds keep their ids, order and icons', async () => {
		const { editor } = await render([slashMenuPlugin]);
		await type(editor, '/');
		expect(items().map((item) => item.split(' ').slice(0, 2).join(' '))).toEqual([
			'block.paragraph T',
			'block.heading1 H₁',
			'block.heading2 H₂',
			'block.heading3 H₃',
			'block.quote ❝',
			'block.bulleted-list-item •',
			'block.numbered-list-item 1.',
			'block.todo-item ☐',
			'block.toggle ▸',
			'block.callout ✦',
			'block.divider —'
		]);
	});

	pin.each([
		['h1', 'block.heading1'],
		['subtitle', 'block.heading2'],
		['h3', 'block.heading3'],
		['bullet', 'block.bulleted-list-item'],
		['ol', 'block.numbered-list-item'],
		['task', 'block.todo-item'],
		['separator', 'block.divider']
	])('keyword "%s" finds %s', async (query, id) => {
		const { editor } = await render([slashMenuPlugin]);
		await type(editor, `/${query}`);
		expect(items().map((item) => item.split(' ')[0])).toEqual([id]);
	});

	row('one label per kind: the slash menu and the block menu agree', async () => {
		const { editor } = await render([slashMenuPlugin]);
		await type(editor, '/');
		expect(
			[...document.querySelectorAll('[data-testid="slash-menu-item"]')].map((i) => i.textContent)
		).toEqual([
			'Text',
			'Heading 1',
			'Heading 2',
			'Heading 3',
			'Quote',
			'Bulleted list',
			'Numbered list',
			'To-do list',
			'Toggle list',
			'Callout',
			'Divider'
		]);
	});

	row('the code kind is a slash command wherever the code extension is loaded', async () => {
		const { edytor, editor } = await render([codePlugin, slashMenuPlugin]);
		await type(editor, '/code');
		expect(items()).toEqual(['block.code </> Code']);
		await enter();
		expect(canonicalTree(edytor)).toEqual([{ type: 'code', children: [{ type: 'codeLine' }] }]);
		expect(edytor.selection.state.startBlock?.type).toBe('codeLine');
	});

	pin('a preset converts with its data (callout icon, todo checked)', async () => {
		const { edytor, editor } = await render([slashMenuPlugin]);
		await type(editor, '/callout');
		await enter();
		await type(editor, '/to');
		expect(items().map((item) => item.split(' ')[0])).toContain('block.todo-item');
		expect(canonicalTree(edytor)[0]).toMatchObject({ type: 'callout', data: { icon: '!' } });
	});
});

describe('markdown shortcuts: generated from kind records', () => {
	pin.each([
		['# ', { type: 'heading', data: { level: 'h1' } }],
		['## ', { type: 'heading', data: { level: 'h2' } }],
		['### ', { type: 'heading', data: { level: 'h3' } }],
		['- ', { type: 'bulleted-list-item' }],
		['* ', { type: 'bulleted-list-item' }],
		['1. ', { type: 'numbered-list-item' }],
		['[ ] ', { type: 'todo-item', data: { checked: false } }],
		['[] ', { type: 'todo-item', data: { checked: false } }],
		['> ', { type: 'quote' }],
		['---', { type: 'divider' }],
		['```', { type: 'code', children: [{ type: 'codeLine' }] }]
	])('"%s" converts to %o', async (typed, expected) => {
		const { edytor, editor } = await render([codePlugin, markdownShortcutsPlugin]);
		await type(editor, typed);
		expect(canonicalTree(edytor)).toEqual([expected]);
	});

	pin(
		'an unregistered kind has no shortcut: "```" without the code extension types text',
		async () => {
			const { edytor, editor } = await render([markdownShortcutsPlugin]);
			await type(editor, '```');
			expect(canonicalTree(edytor)).toEqual([{ type: 'paragraph', content: [{ text: '```' }] }]);
		}
	);
});

describe('clipboard export: the HTML and plain forms come from records', () => {
	const doc: { children: JSONBlock[] } = {
		children: [
			{ type: 'heading', data: { level: 'h2' }, content: [{ text: 'Title' }] },
			{
				type: 'paragraph',
				content: [
					{ text: 'a' },
					{ text: 'b', marks: { bold: true } },
					{ text: 'i', marks: { italic: true } },
					{ text: 'u', marks: { underline: true } },
					{ text: 's', marks: { strike: true } },
					{ text: 'k', marks: { code: true } },
					{ text: 'y', marks: { bold: true, italic: true } },
					{ text: '<&>' }
				]
			},
			{ type: 'quote', content: [{ text: 'q' }] },
			{
				type: 'bulleted-list-item',
				content: [{ text: 'one' }],
				children: [{ type: 'numbered-list-item', content: [{ text: 'two' }] }]
			},
			{ type: 'todo-item', data: { checked: true }, content: [{ text: 'done' }] },
			{ type: 'divider' },
			{ type: 'code', children: [{ type: 'codeLine', content: [{ text: 'let x' }] }] },
			{ type: 'ordered-list', children: [{ type: 'list-item', content: [{ text: 'li' }] }] },
			{
				type: 'paragraph',
				content: [{ text: 'hi ' }, { type: 'mention', data: {} }, { text: '' }]
			},
			{ type: 'horizontalRule' },
			{ type: 'image', content: [{ text: 'cap' }] },
			{ type: 'unordered-list', children: [{ type: 'list-item', content: [{ text: 'u1' }] }] },
			{ type: 'todo-item', data: { checked: false }, content: [{ text: 'open' }] }
		]
	};

	row('marks wrap in registration order, first innermost (the toolbar order)', async () => {
		const { edytor, editor } = await render([], {
			children: [{ type: 'paragraph', content: [{ text: 'x', marks: { code: true, bold: true } }] }]
		});
		// The reference's exporter hard-coded code innermost: `<strong><code>x</code></strong>`.
		expect((await copyAll(edytor, editor)).html).toBe('<p><code><strong>x</strong></code></p>');
	});

	pin('every built-in kind, mark and atom keeps its export form', async () => {
		const { edytor, editor } = await render([codePlugin, imagePlugin], doc);
		expect(await copyAll(edytor, editor)).toEqual({
			html: [
				'<h2>Title</h2>',
				'<p>a<strong>b</strong><em>i</em><u>u</u><s>s</s><code>k</code>',
				'<em><strong>y</strong></em>&lt;&amp;&gt;</p>',
				'<blockquote>q</blockquote>',
				'<li>one<li>two</li></li>',
				'<li data-edytor-todo-item="true"><input type="checkbox" checked>done</li>',
				'<hr>',
				'<p></p><pre><code>let x</code></pre>',
				'<ol><li>li</li></ol>',
				'<p>hi <span data-edytor-inline-block="mention"></span></p>',
				'<hr>',
				'<figure><figcaption>cap</figcaption></figure>',
				'<ul><li>u1</li></ul>',
				'<li data-edytor-todo-item="true"><input type="checkbox">open</li>'
			].join(''),
			plain: [
				'Title',
				'abiusky<&>',
				'q',
				'one',
				'two',
				'[x] done',
				'---',
				'let x',
				'li',
				'hi @mention',
				'---',
				'cap',
				'u1',
				'[ ] open'
			].join('\n')
		});
	});
});

describe('toolbar: mark buttons come from mark records', () => {
	const buttons = () =>
		[
			...document.querySelectorAll(
				'[data-testid="selection-toolbar"] button[data-testid^="toolbar-"]'
			)
		]
			.filter((button) => !/link/.test(button.getAttribute('data-testid') ?? ''))
			.map(
				(button) =>
					`${button.getAttribute('data-testid')} ${button.getAttribute('aria-label')} ${button.textContent}`
			);

	const selected = (
		<root>
			<paragraph>|Hello|</paragraph>
		</root>
	);

	pin('built-in marks keep their buttons, order, labels and icons', async () => {
		await renderDomEdytor(selected, { plugins: [richTextPlugin, mentionPlugin, toolbarPlugin] });
		expect(buttons()).toEqual([
			'toolbar-bold Bold B',
			'toolbar-italic Italic I',
			'toolbar-underline Underline U',
			'toolbar-strike Strike S',
			'toolbar-code Code </>'
		]);
	});

	row('a new mark record with a toolbar entry gets a button that toggles it', async () => {
		const { edytor } = await renderDomEdytor(selected, {
			plugins: [richTextPlugin, mentionPlugin, toolbarPlugin, bannerPlugin]
		});
		expect(buttons().at(-1)).toBe('toolbar-glow Glow ✧');
		const button = document.querySelector('[data-testid="toolbar-glow"]') as HTMLElement;
		button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'Hello', marks: { glow: true } }] }
		]);
	});
});
