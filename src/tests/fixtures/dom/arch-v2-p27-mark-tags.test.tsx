/** @jsxImportSource ../../jsx */
/**
 * arch-v2 phase 2 — P2.7 rows (dom lane): marks are declared by tag (gem 2).
 *
 * - One core element per mark: a mark record's `tag` is the element the core
 *   renders (`<tag data-edytor-mark>`, registered, the observer's ownership
 *   table unchanged) and the element the clipboard's HTML export writes —
 *   render and export cannot disagree (the reference rendered bold `<b>` and
 *   exported `<strong>`).
 * - Value marks declare their attributes from the value, sanitized once for
 *   both: an unsafe link scheme and a hostile color drop the attribute.
 * - A consumer snippet still renders inside the core `<span data-edytor-mark>`.
 * - The host stays the projection of its cells (compare-to-truth).
 *
 * Expected values come from the plan (gem 2, P2.7) and the S6 export pins,
 * never from running the code.
 */
import { describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONText, SerializableContent } from '$lib/utils/json.js';
import { truthOf } from '../../oracles/truth.js';
import { dispatchCopy, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

/** Red on the reference; green since P2.7. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

const MARKS: [name: string, value: SerializableContent, element: string][] = [
	['bold', true, '<strong>x</strong>'],
	['italic', true, '<em>x</em>'],
	['underline', true, '<u>x</u>'],
	['strike', true, '<s>x</s>'],
	['code', true, '<code>x</code>'],
	[
		'link',
		{ href: 'https://example.com/', target: '_blank' },
		'<a href="https://example.com/" target="_blank">x</a>'
	],
	['superscript', true, '<sup>x</sup>'],
	['subscript', true, '<sub>x</sub>'],
	['color', 'red', '<span style="color: red;">x</span>'],
	['highlight', 'yellow', '<span style="background-color: yellow;">x</span>']
];

const one = (marks: JSONText['marks']) => ({
	children: [{ type: 'paragraph', content: [{ text: 'x', marks }] }]
});

const render = (marks: JSONText['marks']) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin, mentionPlugin], value: one(marks) }
	);

/** The rendered mark element without the core's identity attributes (and Svelte's anchors). */
const rendered = (editor: HTMLElement) => {
	const element = editor.querySelector('[data-edytor-mark]')!.cloneNode(true) as Element;
	for (const name of ['data-edytor-mark', 'data-edytor-mark-void']) element.removeAttribute(name);
	return element.outerHTML.replace(/<!---->/g, '');
};

/** The readable HTML flavour of a copy of the whole first block. */
const exported = async (edytor: Edytor, editor: HTMLElement) => {
	edytor.selection.selectBlocks(edytor.root!.children[0]!);
	await flushDomUpdates();
	const html = (await dispatchCopy(editor)).clipboardData['text/html'] ?? '';
	return html.slice(html.indexOf('</span>') + '</span>'.length);
};

describe('P2.7 — a mark renders and exports one element', () => {
	for (const [name, value, element] of MARKS) {
		row(`${name}: rendered as ${element}, exported as the same`, async () => {
			const { edytor, editor } = await render({ [name]: value });
			expect(rendered(editor)).toBe(element);
			expect(await exported(edytor, editor)).toBe(`<p>${element}</p>`);
			expect(truthOf(edytor)).toEqual([]);
		});
	}

	row('the core element is the registered mark element; no wrapper span', async () => {
		const { edytor, editor } = await render({ bold: true, italic: true });
		const bold = editor.querySelector('[data-edytor-mark="bold"]')!;
		expect(bold.localName).toBe('strong');
		expect(bold.parentElement!.hasAttribute('data-edytor-text')).toBe(true);
		expect(bold.firstElementChild?.localName).toBe('em');
		expect(bold.firstElementChild?.getAttribute('data-edytor-mark')).toBe('italic');
		expect(truthOf(edytor)).toEqual([]);
	});

	row('an unsafe link scheme renders and exports an inert anchor', async () => {
		const { edytor, editor } = await render({
			link: { href: 'javascript:alert(1)', target: '_blank' }
		});
		expect(rendered(editor)).toBe('<a>x</a>');
		expect(await exported(edytor, editor)).toBe('<p><a>x</a></p>');
	});

	row('a hostile color renders and exports without a style', async () => {
		const { edytor, editor } = await render({ color: 'red; position: fixed' });
		expect(rendered(editor)).toBe('<span>x</span>');
		expect(await exported(edytor, editor)).toBe('<p><span>x</span></p>');
	});
});

describe('P2.7 — custom markup keeps its snippet', () => {
	pin('a snippet mark (code tokens) renders inside the core span', async () => {
		const { edytor, editor } = await renderDomEdytor(<root />, {
			plugins: [codePlugin, richTextPlugin, mentionPlugin],
			value: {
				children: [{ type: 'code', children: [{ type: 'codeLine', content: [{ text: 'let x' }] }] }]
			}
		});
		await flushDomUpdates();
		const token = editor.querySelector('[data-edytor-mark="codeToken"]')!;
		expect(token.localName).toBe('span');
		expect(token.firstElementChild?.className).toBe('token keyword');
		expect(truthOf(edytor)).toEqual([]);
	});
});
