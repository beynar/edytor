/** @jsxImportSource ../../jsx */
/**
 * Pasting markdown (`paste.markdown`): a `text/plain` paste with no HTML
 * whose lines hold block markdown (a heading, a list or to-do item, a
 * quote, a fence, a divider) is placed as the blocks it reads as
 * (`textToBlocks`), its inline `**bold**`, `*italic*`, `` `code` `` and
 * links as marks, as one undo step. Kinds the view does not register
 * become paragraphs of their text. Everything else pastes as before: text
 * with no block markdown, HTML, a Shift+paste, a paste into a code block.
 *
 * Expected states are hand-authored from Notion.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import {
	canonicalTree,
	dispatchClipboardPaste,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const render = (plugins = [richTextPlugin, codePlugin]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
			<paragraph>after</paragraph>
		</root>,
		{ plugins }
	);

const paste = async (editor: HTMLElement, plain: string, html = '') => {
	await dispatchClipboardPaste(
		editor,
		html ? { 'text/plain': plain, 'text/html': html } : { 'text/plain': plain }
	);
	await flushDomUpdates();
};

const texts = (edytor: Edytor) =>
	(edytor.value.children ?? []).map((block) =>
		(block.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('')
	);

const MARKDOWN = [
	'# Plan',
	'',
	'Some **bold** and *italic* text,',
	'one paragraph.',
	'',
	'- one',
	'  - nested',
	'- [x] done',
	'1. first',
	'> said',
	'---',
	'```',
	'const x = 1;',
	'```'
].join('\n');

describe('paste.markdown', () => {
	it('block markdown is placed as its blocks, inline markdown as marks', async () => {
		const { edytor, editor } = await render();
		await paste(editor, MARKDOWN);
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'heading', data: { level: 'h1' }, content: [{ text: 'Plan' }] },
			{
				type: 'paragraph',
				content: [
					{ text: 'Some ' },
					{ text: 'bold', marks: { bold: true } },
					{ text: ' and ' },
					{ text: 'italic', marks: { italic: true } },
					{ text: ' text, one paragraph.' }
				]
			},
			{
				type: 'bulleted-list-item',
				content: [{ text: 'one' }],
				children: [{ type: 'bulleted-list-item', content: [{ text: 'nested' }] }]
			},
			{ type: 'todo-item', data: { checked: true }, content: [{ text: 'done' }] },
			{ type: 'numbered-list-item', content: [{ text: 'first' }] },
			{ type: 'quote', content: [{ text: 'said' }] },
			{ type: 'divider' },
			{ type: 'code', children: [{ type: 'codeLine', content: [{ text: 'const x = 1;' }] }] },
			{ type: 'paragraph', content: [{ text: 'after' }] }
		]);
	});

	it('is one undo step', async () => {
		const { edytor, editor } = await render();
		await paste(editor, '# Plan\n- one');
		expect(texts(edytor)).toEqual(['Plan', 'one', 'after']);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['', 'after']);
	});

	it('one line of block markdown converts too', async () => {
		const { edytor, editor } = await render();
		await paste(editor, '- [ ] call back');
		expect(canonicalTree(edytor)[0]).toEqual({
			type: 'todo-item',
			data: { checked: false },
			content: [{ text: 'call back' }]
		});
	});

	it('text with no block markdown pastes as before: its lines, its characters', async () => {
		const { edytor, editor } = await render();
		await paste(editor, 'a *b* c\nd **e**');
		expect(canonicalTree(edytor).slice(0, 2)).toEqual([
			{ type: 'paragraph', content: [{ text: 'a *b* c' }] },
			{ type: 'paragraph', content: [{ text: 'd **e**' }] }
		]);
	});

	it('HTML wins over the markdown of its text/plain', async () => {
		const { edytor, editor } = await render();
		await paste(editor, '# Plan', '<p>Plan</p>');
		expect(canonicalTree(edytor)[0]).toEqual({ type: 'paragraph', content: [{ text: 'Plan' }] });
	});

	it('Shift+paste keeps the characters', async () => {
		const { edytor, editor } = await render();
		await dispatchDomKeyDown(document, { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
		await paste(editor, '# Plan');
		document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', shiftKey: false }));
		expect(canonicalTree(edytor)[0]).toEqual({ type: 'paragraph', content: [{ text: '# Plan' }] });
	});

	it('into a code block, the lines are code', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [richTextPlugin, codePlugin],
				value: {
					children: [
						{
							id: 'c',
							type: 'code',
							children: [{ id: 'l', type: 'codeLine', content: [{ text: 'x' }] }]
						}
					]
				}
			}
		);
		await setNativeSelection(edytor, edytor.idToBlock.get('l')!.firstText!, 1);
		await paste(editor, '\n# not a heading\n- nor a list');
		expect(canonicalTree(edytor)).toEqual([
			{
				type: 'code',
				children: [
					{ type: 'codeLine', content: [{ text: 'x' }] },
					{ type: 'codeLine', content: [{ text: '# not a heading' }] },
					{ type: 'codeLine', content: [{ text: '- nor a list' }] }
				]
			}
		]);
	});

	it('a kind the view does not register becomes paragraphs of its text', async () => {
		const { edytor, editor } = await render([richTextPlugin]);
		await paste(editor, '- item\n```\nline one\nline two\n```');
		expect(canonicalTree(edytor).slice(0, 3)).toEqual([
			{ type: 'bulleted-list-item', content: [{ text: 'item' }] },
			{ type: 'paragraph', content: [{ text: 'line one' }] },
			{ type: 'paragraph', content: [{ text: 'line two' }] }
		]);
	});
});
