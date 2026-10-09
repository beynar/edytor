/** @jsxImportSource ../../jsx */
/**
 * The render's own markers stay few (`render.markers`): Svelte leaves an
 * empty comment or an empty text node as the anchor of each `{#if}`,
 * `{#each}`, `{@render}`, component and dynamic element it places, and the
 * browser walks every one of them when it recomputes the editing host's text
 * after a keystroke (on a 5,000-block static copy, removing the comments
 * halved a native Enter). Each bundled kind's block, rendered once after a
 * reference paragraph, adds at most its ceiling of comments and of empty text
 * nodes to the host: the ceilings are the counts measured after the markers
 * were reduced, so a new layer that adds some fails here. The Playwright
 * row (`tests/editor-dom/render-markers.spec.ts`) counts the same on a long
 * page in a real browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { columnsPlugin } from '$lib/plugins/columns/ColumnsPlugin.svelte';
import { tablePlugin } from '$lib/plugins/table/TablePlugin.svelte';
import { imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
import { createMentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { createEquationPlugin } from '$lib/plugins/equation/EquationPlugin.svelte';
import { tableBlock } from '$lib/crdt/tables.js';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const plugins = [
	codePlugin,
	columnsPlugin,
	tablePlugin,
	imagePlugin,
	createMentionPlugin({ items: () => [] }),
	createEquationPlugin({ katex: () => import('katex') }),
	richTextPlugin
];

const p = (text: string): JSONBlock => ({ type: 'paragraph', content: [{ text }] });

/** Each case: the blocks it adds after the reference paragraph. */
const CASES: Record<string, JSONBlock[]> = {
	paragraph: [p('plain text')],
	'paragraph, marks': [
		{
			type: 'paragraph',
			content: [
				{ text: 'a ' },
				{ text: 'bold', marks: { bold: true } },
				{ text: ' ' },
				{ text: 'italic', marks: { italic: true } },
				{ text: ' ' },
				{ text: 'code', marks: { code: true } },
				{ text: ' ' },
				{ text: 'link', marks: { link: { href: 'https://example.com' } } },
				{ text: ' z' }
			]
		}
	],
	'paragraph, two marks': [
		{
			type: 'paragraph',
			content: [{ text: 'both', marks: { bold: true, italic: true } }]
		}
	],
	'paragraph, empty': [p('')],
	heading: [{ type: 'heading', data: { level: 'h2' }, content: [{ text: 'heading' }] }],
	'bulleted-list-item': [{ type: 'bulleted-list-item', content: [{ text: 'item' }] }],
	'numbered-list-item': [{ type: 'numbered-list-item', content: [{ text: 'item' }] }],
	'todo-item': [{ type: 'todo-item', data: { checked: false }, content: [{ text: 'todo' }] }],
	'toggle (empty body)': [{ type: 'toggle', content: [{ text: 'toggle' }] }],
	'toggle + 1 child': [{ type: 'toggle', content: [{ text: 'toggle' }], children: [p('kid')] }],
	'callout (empty body)': [
		{ type: 'callout', data: { icon: '💡' }, content: [{ text: 'callout' }] }
	],
	quote: [{ type: 'quote', content: [{ text: 'quote' }] }],
	'paragraph + 1 child': [{ ...p('parent'), children: [p('kid')] }],
	'code block, 1 line': [
		{ type: 'code', children: [{ type: 'codeLine', content: [{ text: 'let x = 1;' }] }] }
	],
	'table 2×2': [
		tableBlock({
			cells: [
				['a', 'b'],
				['c', 'd']
			]
		})
	],
	'columns 2×1': [
		{
			type: 'columns',
			children: [
				{ type: 'column', children: [p('left')] },
				{ type: 'column', children: [p('right')] }
			]
		}
	],
	equation: [{ type: 'equation', data: { expression: 'x^2' } }],
	image: [{ type: 'image', data: { src: 'https://example.com/a.png' } }],
	divider: [{ type: 'divider' }],
	'paragraph, mention': [
		{
			type: 'paragraph',
			content: [
				{ text: 'hi ' },
				{ type: 'mention', data: { id: 'ada', label: 'Ada' } },
				{ text: '!' }
			]
		}
	]
};

/** The blocks a case renders (its own and nested). */
const blocksIn = (blocks: JSONBlock[]): number =>
	blocks.reduce((sum, block) => sum + 1 + blocksIn(block.children ?? []), 0);

/** Comments, empty text nodes, and whitespace-only text nodes between tags. */
type Markers = { comments: number; emptyTexts: number; whitespace: number };

/** The markers inside the editing host. */
const markersIn = (host: Element): Markers => {
	const markers = { comments: 0, emptyTexts: 0, whitespace: 0 };
	const walker = document.createTreeWalker(host, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeType === Node.COMMENT_NODE) markers.comments++;
		else if ((node as Text).data === '') markers.emptyTexts++;
		// Whitespace between tags (a text's own spaces are content).
		else if (!(node as Text).data.trim() && !node.parentElement?.closest('[data-edytor-text]'))
			markers.whitespace++;
	}
	return markers;
};

/** The test runner's process (the row's report). */
const node = (
	globalThis as unknown as {
		process: { env: Record<string, string | undefined>; stdout: { write(s: string): void } };
	}
).process;

const render = async (children: JSONBlock[]) => {
	const { editor, unmount } = await renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins, value: { children: [p('reference'), ...children] }, autoSelectFixture: false }
	);
	// KaTeX loads lazily: the equation's own markup lands after it.
	if (children.some((block) => block.type === 'equation'))
		await vi.waitFor(() => {
			if (!editor.querySelector('[data-edytor-equation] .katex')) throw new Error('not yet');
		});
	await flushDomUpdates();
	const markers = markersIn(editor);
	unmount();
	document.body.innerHTML = '';
	return markers;
};

/**
 * What each case adds to the host at most: [comments, empty text nodes,
 * whitespace text nodes], the counts measured after the reduction (before
 * it, a paragraph added 23 comments, 9 empty text nodes and 1 whitespace
 * node).
 */
const CEILINGS: Record<keyof typeof CASES, [number, number, number]> = {
	paragraph: [8, 1, 0],
	'paragraph, marks': [24, 17, 0],
	'paragraph, two marks': [13, 8, 0],
	'paragraph, empty': [8, 1, 0],
	heading: [10, 3, 0],
	'bulleted-list-item': [8, 1, 0],
	'numbered-list-item': [8, 1, 0],
	'todo-item': [10, 1, 0],
	'toggle (empty body)': [9, 2, 0],
	'toggle + 1 child': [18, 3, 0],
	'callout (empty body)': [12, 3, 0],
	quote: [10, 3, 0],
	'paragraph + 1 child': [18, 3, 0],
	'code block, 1 line': [26, 9, 1],
	'table 2×2': [50, 10, 0],
	'columns 2×1': [31, 11, 0],
	equation: [5, 3, 0],
	image: [9, 1, 0],
	divider: [1, 1, 0],
	'paragraph, mention': [12, 3, 0]
};

describe('render markers (render.markers)', () => {
	let reference: Markers;
	const rows: string[] = [];

	it.each(Object.keys(CASES) as (keyof typeof CASES)[])(
		'%s adds at most its ceiling of markers',
		async (name) => {
			reference ??= await render([]);
			const counts = await render(CASES[name]);
			const added = [
				counts.comments - reference.comments,
				counts.emptyTexts - reference.emptyTexts,
				counts.whitespace - reference.whitespace
			];
			rows.push(`| ${name} | ${blocksIn(CASES[name])} | ${added.join(' | ')} |`);
			const [comments, emptyTexts, whitespace] = CEILINGS[name];
			expect.soft(added[0], 'comments').toBeLessThanOrEqual(comments);
			expect.soft(added[1], 'empty text nodes').toBeLessThanOrEqual(emptyTexts);
			expect.soft(added[2], 'whitespace text nodes').toBeLessThanOrEqual(whitespace);
		}
	);

	// `MARKERS_REPORT=1` prints the measured table (case, blocks, comments, empty, whitespace).
	it.runIf(node.env.MARKERS_REPORT)('report', () => {
		node.stdout.write(`\n${JSON.stringify(reference)}\n${rows.join('\n')}\n`);
	});
});
