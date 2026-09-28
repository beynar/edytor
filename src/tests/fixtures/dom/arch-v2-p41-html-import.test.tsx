/** @jsxImportSource ../../jsx */
/**
 * arch-v2 phase 2 — P4.1 rows (dom lane): HTML import through the browser's
 * parser, restoring the feature D8 (D-24 G-a) retired (gem 3).
 *
 * - The former `paste-html.spec.ts` rows (deleted in 31ecc69), on the dom
 *   lane: HTML beats `text/plain`; inline code; the semantic aliases (`b`,
 *   `i`, `sup`, `sub`, `mark`); paragraphs split the block (D-4); an empty
 *   target adopts the first line's kind (`flow.inline`); lists; empty HTML
 *   falls back to `text/plain`; malformed HTML over a range (adapted: the
 *   browser's parser reconstructs `<strong>` into the second paragraph, and
 *   D-4 places two lines).
 * - Tag tables come from the records, not a switch: a kind's export form or
 *   element per preset (`h1`–`h3` → heading level, `blockquote`, `li`, `hr`
 *   → divider, `details` → toggle; a container kind takes its default
 *   child's tag, `pre` → code), a kind's `parse` hook (`ol > li`, `h4`–`h6`),
 *   a mark's `tag`, and a mark's `parse` hook next to the sanitizers (links,
 *   colors, highlights, the `b`/`i`/`s` aliases). A new kind record is
 *   imported without naming it anywhere else.
 * - Safety: `javascript:` hrefs, hostile colors, scripts, styles and event
 *   handlers never reach the model.
 * - Unknown tags degrade to text runs; whitespace follows HTML rendering
 *   (collapsed; indentation between blocks makes nothing; `<br>` is a soft
 *   line break).
 * - Paste order: internal MIME, embedded fragment, a plugin's `onPaste`,
 *   HTML import, `text/plain`; Shift-paste is plain. Empty or garbage HTML
 *   changes nothing and adds no undo step (F-P10); an import is one step.
 * - Round trip: the HTML the clipboard exports imports back to the same
 *   blocks and marks (render, export and import read one record).
 *
 * Expected values come from the old browser spec, the plan (gem 3, P4.1) and
 * the `flow.*` contract rows, never from running the code.
 */
import { describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { attemptOf } from '$lib/session/attempt.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { bannerPlugin } from '../../dom/S6BannerKind.svelte';
import {
	canonicalTree,
	dispatchClipboardPaste,
	dispatchCopy,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference (HTML import retired); green since P4.1. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

const texts = (edytor: Edytor) =>
	(edytor.value.children ?? []).map((block) =>
		(block.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('')
	);

const caret = (edytor: Edytor) => ({
	block: edytor.selection.state.startBlock?.path,
	at: edytor.selection.state.yStart,
	collapsed: edytor.selection.state.isCollapsed
});

const blockText = (edytor: Edytor, index: number) => edytor.root!.children[index]!.firstText;

/** `/test/dom?scenario=basic`: lead, note and an empty last block. */
const basic = () => (
	<root>
		<paragraph>lead</paragraph>
		<paragraph>note</paragraph>
		<paragraph></paragraph>
	</root>
);

/** An empty first block (`empty=first`), the caret in it. */
const emptyFirst = () => (
	<root>
		<paragraph>|</paragraph>
		<paragraph>note</paragraph>
		<paragraph>tail</paragraph>
	</root>
);

/** Paste `html` (and `plain`) into an empty document; the resulting blocks. */
const imported = async (html: string, plugins?: Plugin[], plain = '') => {
	const { edytor, editor } = await renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		plugins ? { plugins } : {}
	);
	await dispatchClipboardPaste(editor, { 'text/html': html, 'text/plain': plain });
	await flushDomUpdates();
	return canonicalTree(edytor);
};

describe('the former paste-html.spec rows (dom lane)', () => {
	row('paste-html.spec:21 — text/html beats text/plain; <strong> is bold', async () => {
		const { edytor, editor } = await renderDomEdytor(emptyFirst());
		await dispatchClipboardPaste(editor, {
			'text/html': '<p><strong>Bold</strong></p>',
			'text/plain': 'Plain'
		});
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'Bold', marks: { bold: true } }] },
			{ type: 'paragraph', content: [{ text: 'note' }] },
			{ type: 'paragraph', content: [{ text: 'tail' }] }
		]);
	});

	row('paste-html.spec:59 — inline code is the code mark', async () => {
		expect((await imported('<p><code>const x = 1;</code></p>'))[0]).toEqual({
			type: 'paragraph',
			content: [{ text: 'const x = 1;', marks: { code: true } }]
		});
	});

	row('paste-html.spec:87 — semantic aliases map to the rich-text marks', async () => {
		expect(
			(
				await imported(
					'<p><b>Bold</b><i>Italic</i><sup>Sup</sup><sub>Sub</sub><mark>Mark</mark></p>'
				)
			)[0]
		).toEqual({
			type: 'paragraph',
			content: [
				{ text: 'Bold', marks: { bold: true } },
				{ text: 'Italic', marks: { italic: true } },
				{ text: 'Sup', marks: { superscript: true } },
				{ text: 'Sub', marks: { subscript: true } },
				{ text: 'Mark', marks: { highlight: 'yellow' } }
			]
		});
	});

	row('paste-html.spec:121 — <p>Alpha</p><p>Beta</p> at le|ad splits the block (D-4)', async () => {
		const { edytor, editor } = await renderDomEdytor(basic(), { autoSelectFixture: false });
		await setNativeSelection(edytor, blockText(edytor, 0), 2);
		await dispatchClipboardPaste(editor, { 'text/html': '<p>Alpha</p><p>Beta</p>' });
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['leAlpha', 'Betaad', 'note', '']);
		expect(caret(edytor)).toEqual({ block: [1], at: 4, collapsed: true });
	});

	row('paste-html.spec:153 — an empty target adopts the first line kind', async () => {
		expect((await imported('<blockquote>Quoted</blockquote>'))[0]).toEqual({
			type: 'quote',
			content: [{ text: 'Quoted' }]
		});
	});

	row('paste-html.spec:180 — lists become list items (ul → bulleted, ol → numbered)', async () => {
		const { edytor, editor } = await renderDomEdytor(emptyFirst());
		await dispatchClipboardPaste(editor, {
			'text/html': '<ul><li>Bullet</li></ul><ol><li>Number</li></ol>'
		});
		expect(canonicalTree(edytor).slice(0, 2)).toEqual([
			{ type: 'bulleted-list-item', content: [{ text: 'Bullet' }] },
			{ type: 'numbered-list-item', content: [{ text: 'Number' }] }
		]);
	});

	pin('paste-html.spec:212 — empty text/html falls back to text/plain', async () => {
		const { edytor, editor } = await renderDomEdytor(emptyFirst());
		await dispatchClipboardPaste(editor, { 'text/html': '', 'text/plain': 'Plain text' });
		expect(texts(edytor)[0]).toBe('Plain text');
	});

	row('paste-html.spec:237 — malformed html over a range places two lines (D-4)', async () => {
		const { edytor, editor } = await renderDomEdytor(basic(), { autoSelectFixture: false });
		await setNativeSelection(edytor, blockText(edytor, 0), 1, blockText(edytor, 1), 2);
		await dispatchClipboardPaste(editor, {
			'text/html': '<p><strong>oops<p>tail',
			'text/plain': 'fallback'
		});
		await flushDomUpdates();
		// The parser closes the first <p> and reconstructs <strong> into the second.
		expect(canonicalTree(edytor).map((block) => block.content)).toEqual([
			[{ text: 'l' }, { text: 'oops', marks: { bold: true } }],
			[{ text: 'tail', marks: { bold: true } }, { text: 'te' }],
			undefined
		]);
		expect(caret(edytor)).toEqual({ block: [1], at: 4, collapsed: true });
	});
});

describe('tag tables from the records', () => {
	row('h1–h3 are heading presets; h4–h6 take the heading parse hook (h3)', async () => {
		expect(await imported('<h1>A</h1><h2>B</h2><h3>C</h3><h5>D</h5>')).toEqual([
			{ type: 'heading', data: { level: 'h1' }, content: [{ text: 'A' }] },
			{ type: 'heading', data: { level: 'h2' }, content: [{ text: 'B' }] },
			{ type: 'heading', data: { level: 'h3' }, content: [{ text: 'C' }] },
			{ type: 'heading', data: { level: 'h3' }, content: [{ text: 'D' }] }
		]);
	});

	row('hr is the divider (a void kind); details/summary is the toggle', async () => {
		expect(
			await imported('<p>a</p><hr><details><summary>More</summary><p>Body</p></details>')
		).toEqual([
			{ type: 'paragraph', content: [{ text: 'a' }] },
			{ type: 'divider' },
			{
				type: 'toggle',
				content: [{ text: 'More' }],
				children: [{ type: 'paragraph', content: [{ text: 'Body' }] }]
			}
		]);
	});

	row('nested lists nest; a list item keeps its marks', async () => {
		expect(
			await imported('<ul><li>one <b>bold</b><ol><li>two</li></ol></li><li>three</li></ul>')
		).toEqual([
			{
				type: 'bulleted-list-item',
				content: [{ text: 'one ' }, { text: 'bold', marks: { bold: true } }],
				children: [{ type: 'numbered-list-item', content: [{ text: 'two' }] }]
			},
			{ type: 'bulleted-list-item', content: [{ text: 'three' }] }
		]);
	});

	row('pre is the code kind (its default child’s tag), one code line per line', async () => {
		expect(
			await imported('<p>x</p><pre><code>let a = 1;\n  a++;\n</code></pre>', [
				codePlugin,
				richTextPlugin,
				mentionPlugin
			])
		).toEqual([
			{ type: 'paragraph', content: [{ text: 'x' }] },
			{
				type: 'code',
				children: [
					{ type: 'codeLine', content: [{ text: 'let a = 1;' }] },
					{ type: 'codeLine', content: [{ text: '  a++;' }] }
				]
			}
		]);
	});

	pin('without the code extension, pre keeps its text and line breaks', async () => {
		expect(await imported('<p>x</p><pre>a  b\nc</pre>')).toEqual([
			{ type: 'paragraph', content: [{ text: 'x' }] },
			{ type: 'paragraph', content: [{ text: 'a  b\nc' }] }
		]);
	});

	row('a new kind record imports by its export form (banner: <aside>)', async () => {
		expect(
			await imported('<p>x</p><aside>Hi</aside>', [richTextPlugin, mentionPlugin, bannerPlugin])
		).toEqual([
			{ type: 'paragraph', content: [{ text: 'x' }] },
			{ type: 'banner', data: { tone: 'info' }, content: [{ text: 'Hi' }] }
		]);
	});

	row('links, colors and highlights come through the marks’ parse hooks', async () => {
		expect(
			(
				await imported(
					'<p><a href="https://example.com/?a=1&amp;b=2" target="_blank">L</a>' +
						'<span style="color: red">C</span><span style="background-color: #ff0">H</span>' +
						'<u>U</u><s>S</s><del>D</del><em>E</em></p>'
				)
			)[0]
		).toEqual({
			type: 'paragraph',
			content: [
				{ text: 'L', marks: { link: { href: 'https://example.com/?a=1&b=2', target: '_blank' } } },
				{ text: 'C', marks: { color: 'red' } },
				{ text: 'H', marks: { highlight: 'rgb(255, 255, 0)' } },
				{ text: 'U', marks: { underline: true } },
				{ text: 'SD', marks: { strike: true } },
				{ text: 'E', marks: { italic: true } }
			]
		});
	});

	row('Google Docs: the font-weight:normal <b> wrapper is not bold; styled spans are', async () => {
		expect(
			(
				await imported(
					'<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span style="font-weight:700;background-color:transparent">Bold</span><span style="font-style:italic">It</span> plain</p></b>'
				)
			)[0]
		).toEqual({
			type: 'paragraph',
			content: [
				{ text: 'Bold', marks: { bold: true } },
				{ text: 'It', marks: { italic: true } },
				{ text: ' plain' }
			]
		});
	});
});

describe('safety', () => {
	row('an unsafe href, a hostile color and an event handler never reach the model', async () => {
		const blocks = await imported(
			'<p><a href="javascript:alert(1)">x</a><span style="color: red; position: fixed">y</span>' +
				'<img src="x" onerror="alert(1)"><b onclick="alert(1)">z</b></p>'
		);
		expect(blocks).toEqual([
			{
				type: 'paragraph',
				content: [{ text: 'xy' }, { text: 'z', marks: { bold: true } }]
			}
		]);
	});

	row('scripts, styles, templates and comments are dropped', async () => {
		expect(
			await imported(
				'<style>p{}</style><p>Before<!-- c -->After</p><script>alert(1)</script><template><p>t</p></template>'
			)
		).toEqual([{ type: 'paragraph', content: [{ text: 'BeforeAfter' }] }]);
	});
});

describe('degradation and whitespace', () => {
	row('unknown tags are text; unknown blocks are paragraphs', async () => {
		expect(
			await imported(
				'<section><p>Text with <x-unknown>unknown</x-unknown> tag</p><article>Art</article></section>'
			)
		).toEqual([
			{ type: 'paragraph', content: [{ text: 'Text with unknown tag' }] },
			{ type: 'paragraph', content: [{ text: 'Art' }] }
		]);
	});

	row('whitespace collapses like HTML; indentation between blocks makes nothing', async () => {
		expect(
			await imported(`
				<p>  This is <strong>bold</strong>   and
					<em>italic</em>  </p>
				<p><strong><em>Deeply</em> <u>nested</u></strong></p>
			`)
		).toEqual([
			{
				type: 'paragraph',
				content: [
					{ text: 'This is ' },
					{ text: 'bold', marks: { bold: true } },
					{ text: ' and ' },
					{ text: 'italic', marks: { italic: true } }
				]
			},
			{
				type: 'paragraph',
				content: [
					{ text: 'Deeply', marks: { bold: true, italic: true } },
					{ text: ' ', marks: { bold: true } },
					{ text: 'nested', marks: { bold: true, underline: true } }
				]
			}
		]);
	});

	row('<br> is a soft line break; a trailing one is dropped; &nbsp; is a space', async () => {
		expect(await imported('<p>Line with<br>break<br></p><p>a&nbsp;&nbsp;b</p>')).toEqual([
			{ type: 'paragraph', content: [{ text: 'Line with\nbreak' }] },
			{ type: 'paragraph', content: [{ text: 'a  b' }] }
		]);
	});

	row('text around blocks is a run of its own; an empty paragraph is an empty line', async () => {
		expect(await imported('Before<p>Content</p><p></p><strong>After</strong>')).toEqual([
			{ type: 'paragraph', content: [{ text: 'Before' }] },
			{ type: 'paragraph', content: [{ text: 'Content' }] },
			{ type: 'paragraph', content: [{ text: '' }] },
			{ type: 'paragraph', content: [{ text: 'After', marks: { bold: true } }] }
		]);
	});
});

describe('paste order and history', () => {
	pin('F-P10 — garbage html with no text/plain: no change, no undo step', async () => {
		for (const html of ['<!-- c -->', '<script>alert(1)</script>', '<p></p><span></span>', '<']) {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<heading level="h2">|</heading>
				</root>
			);
			const before = JSON.stringify(edytor.value);
			const undo = edytor.undoManager.undoStack.length;
			await dispatchClipboardPaste(editor, { 'text/html': html, 'text/plain': '' });
			await flushDomUpdates();
			expect(JSON.stringify(edytor.value)).toBe(before);
			expect(edytor.undoManager.undoStack.length).toBe(undo);
		}
	});

	row('an html import is one undo step', async () => {
		const { edytor, editor } = await renderDomEdytor(basic(), { autoSelectFixture: false });
		await setNativeSelection(edytor, blockText(edytor, 0), 2);
		const undo = edytor.undoManager.undoStack.length;
		await dispatchClipboardPaste(editor, { 'text/html': '<h2>A</h2><p><b>B</b></p>' });
		await flushDomUpdates();
		expect(edytor.undoManager.undoStack.length).toBe(undo + 1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['lead', 'note', '']);
	});

	pin('the embedded internal fragment beats the html body', async () => {
		const source = await renderDomEdytor(
			<root>
				<paragraph>
					<italic>Internal</italic>
				</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		source.edytor.selection.selectBlocks(source.edytor.root!.children[0]!);
		await flushDomUpdates();
		const copied = (await dispatchCopy(source.editor)).clipboardData;
		const html = copied['text/html']!.replace('<p>', '<p><b>Body</b>');
		source.unmount();
		const { edytor, editor } = await renderDomEdytor(emptyFirst());
		await dispatchClipboardPaste(editor, { 'text/html': html, 'text/plain': 'Plain' });
		// A block-selection copy is whole: it replaces the empty block (`flow.whole`).
		expect(canonicalTree(edytor)[0]).toEqual({
			type: 'paragraph',
			content: [{ text: 'Internal', marks: { italic: true } }]
		});
	});

	pin('a plugin onPaste claims before html import', async () => {
		const claim: Plugin = () => ({
			onPaste: ({ prevent }) => prevent(() => undefined)
		});
		const { edytor, editor } = await renderDomEdytor(emptyFirst(), {
			plugins: [claim, richTextPlugin, mentionPlugin]
		});
		await dispatchClipboardPaste(editor, { 'text/html': '<h1>H</h1>', 'text/plain': 'H' });
		expect(texts(edytor)).toEqual(['', 'note', 'tail']);
	});

	pin('Shift-paste is plain text', async () => {
		const { edytor, editor } = await renderDomEdytor(emptyFirst());
		await dispatchDomKeyDown(document, { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
		await dispatchClipboardPaste(editor, { 'text/html': '<h1>H</h1>', 'text/plain': 'Plain' });
		document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', shiftKey: false }));
		expect(canonicalTree(edytor)[0]).toEqual({ type: 'paragraph', content: [{ text: 'Plain' }] });
	});

	pin('garbage html with a text/plain places the text/plain', async () => {
		const { edytor, editor } = await renderDomEdytor(emptyFirst());
		await dispatchClipboardPaste(editor, { 'text/html': '<p></p>', 'text/plain': 'Plain' });
		expect(texts(edytor)[0]).toBe('Plain');
	});

	row('drop-beforeinput.spec:137 — a foreign html drop is imported', async () => {
		const { edytor } = await renderDomEdytor(basic(), { autoSelectFixture: false });
		await setNativeSelection(edytor, blockText(edytor, 1), 2);
		await runBeforeInputCommand(
			edytor,
			attemptOf(edytor, {
				inputType: 'insertFromDrop',
				data: null,
				dataTransfer: {
					types: ['text/html', 'text/plain'],
					files: [],
					getData: (type: string) =>
						({ 'text/html': '<p><strong>Bold</strong></p>', 'text/plain': 'Bold' })[type] ?? ''
				} as unknown as DataTransfer,
				cancelable: true
			})
		);
		await flushDomUpdates();
		expect(canonicalTree(edytor)[1]?.content).toEqual([
			{ text: 'no' },
			{ text: 'Bold', marks: { bold: true } },
			{ text: 'te' }
		]);
	});
});

describe('round trip: export then import reads one record', () => {
	row('the exported HTML flavour imports back to the same blocks and marks', async () => {
		const doc = {
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
						{ text: 'l', marks: { link: { href: 'https://example.com/' } } },
						{ text: '2', marks: { superscript: true } },
						{ text: '0', marks: { subscript: true } },
						{ text: 'c', marks: { color: 'red' } },
						{ text: 'h', marks: { highlight: 'yellow' } }
					]
				},
				{ type: 'quote', content: [{ text: 'q' }] },
				{ type: 'bulleted-list-item', content: [{ text: 'one' }] },
				{ type: 'divider' },
				{ type: 'heading', data: { level: 'h3' }, content: [{ text: 'End' }] }
			]
		};
		const source = await renderDomEdytor(
			<root>
				<paragraph />
			</root>,
			{ value: doc, autoSelectFixture: false }
		);
		source.edytor.selection.selectBlocks(...source.edytor.root!.children);
		await flushDomUpdates();
		const html = (await dispatchCopy(source.editor)).clipboardData['text/html']!;
		source.unmount();
		// External HTML only: the embedded fragment is stripped.
		const external = html.slice(html.indexOf('</span>') + '</span>'.length);
		expect(await imported(external)).toEqual(doc.children);
	});
});
