<script module lang="ts">
	import type { Plugin, MarkSnippetPayload, BlockSnippetPayload } from '$lib/plugins.js';
	import type { SerializableContent } from '$lib/utils/json.js';
	import type { HotKey } from '$lib/session/keymap.js';
	import {
		richTextOperations,
		sanitizeLinkHref,
		sanitizeCssColorValue,
		type RichTextMark
	} from './richTextOperations.js';
	import { firstUriListEntry } from '$lib/events/dataTransferPayload.js';

	export { richTextOperations };

	const nativeFormatMarks = {
		formatBold: 'bold',
		formatItalic: 'italic',
		formatUnderline: 'underline',
		formatStrikeThrough: 'strike',
		formatSuperscript: 'superscript',
		formatSubscript: 'subscript'
	} as const;

	const isNativeFormatInputType = (
		inputType: string
	): inputType is keyof typeof nativeFormatMarks => inputType in nativeFormatMarks;

	/** A thematic break's clipboard forms. */
	const rule = { html: () => '<hr>', plain: () => '---' };
	/** A native disclosure: the browser owns `open` (declared view state). */
	const disclosure = { element: 'details', viewState: ['open'] };
	const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

	export const richTextPlugin: Plugin = (edytor) => {
		const setMarkAndSelect =
			(mark: RichTextMark, value?: SerializableContent): HotKey =>
			({ prevent }) => {
				prevent(() => {
					richTextOperations(edytor).setMarkAtRange(mark, value);
				});
			};
		return {
			hotkeys: {
				'mod+b': setMarkAndSelect('bold'),
				'mod+i': setMarkAndSelect('italic'),
				'mod+u': setMarkAndSelect('underline'),
				'mod+e': setMarkAndSelect('code'),
				'mod+shift+x': setMarkAndSelect('strike'),
				'mod+shift+h': setMarkAndSelect('color', 'red')
			},
			onBeforeInput: ({ e, prevent }) => {
				if (isNativeFormatInputType(e.inputType)) {
					const mark = nativeFormatMarks[e.inputType];
					prevent(() => {
						richTextOperations(edytor).setMarkAtRange(mark);
					});
					return;
				}

				if (e.inputType === 'formatRemove') {
					prevent(() => {
						richTextOperations(edytor).removeAllMarksAtRange();
					});
					return;
				}

				if (e.inputType === 'formatFontColor' || e.inputType === 'formatBackColor') {
					// Native color commands carry the CSS color in `data` and
					// are set-semantics — they map onto the color/highlight
					// marks through the non-toggle op.
					const mark = e.inputType === 'formatFontColor' ? 'color' : 'highlight';
					if (e.data) {
						prevent(() => {
							richTextOperations(edytor).setMarkValueAtRange(mark, e.data!);
						});
					}
					return;
				}

				if (e.inputType === 'insertLink') {
					const href =
						e.data ??
						firstUriListEntry(e.dataTransfer?.getData('text/uri-list')) ??
						e.dataTransfer?.getData('text/plain');
					if (href) {
						prevent(() => {
							richTextOperations(edytor).setLinkAtRange({ href });
						});
					}
					return;
				}

				if (e.inputType === 'insertOrderedList' || e.inputType === 'insertUnorderedList') {
					const type =
						e.inputType === 'insertOrderedList' ? 'numbered-list-item' : 'bulleted-list-item';
					prevent(() => void edytor.runCommand(`block.${type}`));
					return;
				}

				if (e.inputType === 'insertHorizontalRule') {
					prevent(() => {
						richTextOperations(edytor).insertDividerAtSelection();
					});
				}
			},
			// Toolbar buttons and export wrapping follow this order (first innermost).
			marks: {
				bold: { snippet: bold, html: 'strong', toolbar: { label: 'Bold', icon: 'B' } },
				italic: { snippet: italic, html: 'em', toolbar: { label: 'Italic', icon: 'I' } },
				underline: { snippet: underline, html: 'u', toolbar: { label: 'Underline', icon: 'U' } },
				strike: { snippet: strike, html: 's', toolbar: { label: 'Strike', icon: 'S' } },
				code: { snippet: code, html: 'code', toolbar: { label: 'Code', icon: '</>' } },
				// FP-8: typing at a link's trailing edge extends it only from inside the anchor.
				link: { snippet: link, edge: 'side-dependent' },
				superscript,
				subscript,
				color,
				highlight
			},
			blocks: {
				paragraph: {
					snippet: paragraph,
					element: { tag: 'div', attributes: { class: 'rounded bg-opacity-25 p-1 my-1' } },
					presets: [{ label: 'Text', icon: 'T' }]
				},
				heading: {
					snippet: heading,
					element: (data) => (HEADINGS.includes(data.level) ? data.level : 'h1'),
					presets: [
						{
							label: 'Heading 1',
							icon: 'H₁',
							keywords: ['h1', 'title'],
							data: { level: 'h1' },
							markdown: ['# ']
						},
						{
							label: 'Heading 2',
							icon: 'H₂',
							keywords: ['h2', 'subtitle'],
							data: { level: 'h2' },
							markdown: ['## ']
						},
						{
							label: 'Heading 3',
							icon: 'H₃',
							keywords: ['h3'],
							data: { level: 'h3' },
							markdown: ['### ']
						}
					],
					html: (block, content, children) => {
						const level = String(block.data?.level);
						const tag = ['h1', 'h2', 'h3'].includes(level) ? level : 'h1';
						return `<${tag}>${content}</${tag}>${children}`;
					}
				},
				quote: {
					snippet: quote,
					element: 'blockquote',
					presets: [{ label: 'Quote', icon: '❝', markdown: ['> '] }],
					html: 'blockquote'
				},
				'bulleted-list-item': {
					snippet: listItem,
					element: 'li',
					presets: [
						{
							label: 'Bulleted list',
							icon: '•',
							keywords: ['bullet', 'ul'],
							markdown: ['- ', '* ']
						}
					],
					html: 'li'
				},
				'numbered-list-item': {
					snippet: listItem,
					element: 'li',
					presets: [
						{ label: 'Numbered list', icon: '1.', keywords: ['number', 'ol'], markdown: ['1. '] }
					],
					html: 'li'
				},
				'todo-item': {
					snippet: todoItem,
					presets: [
						{
							label: 'To-do list',
							icon: '☐',
							keywords: ['task', 'check'],
							data: { checked: false },
							markdown: ['[ ] ', '[] ']
						}
					],
					html: (block, content, children) =>
						`<li data-edytor-todo-item="true"><input type="checkbox"${block.data?.checked === true ? ' checked' : ''}>${content}${children}</li>`,
					plain: (block, content, children) =>
						[`${block.data?.checked === true ? '[x]' : '[ ]'} ${content}`.trim(), children]
							.filter(Boolean)
							.join('\n')
				},
				toggle: {
					snippet: details,
					...disclosure,
					presets: [{ label: 'Toggle list', icon: '▸' }]
				},
				callout: {
					snippet: callout,
					presets: [{ label: 'Callout', icon: '✦', data: { icon: '!' } }]
				},
				divider: {
					element: 'hr',
					void: true,
					rendersContent: false,
					presets: [
						{ label: 'Divider', icon: '—', keywords: ['hr', 'separator'], markdown: ['---'] }
					],
					empty: { content: [], children: [] },
					...rule
				},
				details: { snippet: details, ...disclosure },
				'ordered-list': {
					snippet: list,
					element: 'ol',
					rendersContent: false,
					defaultChild: 'list-item',
					html: 'ol'
				},
				'unordered-list': {
					snippet: list,
					element: 'ul',
					rendersContent: false,
					defaultChild: 'list-item',
					html: 'ul'
				},
				'list-item': { snippet: listItem, element: 'li', html: 'li' },
				horizontalRule: {
					element: 'hr',
					void: true,
					rendersContent: false,
					...rule
				}
			}
		};
	};
</script>

{#snippet bold({ content }: MarkSnippetPayload)}
	<b>
		{@render content()}
	</b>
{/snippet}

{#snippet italic({ content }: MarkSnippetPayload)}
	<i>
		{@render content()}
	</i>
{/snippet}

{#snippet underline({ content }: MarkSnippetPayload)}
	<u>
		{@render content()}
	</u>
{/snippet}

{#snippet code({ content }: MarkSnippetPayload)}
	<code>
		{@render content()}
	</code>
{/snippet}

{#snippet link({ mark, content }: MarkSnippetPayload<{ href: string; target?: string }>)}
	{@const href = sanitizeLinkHref(mark.href)}
	<!-- href omitted when the scheme is unsafe — an inert anchor still
	     carries the text; a poisoned mark never reaches the DOM. -->
	<a href={href ?? undefined} target={href ? mark.target : undefined}>
		{@render content()}
	</a>
{/snippet}

{#snippet strike({ content }: MarkSnippetPayload)}
	<s>
		{@render content()}
	</s>
{/snippet}

{#snippet superscript({ content }: MarkSnippetPayload)}
	<sup>
		{@render content()}
	</sup>
{/snippet}

{#snippet subscript({ content }: MarkSnippetPayload)}
	<sub>
		{@render content()}
	</sub>
{/snippet}

{#snippet color({ mark, content }: MarkSnippetPayload<{ color: string }>)}
	{@const safe = sanitizeCssColorValue(mark)}
	<!-- style omitted on hostile values — a `;` payload would inject
	     arbitrary declarations. The mark still wraps content harmlessly. -->
	<span style={safe ? `color: ${safe}` : undefined}>
		{@render content()}
	</span>
{/snippet}

{#snippet highlight({ mark, content }: MarkSnippetPayload<string>)}
	{@const safe = sanitizeCssColorValue(mark)}
	<span style={safe ? `background-color: ${safe}` : undefined}>
		{@render content()}
	</span>
{/snippet}

{#snippet paragraph({ content, children }: BlockSnippetPayload)}
	<p>
		{@render content()}
	</p>
	{@render children?.()}
{/snippet}

{#snippet details({ content, children }: BlockSnippetPayload)}
	<summary>
		{@render content()}
	</summary>
	{#if children}
		<div>
			{@render children()}
		</div>
	{/if}
{/snippet}

{#snippet heading({ content, children }: BlockSnippetPayload)}
	{@render content()}
	{#if children}
		<div>
			{@render children()}
		</div>
	{/if}
{/snippet}

{#snippet quote({ content, children }: BlockSnippetPayload)}
	{@render content()}
	{#if children}
		<div>
			{@render children()}
		</div>
	{/if}
{/snippet}

{#snippet callout({ block, content, children }: BlockSnippetPayload<{ icon?: string }>)}
	<span contenteditable="false">{block.data.icon || '!'}</span>
	<div>
		{@render content()}
	</div>
	{#if children}
		<div>
			{@render children()}
		</div>
	{/if}
{/snippet}

{#snippet todoItem({ block, content, children }: BlockSnippetPayload<{ checked?: boolean }>)}
	<input type="checkbox" checked={Boolean(block.data.checked)} contenteditable="false" readonly />
	<div>
		{@render content()}
	</div>
	{#if children}
		<div>
			{@render children()}
		</div>
	{/if}
{/snippet}

{#snippet listItem({ content, children }: BlockSnippetPayload)}
	<div>{@render content()}</div>
	{#if children}
		<div>
			{@render children()}
		</div>
	{/if}
{/snippet}

{#snippet list({ children }: BlockSnippetPayload)}
	{#if children}
		<div>
			{@render children()}
		</div>
	{/if}
{/snippet}
