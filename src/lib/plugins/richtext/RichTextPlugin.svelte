<script module lang="ts">
	import type { Plugin, BlockSnippetPayload, PlaceholderView } from '$lib/plugins.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { SerializableContent } from '$lib/utils/json.js';
	import type { HotKey } from '$lib/session/keymap.js';
	import {
		richTextOperations,
		sanitizeLinkHref,
		sanitizeCssColorValue,
		type RichTextMark
	} from './richTextOperations.js';
	import { firstUriListEntry } from '$lib/events/dataTransferPayload.js';
	import { richTextKinds } from '$lib/crdt/semantics.js';

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
	/**
	 * Notion's three heading levels: a missing level is h1, any other (a
	 * stored `h4`–`h6`, as HTML import reads them) h3.
	 */
	const headingLevel = (level: unknown) =>
		level === 'h1' || level === 'h2' || level === 'h3' ? level : level === undefined ? 'h1' : 'h3';
	/** An unsafe scheme drops the href (and its target): an inert anchor still carries the text. */
	const linkAttributes = (mark: { href?: unknown; target?: string }) => {
		const href = sanitizeLinkHref(mark?.href) ?? undefined;
		return { href, target: href && mark.target };
	};
	/** A hostile color value (a `;` payload would inject declarations) drops the style. */
	const styled = (property: string) => (value: unknown) => {
		const safe = sanitizeCssColorValue(value);
		return { style: safe ? `${property}: ${safe};` : undefined };
	};
	/**
	 * HTML import (P4.1): a pasted color, sanitized, unless it is the page's
	 * default (Google Docs writes black text and transparent backgrounds on
	 * every span: they are no mark, and a black mark is unreadable in dark mode).
	 */
	const colorOf = (value: string, none: RegExp) =>
		none.test(value.replace(/\s+/g, '').toLowerCase())
			? undefined
			: (sanitizeCssColorValue(value) ?? undefined);
	const INHERITED = 'initial|inherit|unset|revert|currentcolor';
	const NO_COLOR = new RegExp(
		`^(${INHERITED}|black|windowtext|#000|#000000|rgba?\\(0,0,0(,1)?\\))$`
	);
	const NO_HIGHLIGHT = new RegExp(
		`^(${INHERITED}|transparent|rgba\\(\\d+,\\d+,\\d+,0\\)|white|#fff|#ffffff|rgba?\\(255,255,255(,1)?\\))$`
	);
	/** HTML import: a tag alias (unless its own style says otherwise) or a style (Google Docs). */
	const alias =
		(tags: RegExp, property: 'fontWeight' | 'fontStyle' | 'textDecoration', value: RegExp) =>
		(el: HTMLElement) =>
			(tags.test(el.localName) && !el.style[property]) ||
			value.test(el.style[property]) ||
			undefined;

	/**
	 * Notion's placeholders: headings, lists, to-dos, toggles and quotes name
	 * their kind while empty; a paragraph invites a command only while focused.
	 */
	export const richTextPlaceholder = ({ type, data, focused }: PlaceholderView): string | null => {
		if (type === 'heading') return `Heading ${headingLevel(data.level).slice(1)}`;
		if (type === 'bulleted-list-item' || type === 'numbered-list-item') return 'List';
		if (type === 'todo-item') return 'To-do';
		if (type === 'toggle') return 'Toggle';
		if (type === 'quote') return 'Empty quote';
		if (type === 'callout') return focused ? 'Type something…' : null;
		if (type === 'image') return focused ? 'Write a caption…' : null;
		return focused ? "Type '/' for commands" : null;
	};

	/** Notion's "turn into" chords: Mod+Alt+0 text … 8 code (`block.<type>` command ids). */
	const TURN_INTO: Record<string, string> = {
		'mod+alt+0': 'block.paragraph',
		'mod+alt+1': 'block.heading1',
		'mod+alt+2': 'block.heading2',
		'mod+alt+3': 'block.heading3',
		'mod+alt+4': 'block.todo-item',
		'mod+alt+5': 'block.bulleted-list-item',
		'mod+alt+6': 'block.numbered-list-item',
		'mod+alt+7': 'block.toggle',
		'mod+alt+8': 'block.code'
	};

	export const richTextPlugin: Plugin = (edytor) => {
		const toggleTodo = (block: Block) =>
			block.setData({ ...block.data, checked: !block.data.checked });
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
				'mod+shift+s': setMarkAndSelect('strike'),
				'mod+shift+x': setMarkAndSelect('strike'),
				'mod+shift+h': setMarkAndSelect('color', 'red'),
				// Mod+Enter checks a to-do (Notion); elsewhere the built-in split runs.
				'mod+enter': ({ prevent }) => {
					const block = edytor.selection.state.startBlock;
					if (block?.type === 'todo-item') prevent(() => toggleTodo(block));
				},
				...Object.fromEntries(
					Object.entries(TURN_INTO).map(([chord, id]): [string, HotKey] => [
						chord,
						({ prevent }) => {
							if (edytor.commands.has(id)) prevent(() => void edytor.runCommand(id));
						}
					])
				)
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
				bold: {
					tag: 'strong',
					toolbar: { label: 'Bold', icon: 'B' },
					parse: alias(/^b$/, 'fontWeight', /^(bold|[6-9]00)$/)
				},
				italic: {
					tag: 'em',
					toolbar: { label: 'Italic', icon: 'I' },
					parse: alias(/^i$/, 'fontStyle', /italic/)
				},
				underline: {
					tag: 'u',
					toolbar: { label: 'Underline', icon: 'U' },
					parse: alias(/^u$/, 'textDecoration', /underline/)
				},
				strike: {
					tag: 's',
					toolbar: { label: 'Strike', icon: 'S' },
					parse: alias(/^(strike|del)$/, 'textDecoration', /line-through/)
				},
				code: { tag: 'code', toolbar: { label: 'Code', icon: '</>' } },
				// FP-8: typing at a link's trailing edge extends it only from inside the anchor.
				link: {
					tag: 'a',
					attributes: linkAttributes,
					edge: 'side-dependent',
					parse: (el) => {
						const href = el.localName === 'a' && sanitizeLinkHref(el.getAttribute('href'));
						const target = el.getAttribute('target');
						return href ? { href, ...(target ? { target } : {}) } : undefined;
					}
				},
				superscript: { tag: 'sup' },
				subscript: { tag: 'sub' },
				color: {
					tag: 'span',
					attributes: styled('color'),
					parse: (el) => colorOf(el.style.color, NO_COLOR)
				},
				highlight: {
					tag: 'span',
					attributes: styled('background-color'),
					parse: (el) => {
						const background = el.style.backgroundColor;
						if (background) return colorOf(background, NO_HIGHLIGHT);
						return el.localName === 'mark' ? 'yellow' : undefined;
					}
				}
			},
			blocks: {
				paragraph: {
					snippet: paragraph,
					presets: [{ label: 'Text', icon: 'T', keywords: ['paragraph', 'plain'] }]
				},
				heading: {
					snippet: heading,
					element: (data) => headingLevel(data.level),
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
					// HTML import: h1–h3 come from the presets; h4–h6 read as h3.
					parse: (el) => (/^h[4-6]$/.test(el.localName) ? { level: 'h3' } : undefined),
					html: (block, content, children) => {
						const tag = headingLevel(block.data?.level);
						return `<${tag}>${content}</${tag}>${children}`;
					}
				},
				'bulleted-list-item': {
					continues: true,
					snippet: listItem,
					element: 'li',
					presets: [
						{
							label: 'Bulleted list',
							icon: '•',
							keywords: ['bullet', 'ul'],
							markdown: ['- ', '* ', '+ ']
						}
					],
					html: 'li'
				},
				'numbered-list-item': {
					continues: true,
					snippet: listItem,
					element: 'li',
					presets: [
						{
							label: 'Numbered list',
							icon: '1.',
							keywords: ['number', 'ol'],
							markdown: ['1. ', 'a. ', 'i. ']
						}
					],
					html: 'li',
					// HTML import: an `li` is a bulleted item (the first `li` kind) unless its list is ordered.
					parse: (el) =>
						el.localName === 'li' && el.parentElement?.localName === 'ol' ? {} : undefined
				},
				'todo-item': {
					continues: true,
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
					continues: true,
					container: true,
					snippet: details,
					...disclosure,
					presets: [
						{ label: 'Toggle list', icon: '▸', keywords: ['details', 'expand'], markdown: ['> '] }
					]
				},
				callout: {
					container: true,
					snippet: callout,
					presets: [
						{ label: 'Callout', icon: '✦', keywords: ['note', 'tip'], data: { icon: '💡' } }
					]
				},
				quote: {
					container: true,
					snippet: quote,
					element: 'blockquote',
					// Notion: `"` + space is a quote; `>` + space is a toggle.
					presets: [{ label: 'Quote', icon: '❝', markdown: ['" '] }],
					html: 'blockquote'
				},
				divider: {
					...richTextKinds.divider,
					element: 'hr',
					presets: [
						{ label: 'Divider', icon: '—', keywords: ['hr', 'separator'], markdown: ['---'] }
					],
					empty: { content: [], children: [] },
					...rule
				},
				details: { snippet: details, ...disclosure },
				'ordered-list': {
					...richTextKinds['ordered-list'],
					snippet: list,
					element: 'ol',
					html: 'ol'
				},
				'unordered-list': {
					...richTextKinds['unordered-list'],
					snippet: list,
					element: 'ul',
					html: 'ul'
				},
				'list-item': { snippet: listItem, element: 'li', html: 'li' },
				horizontalRule: {
					...richTextKinds.horizontalRule,
					element: 'hr',
					...rule
				}
			}
		};
	};
</script>

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
	<span contenteditable="false" data-edytor-callout-icon>{block.data.icon || '💡'}</span>
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
	<input
		type="checkbox"
		checked={Boolean(block.data.checked)}
		contenteditable="false"
		aria-label="Done"
		data-edytor-todo-checkbox
		onmousedown={(event) => event.preventDefault()}
		onclick={(event) => {
			event.preventDefault();
			const target = block.handle;
			target.setData({ ...target.data, checked: !target.data.checked });
		}}
	/>
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
