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
					presets: [{ label: 'Text', icon: 'T' }]
				},
				heading: {
					snippet: heading,
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
					presets: [{ label: 'Quote', icon: '❝', markdown: ['> '] }],
					html: 'blockquote'
				},
				'bulleted-list-item': {
					snippet: bulletedListItem,
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
					snippet: numberedListItem,
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
				toggle: { snippet: toggle, presets: [{ label: 'Toggle list', icon: '▸' }] },
				callout: {
					snippet: callout,
					presets: [{ label: 'Callout', icon: '✦', data: { icon: '!' } }]
				},
				divider: {
					snippet: divider,
					void: true,
					rendersContent: false,
					presets: [
						{ label: 'Divider', icon: '—', keywords: ['hr', 'separator'], markdown: ['---'] }
					],
					empty: { content: [], children: [] },
					...rule
				},
				details,
				'ordered-list': {
					snippet: orderedList,
					rendersContent: false,
					defaultChild: 'list-item',
					html: 'ol'
				},
				'unordered-list': {
					snippet: unorderedList,
					rendersContent: false,
					defaultChild: 'list-item',
					html: 'ul'
				},
				'list-item': { snippet: listItem, html: 'li' },
				horizontalRule: {
					snippet: horizontalRule,
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

{#snippet paragraph({ block, content, children }: BlockSnippetPayload)}
	<div class="rounded bg-opacity-25 p-1 my-1" use:block.attach>
		<p>
			{@render content()}
		</p>
		{@render children?.()}
	</div>
{/snippet}
{#snippet details({ block, content, children }: BlockSnippetPayload)}
	<details use:block.attach>
		<summary>
			{@render content()}
		</summary>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</details>
{/snippet}
{#snippet toggle({ block, content, children }: BlockSnippetPayload)}
	<details use:block.attach data-edytor-type="toggle">
		<summary>
			{@render content()}
		</summary>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</details>
{/snippet}
{#snippet heading({ block, content, children }: BlockSnippetPayload<{ level: number }>)}
	<svelte:element this={block.data.level || 'h1'} use:block.attach>
		{@render content()}
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</svelte:element>
{/snippet}

{#snippet quote({ block, content, children }: BlockSnippetPayload)}
	<blockquote use:block.attach data-edytor-type="quote">
		{@render content()}
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</blockquote>
{/snippet}

{#snippet callout({ block, content, children }: BlockSnippetPayload<{ icon?: string }>)}
	<div use:block.attach data-edytor-type="callout">
		<span contenteditable="false">{block.data.icon || '!'}</span>
		<div>
			{@render content()}
		</div>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet todoItem({ block, content, children }: BlockSnippetPayload<{ checked?: boolean }>)}
	<div use:block.attach data-edytor-type="todo-item">
		<input type="checkbox" checked={Boolean(block.data.checked)} contenteditable="false" readonly />
		<div>
			{@render content()}
		</div>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet bulletedListItem({ block, content, children }: BlockSnippetPayload)}
	<li use:block.attach data-edytor-type="bulleted-list-item">
		<div>{@render content()}</div>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</li>
{/snippet}

{#snippet numberedListItem({ block, content, children }: BlockSnippetPayload)}
	<li use:block.attach data-edytor-type="numbered-list-item">
		<div>{@render content()}</div>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</li>
{/snippet}

{#snippet orderedList({ block, content, children }: BlockSnippetPayload)}
	<ol use:block.attach>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</ol>
{/snippet}

{#snippet unorderedList({ block, content, children }: BlockSnippetPayload)}
	<ul use:block.attach>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</ul>
{/snippet}

{#snippet listItem({ block, content, children }: BlockSnippetPayload)}
	<li use:block.attach>
		<div>{@render content()}</div>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</li>
{/snippet}

{#snippet horizontalRule({ block }: BlockSnippetPayload)}
	<hr use:block.attach use:block.void />
{/snippet}

{#snippet divider({ block }: BlockSnippetPayload)}
	<hr use:block.attach use:block.void data-edytor-type="divider" />
{/snippet}
