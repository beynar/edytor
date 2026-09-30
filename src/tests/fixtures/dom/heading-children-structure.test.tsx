/** @jsxImportSource ../../jsx */
/**
 * SW19 — a heading's or quote's nested blocks render outside its `h1`–`h3`
 * or `blockquote`. The block element is a neutral `div`; the semantic tag
 * wraps the block's own text only and the children follow it in a sibling
 * container, so page-level `h1` rules never reach a nested paragraph and a
 * screen reader never reads nested blocks as part of the title. Expected
 * states are hand-authored. The computed-style row (a page `h1` rule) runs
 * in Chromium: `tests/editor-dom/heading-children.spec.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render as mount, waitFor } from '@testing-library/svelte';
import Edytor from '$lib/components/Edytor.svelte';
import { ownBlock } from './HeadingQuoteOverride.svelte';
import type { Edytor as EdytorRuntime } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Plugin } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import {
	canonicalTree,
	dispatchClipboardPaste,
	dispatchCopy,
	dispatchDomBeforeInput,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const kid = (id: string): JSONBlock => ({ id, type: 'paragraph', content: [{ text: id }] });
const heading = (id: string, level: string, children: JSONBlock[] = []): JSONBlock => ({
	id,
	type: 'heading',
	data: { level },
	content: [{ text: 'Title' }],
	children
});

const render = (children: JSONBlock[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin], value: { children }, autoSelectFixture: false }
	);

const blockNode = (editor: HTMLElement, id: string) =>
	editor.querySelector<HTMLElement>(`[data-edytor-id="${id}"]`)!;

const copyHtml = async (edytor: EdytorRuntime, editor: HTMLElement) => {
	edytor.selection.selectBlocks(...edytor.facade.order().map((id) => edytor.idToBlock.get(id)!));
	await flushDomUpdates();
	const html = (await dispatchCopy(editor)).clipboardData['text/html'] ?? '';
	return html.slice(html.indexOf('</span>') + '</span>'.length);
};

describe('a heading or quote with children: the tag wraps its own text only', () => {
	it('no block element is inside an h1, h2, h3 or blockquote', async () => {
		const { editor } = await render([
			heading('H1', 'h1', [kid('a')]),
			heading('H2', 'h2', [kid('b')]),
			heading('H3', 'h3', [kid('c')]),
			{ id: 'Q', type: 'quote', content: [{ text: 'Said' }], children: [kid('d')] }
		]);
		expect(editor.querySelectorAll(':is(h1, h2, h3, blockquote) [data-edytor-block]')).toHaveLength(
			0
		);
		const own = (id: string) => {
			const node = blockNode(editor, id);
			const tag = node.querySelector(':scope > :is(h1, h2, h3, blockquote)');
			return [node.localName, tag?.localName, tag?.textContent?.replace(/\u200B/g, '')];
		};
		expect([own('H1'), own('H2'), own('H3'), own('Q')]).toEqual([
			['div', 'h1', 'Title'],
			['div', 'h2', 'Title'],
			['div', 'h3', 'Title'],
			['div', 'blockquote', 'Said']
		]);
	});

	it('the heading level still follows data.level and the exported HTML is valid', async () => {
		const { edytor, editor } = await render([
			heading('H', 'h5', [kid('a')]),
			{ id: 'Q', type: 'quote', content: [{ text: 'q' }], children: [kid('b')] }
		]);
		expect(blockNode(editor, 'H').querySelector(':scope > h3')).not.toBeNull();
		expect(await copyHtml(edytor, editor)).toBe(
			'<h3>Title</h3><p>a</p><blockquote>q<p>b</p></blockquote>'
		);
	});
});

describe('caret in a heading with children', () => {
	it('a caret in the title maps to the heading; typing stays in the h1', async () => {
		const { edytor, editor } = await render([heading('H', 'h1', [kid('a')])]);
		const title = edytor.idToBlock.get('H')!.firstText!;
		await setNativeSelection(edytor, title, 5);
		expect(edytor.selection.state.startText?.parent.id).toBe('H');
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '!' });
		expect(edytor.value.children?.[0]).toMatchObject({
			type: 'heading',
			content: [{ text: 'Title!' }],
			children: [{ type: 'paragraph', content: [{ text: 'a' }] }]
		});
		const { anchorNode, anchorOffset } = window.getSelection()!;
		expect(anchorNode?.parentElement?.closest('[data-edytor-block]')).toBe(blockNode(editor, 'H'));
		expect(anchorNode?.parentElement?.closest('h1')).not.toBeNull();
		expect(anchorOffset).toBe(6);
		expect(edytor.selection.state.yStart).toBe(6);
	});

	it('a caret in the nested paragraph maps to the child, outside the h1', async () => {
		const { edytor, editor } = await render([heading('H', 'h1', [kid('a')])]);
		await setNativeSelection(edytor, edytor.idToBlock.get('a')!.firstText!, 1);
		expect(edytor.selection.state.startText?.parent.id).toBe('a');
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'b' });
		expect(edytor.value.children?.[0]?.children).toMatchObject([
			{ type: 'paragraph', content: [{ text: 'ab' }] }
		]);
		const { anchorNode } = window.getSelection()!;
		expect(anchorNode?.parentElement?.closest('[data-edytor-block]')).toBe(blockNode(editor, 'a'));
		expect(anchorNode?.parentElement?.closest('h1')).toBeNull();
	});
});

describe('the exported HTML imports back', () => {
	it('a quote with a child reads back as a quote holding that child', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: [richTextPlugin] }
		);
		await dispatchClipboardPaste(editor, {
			'text/html': '<h2>Title</h2><blockquote>q<p>b</p></blockquote>'
		});
		await flushDomUpdates();
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'heading', data: { level: 'h2' }, content: [{ text: 'Title' }] },
			{
				type: 'quote',
				content: [{ text: 'q' }],
				children: [{ type: 'paragraph', content: [{ text: 'b' }] }]
			}
		]);
	});
});

describe('a consumer snippet override keeps the heading tag and the blockquote', () => {
	it('headingBlock and quoteBlock replace the snippet; h2 and blockquote still wrap the text', async () => {
		const rendered = mount(Edytor, {
			props: {
				plugins: [richTextPlugin],
				value: {
					children: [
						heading('H', 'h2', [kid('a')]),
						{ id: 'Q', type: 'quote', content: [{ text: 'Said' }], children: [kid('b')] }
					]
				},
				headingBlock: ownBlock,
				quoteBlock: ownBlock
			} as never
		});
		await waitFor(() =>
			expect(rendered.container.querySelector('[data-edytor-id="b"]')).not.toBeNull()
		);
		const editor = rendered.container.querySelector<HTMLElement>('[data-edytor]')!;
		const shape = (id: string) => {
			const node = blockNode(editor, id);
			return [...node.children].map((child) =>
				[child.localName, child.className, child.textContent?.replace(/\u200B/g, '').trim()].join(
					'|'
				)
			);
		};
		expect(shape('H')).toEqual(['span|own-mark|“', 'h2||Title', 'div|own-children|a']);
		expect(shape('Q')).toEqual(['span|own-mark|“', 'blockquote||Said', 'div|own-children|b']);
	});
});

describe('a kind declaring contentElement is found by that tag on import', () => {
	it('pasting <aside> makes the kind whose content element is aside', async () => {
		const note: Plugin = () => ({
			blocks: { note: { contentElement: 'aside', presets: [{ label: 'Note' }] } }
		});
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: [note, richTextPlugin] }
		);
		await dispatchClipboardPaste(editor, { 'text/html': '<aside>Aside</aside><p>after</p>' });
		await flushDomUpdates();
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'note', content: [{ text: 'Aside' }] },
			{ type: 'paragraph', content: [{ text: 'after' }] }
		]);
	});
});
