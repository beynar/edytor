/** @jsxImportSource ../../jsx */
/**
 * UW-43 — Notion's three heading levels. A heading renders and exports
 * `h1`–`h3`; a deeper level (a stored `h5`) reads as `h3`, as HTML import
 * reads `h4`–`h6`, and a missing level is `h1`.
 */
import { describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { richTextPlaceholder, richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { dispatchCopy, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

const children: JSONBlock[] = [
	{ type: 'heading', data: { level: 'h5' }, content: [{ text: 'five' }] },
	{ type: 'heading', data: { level: 'h2' }, content: [{ text: 'two' }] },
	{ type: 'heading', content: [{ text: 'none' }] }
];

const copyHtml = async (edytor: Edytor, editor: HTMLElement) => {
	edytor.selection.selectBlocks(...edytor.facade.order().map((id) => edytor.idToBlock.get(id)!));
	await flushDomUpdates();
	const html = (await dispatchCopy(editor)).clipboardData['text/html'] ?? '';
	return html.slice(html.indexOf('</span>') + '</span>'.length);
};

describe('heading levels: h1 to h3', () => {
	it('a level h5 heading renders and exports h3; a missing level is h1', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: [richTextPlugin], value: { children } }
		);
		const tags = [...editor.querySelectorAll('[data-edytor-type="heading"] > :first-child')].map(
			(heading) => heading.localName
		);
		expect(tags).toEqual(['h3', 'h2', 'h1']);
		expect(await copyHtml(edytor, editor)).toBe('<h3>five</h3><h2>two</h2><h1>none</h1>');
	});

	it('the placeholder names the level it renders', () => {
		const view = (level?: string) =>
			richTextPlaceholder({
				type: 'heading',
				data: level ? { level } : {},
				focused: false,
				empty: true
			} as Parameters<typeof richTextPlaceholder>[0]);
		expect([view('h5'), view('h2'), view()]).toEqual(['Heading 3', 'Heading 2', 'Heading 1']);
	});
});
