<script module lang="ts">
	import type { Plugin, BlockSnippetPayload, KindPreset, PlaceholderView } from '$lib/plugins.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { presetId } from '$lib/kinds.js';
	import type { Text } from '$lib/text/text.svelte.js';
	import type { SerializableContent } from '$lib/utils/json.js';
	import type { HotKey } from '$lib/session/keymap.js';
	import type { Snippet } from 'svelte';
	import {
		openLink,
		pastedLink,
		richTextOperations,
		sanitizeLinkHref,
		sanitizeCssColorValue,
		typedLink,
		type RichTextMark
	} from './richTextOperations.js';
	import { marksForInsertion } from '$lib/session/editing/text.js';
	import { firstUriListEntry } from '$lib/events/dataTransferPayload.js';
	import { flipToggles, shownSelectionBlocks } from '$lib/selection/replaceSelection.js';
	import { mediaKinds, richTextKinds, richTextMarks } from '$lib/crdt/semantics.js';
	import { keywordsOf, labelsWith, type PartialLabels, type RichTextLabels } from '$lib/labels.js';
	import { richTextLabels } from './labels.js';
	import { onPress } from '$lib/events/onFocus.js';
	import TodoCheckbox from './TodoCheckbox.svelte';
	import EmptyBody from './EmptyBody.svelte';
	import CalloutIcon from './CalloutIcon.svelte';
	import CalloutIconMenu from './CalloutIconMenu.svelte';
	import {
		CALLOUT_ICONS,
		CalloutIconPicker,
		DEFAULT_CALLOUT_ICON,
		calloutHtml,
		calloutIconViews,
		iconOf
	} from './calloutIcons.svelte.js';

	export { richTextOperations, CALLOUT_ICONS, CalloutIconPicker };
	export type { CalloutIconOption } from './calloutIcons.svelte.js';

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
	/** The kinds drawn as a disclosure: a toggle this view creates opens (`body.open`). */
	const DISCLOSURES = new Set(['toggle', 'toggle-heading', 'details']);
	/**
	 * A list's elements without list semantics (`role="none"`): a list's items
	 * are sibling blocks, never the only children of one `ul` or `ol`, so an
	 * `li` would be an orphan list item to assistive technology (WCAG 1.3.1);
	 * the tags stay for styles and the HTML export.
	 */
	const unlisted = (tag: 'li' | 'ul' | 'ol') => ({ tag, attributes: { role: 'none' } });
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
	 * HTML import: a pasted color, sanitized, unless it is the page's
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
	 * Notion's placeholders in `labels` (English by default): headings,
	 * lists, to-dos, toggles and quotes name their kind while empty; a
	 * paragraph invites a command only while focused.
	 */
	export const createRichTextPlaceholder = (labels?: PartialLabels<'richText'>) => {
		const { placeholders } = labelsWith('richText', labels);
		return ({ type, data, focused }: PlaceholderView): string | null => {
			if (type === 'heading')
				return placeholders.heading(Number(headingLevel(data.level).slice(1)) as 1 | 2 | 3);
			if (type === 'toggle-heading')
				return placeholders.toggleHeading(Number(headingLevel(data.level).slice(1)) as 1 | 2 | 3);
			if (type === 'bulleted-list-item' || type === 'numbered-list-item') return placeholders.list;
			if (type === 'todo-item') return placeholders.todo;
			if (type === 'toggle') return placeholders.toggle;
			if (type === 'quote') return placeholders.quote;
			// A callout's title, as a toggle's, names itself while empty.
			if (type === 'callout') return placeholders.callout;
			if (type === 'image' || Object.hasOwn(mediaKinds, type))
				return focused ? placeholders.caption : null;
			// Code shows nothing in an empty line (Notion).
			if (type === 'codeLine') return null;
			return focused ? placeholders.empty : null;
		};
	};

	/** Notion's placeholders, in English. */
	export const richTextPlaceholder = createRichTextPlaceholder();

	export type RichTextPluginOptions = {
		/** The kinds', marks' and checkbox's words (English by default). */
		labels?: PartialLabels<'richText'>;
		/**
		 * The slash menu's keywords of a kind, by command id (`block.heading1`):
		 * they replace that preset's own (list the English ones to keep them).
		 */
		keywords?: Partial<Record<string, string[]>>;
		/** Callouts' icons. */
		callout?: {
			/**
			 * A new callout's icon, and the one a callout whose `data.icon` is
			 * unset shows (`💡` by default).
			 */
			icon?: string;
			/** The icon picker's choices (`CALLOUT_ICONS` by default). */
			icons?: readonly string[];
			/**
			 * Replace the icon picker's markup: it renders while the picker is
			 * open, placed under the icon. Put `{@attach picker.keys}` and
			 * `{@attach picker.popup}` on its element and spread
			 * `picker.option(i)` on each row (`picker.icons.length`: Remove icon).
			 */
			picker?: Snippet<[CalloutIconPicker]>;
		};
	};

	const richTextPlugins = new WeakSet<Plugin>();

	/** Recognize any rich text plugin instance (the component's default yields to yours). */
	export const isRichTextPlugin = (plugin: Plugin) => richTextPlugins.has(plugin);

	// One key patched: a peer's concurrent edit of another key is kept.
	const toggleTodo = (block: Block) => (block.data.checked = !block.data.checked);

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

	/**
	 * The rich text kinds and marks, with their words in `labels` and their
	 * slash keywords in `keywords` (English by default).
	 */
	export const createRichTextPlugin = (options: RichTextPluginOptions = {}): Plugin => {
		const labels = labelsWith('richText', options.labels);
		const plugin: Plugin = (edytor) => {
			richTextLabels.claim(edytor, labels);
			// The view's callout icons: the first rich text plugin listed claims them.
			const picker = calloutIconViews.has(edytor)
				? undefined
				: new CalloutIconPicker(
						edytor,
						options.callout?.icon ?? DEFAULT_CALLOUT_ICON,
						options.callout?.icons ?? CALLOUT_ICONS,
						labels
					);
			if (picker) calloutIconViews.set(edytor, picker);
			return richText(edytor, labels, options, picker);
		};
		richTextPlugins.add(plugin);
		return plugin;
	};

	/** A preset whose slash keywords `keywords` may replace, by its command id. */
	const preset = (
		id: string,
		row: KindPreset,
		keywords: RichTextPluginOptions['keywords']
	): KindPreset => {
		const own = keywordsOf(id, row.keywords, keywords);
		return own ? { ...row, keywords: own } : row;
	};

	/** The rich text records of `edytor`, in `labels`, its presets' keywords replaced by `keywords`. */
	const richText = (
		edytor: Edytor,
		labels: RichTextLabels,
		{ keywords, callout: calloutOptions }: RichTextPluginOptions,
		/** The view's callout icon picker, when this plugin claimed it (the first listed). */
		picker: CalloutIconPicker | undefined
	): ReturnType<Plugin> => {
		const { kinds, marks: words } = labels;
		/** A new callout's icon. */
		const icon = calloutOptions?.icon ?? DEFAULT_CALLOUT_ICON;
		/** The block this view is retyping into a disclosure (`body.open`), until it applied. */
		let retyping: string | null = null;
		/** The disclosures this view created, opened once drawn (`onBlockAttached`). */
		const opening = new Set<string>();
		const presets = (type: string, rows: KindPreset[]) =>
			rows.map((row, index) => preset(presetId(type, index, rows.length), row, keywords));
		const operations = richTextOperations(edytor);
		/** The space an autolink types itself: its own insertion is not looked at again. */
		let autolinking = false;
		/**
		 * Where a link may be written at the caret: a text selection outside code
		 * blocks and voids (where the toolbar offers one), with the `link` mark
		 * defined. A caret whose next character would carry a link or inline code
		 * (typing inside either) links nothing new.
		 */
		const linkable = () => {
			const { value, projection } = edytor.selection;
			return (
				value.kind === 'text' &&
				projection.islandRoot === null &&
				projection.voidRoot === null &&
				edytor.marks.has('link')
			);
		};
		const plainAt = (text: Text, offset: number) => {
			const marks = marksForInsertion(text, offset, { pending: edytor.selection.pending });
			return !marks.link && !marks.code;
		};
		const setMarkAndSelect =
			(mark: RichTextMark, value?: SerializableContent): HotKey =>
			({ prevent }) =>
				prevent(() => operations.setMarkAtRange(mark, value));
		return {
			hotkeys: {
				'mod+b': setMarkAndSelect('bold'),
				'mod+i': setMarkAndSelect('italic'),
				'mod+u': setMarkAndSelect('underline'),
				'mod+e': setMarkAndSelect('code'),
				'mod+shift+s': setMarkAndSelect('strike'),
				'mod+shift+x': setMarkAndSelect('strike'),
				'mod+shift+h': setMarkAndSelect('color', 'red'),
				// Mod+Enter checks or unchecks each shown to-do it is in (Notion): the
				// selected blocks', else the caret's; the toggles among them open or
				// close as with the built-in binding, in the same key.
				'mod+enter': ({ prevent }) => {
					const blocks = shownSelectionBlocks(edytor);
					const todos = blocks.filter((b) => b.type === 'todo-item');
					if (!todos.length) return;
					prevent(() => {
						edytor.dispatcher.each('setBlock', todos, toggleTodo);
						flipToggles(blocks);
					});
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
			// Pasting a link (Notion), where the toolbar offers one: a text range
			// outside code blocks and voids. Over selected text it links the text;
			// at a caret it inserts the URL, then links it as a step of its own, so
			// undo gives the plain URL back (`link.autolink.pasted`).
			onPaste: ({ e, prevent }) => {
				if (!linkable()) return;
				const href = pastedLink(e.clipboardData?.getData('text/plain'));
				if (!href) return;
				const { isCollapsed, startText: text, yStart } = edytor.selection.state;
				if (!isCollapsed)
					return prevent(() =>
						edytor.dispatcher.run('insertFromPaste', () => operations.setLinkAtRange({ href }))
					);
				if (!text || !plainAt(text, yStart)) return;
				prevent(() => {
					const end = yStart + href.length;
					edytor.dispatcher.run('insertFromPaste', () => {
						text.insertText({ value: href, start: yStart, end: yStart });
						edytor.dispatcher.caret(text, end);
					});
					if (text.stringContent.slice(yStart, end) === href)
						operations.linkText(text, yStart, end, href);
				});
			},
			// A URL typed before a space becomes a link when the space is typed, as
			// a step of its own after the typing: undo gives the plain text back
			// (`link.autolink.typed`, Notion).
			onBeforeOperation: (change) => {
				// A block without children retyped into a disclosure from another kind (the
				// slash menu, a markdown shortcut, Turn into): the toggle it becomes opens on
				// its empty body (`body.open`). One with children keeps them out of sight.
				if (change.operation === 'setBlock') {
					const type = change.payload.value.type ?? change.block.type;
					const opens =
						DISCLOSURES.has(type) &&
						!DISCLOSURES.has(change.block.type) &&
						!change.block.hasChildren;
					retyping = opens ? change.block.id : null;
				}
				if (autolinking || change.operation !== 'insertText') return;
				const { payload, text, prevent } = change;
				if (payload.value !== ' ' || !linkable()) return;
				const { startText, yStart, isCollapsed } = edytor.selection.state;
				if (!isCollapsed || text !== startText || (payload.start ?? yStart) !== yStart) return;
				const found = typedLink(text.stringContent.slice(0, yStart));
				const end = found && found.start + found.href.length;
				if (!found || !end) return;
				const marked = text
					.getMarksAtRange(found.start, end)
					.some(({ marks }) => marks && ('link' in marks || 'code' in marks));
				if (marked) return;
				prevent(() => {
					autolinking = true;
					try {
						text.insertText(payload);
					} finally {
						autolinking = false;
					}
					edytor.dispatcher.caret(text, yStart + 1);
					operations.linkText(text, found.start, end, found.href);
				});
			},
			onAfterOperation: (change) => {
				if (change.operation !== 'setBlock' || retyping !== change.block.id) return;
				retyping = null;
				if (DISCLOSURES.has(change.block.type)) opening.add(change.block.id);
			},
			// A disclosure this view created opens as it is drawn (the browser owns `open`
			// from then on: the user's to close).
			onBlockAttached: ({ node, block }) => {
				if (!opening.delete(block.id)) return;
				if (node instanceof HTMLDetailsElement) node.open = true;
			},
			// Mod+click on a link opens it in a new tab (`link.mod-click`): a plain
			// click places the caret, as in Notion. Mod is read as the keymap reads
			// it: Meta, or Ctrl off a Mac. The callout icon picker is in the overlay.
			onEdytorAttached: ({ node }) => {
				const click = (event: MouseEvent) => {
					if (!event.metaKey && !(event.ctrlKey && !edytor.keymap.isMac)) return;
					const target = event.target instanceof Element ? event.target : null;
					const anchor = target?.closest('a[href][data-edytor-mark]');
					const href = anchor && node.contains(anchor) && anchor.getAttribute('href');
					if (!href) return;
					event.preventDefault();
					openLink(href, node.ownerDocument.defaultView);
				};
				node.addEventListener('click', click);
				// A press outside the picker closes it (WebKit's lone `mousedown` too).
				const offPress = picker && onPress(edytor, node.ownerDocument, picker.pressed, true);
				const unmount =
					picker &&
					edytor.overlay.mount(
						CalloutIconMenu,
						{ picker, menu: calloutOptions?.picker },
						'edytor-callout-icons-host',
						// With the menus: above the handles and the image chrome.
						70,
						picker.measure
					);
				return () => {
					node.removeEventListener('click', click);
					offPress?.();
					unmount?.();
					picker?.close(false);
				};
			},
			onBeforeInput: ({ e, prevent }) => {
				const { inputType, data } = e;
				if (isNativeFormatInputType(inputType)) {
					const mark = nativeFormatMarks[inputType];
					prevent(() => operations.setMarkAtRange(mark));
				} else if (inputType === 'formatRemove') {
					prevent(() => operations.removeAllMarksAtRange());
				} else if (inputType === 'formatFontColor' || inputType === 'formatBackColor') {
					// Native color commands carry the CSS color in `data` and are
					// set-semantics: the color/highlight marks' non-toggle op.
					const mark = inputType === 'formatFontColor' ? 'color' : 'highlight';
					if (data) prevent(() => operations.setMarkValueAtRange(mark, data));
				} else if (inputType === 'insertLink') {
					const href =
						data ??
						firstUriListEntry(e.dataTransfer?.getData('text/uri-list')) ??
						e.dataTransfer?.getData('text/plain');
					if (href) prevent(() => operations.setLinkAtRange({ href }));
				} else if (inputType === 'insertOrderedList' || inputType === 'insertUnorderedList') {
					const type =
						inputType === 'insertOrderedList' ? 'numbered-list-item' : 'bulleted-list-item';
					prevent(() => void edytor.runCommand(`block.${type}`));
				} else if (inputType === 'insertHorizontalRule') {
					prevent(() => void operations.insertDividerAtSelection());
				}
			},
			// Toolbar buttons and export wrapping follow this order (first innermost).
			marks: {
				bold: {
					tag: 'strong',
					toolbar: { label: words.bold, icon: 'B' },
					parse: alias(/^b$/, 'fontWeight', /^(bold|[6-9]00)$/)
				},
				italic: {
					tag: 'em',
					toolbar: { label: words.italic, icon: 'I' },
					parse: alias(/^i$/, 'fontStyle', /italic/)
				},
				underline: {
					tag: 'u',
					toolbar: { label: words.underline, icon: 'U' },
					parse: alias(/^u$/, 'textDecoration', /underline/)
				},
				strike: {
					tag: 's',
					toolbar: { label: words.strike, icon: 'S' },
					parse: alias(/^(strike|del)$/, 'textDecoration', /line-through/)
				},
				code: { tag: 'code', toolbar: { label: words.code, icon: '</>' } },
				// Typing at a link's trailing edge extends it only from inside the anchor.
				link: {
					tag: 'a',
					attributes: linkAttributes,
					...richTextMarks.link,
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
					presets: presets('paragraph', [
						{ label: kinds.paragraph, icon: 'T', keywords: ['paragraph', 'plain'] }
					])
				},
				heading: {
					snippet: textThenChildren,
					contentElement: (data) => headingLevel(data.level),
					presets: presets('heading', [
						{
							label: kinds.heading1,
							icon: 'H₁',
							keywords: ['h1', 'title'],
							data: { level: 'h1' },
							markdown: ['# ']
						},
						{
							label: kinds.heading2,
							icon: 'H₂',
							keywords: ['h2', 'subtitle'],
							data: { level: 'h2' },
							markdown: ['## ']
						},
						{
							label: kinds.heading3,
							icon: 'H₃',
							keywords: ['h3'],
							data: { level: 'h3' },
							markdown: ['### ']
						}
					]),
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
					element: unlisted('li'),
					presets: presets('bulleted-list-item', [
						{
							label: kinds.bulletedList,
							icon: '•',
							keywords: ['bullet', 'ul'],
							markdown: ['- ', '* ', '+ ']
						}
					]),
					html: 'li'
				},
				'numbered-list-item': {
					continues: true,
					snippet: listItem,
					element: unlisted('li'),
					presets: presets('numbered-list-item', [
						{
							label: kinds.numberedList,
							icon: '1.',
							keywords: ['number', 'ol'],
							markdown: ['1. ', 'a. ', 'i. ']
						}
					]),
					html: 'li',
					// HTML import: an `li` is a bulleted item (the first `li` kind) unless its list is ordered.
					parse: (el) =>
						el.localName === 'li' && el.parentElement?.localName === 'ol' ? {} : undefined
				},
				'todo-item': {
					continues: true,
					snippet: todoItem,
					presets: presets('todo-item', [
						{
							label: kinds.todoList,
							icon: '☐',
							keywords: ['task', 'check'],
							data: { checked: false },
							markdown: ['[ ] ', '[] ']
						}
					]),
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
					presets: presets('toggle', [
						{
							label: kinds.toggleList,
							icon: '▸',
							keywords: ['details', 'expand'],
							markdown: ['> ']
						}
					])
				},
				// Notion's toggle headings: a heading's text as a toggle's header over its
				// children. From a heading, `>` + space at its start makes it one (its level
				// kept); from a toggle, `#`, `##` or `###` + space; so `> # ` typed on a new
				// line is a toggle heading 1.
				'toggle-heading': {
					container: true,
					snippet: details,
					...disclosure,
					contentElement: (data) => headingLevel(data.level),
					presets: presets(
						'toggle-heading',
						(['h1', 'h2', 'h3'] as const).map((level, index) => {
							const hashes = '#'.repeat(index + 1);
							return {
								label: [kinds.toggleHeading1, kinds.toggleHeading2, kinds.toggleHeading3][index]!,
								icon: `▸H${['₁', '₂', '₃'][index]}`,
								keywords: ['toggle', 'heading', 'collapse'],
								data: { level },
								markdownFrom: {
									heading: ['> '],
									toggle: [`${hashes} `],
									'toggle-heading': [`${hashes} `]
								}
							};
						})
					),
					// HTML import: a `details` whose summary holds an h1–h3 (its own export).
					parse: (el) => {
						if (el.localName !== 'details') return;
						const tag = el.querySelector(':scope > summary > :is(h1, h2, h3, h4, h5, h6)');
						return tag ? { level: headingLevel(tag.localName) } : undefined;
					},
					html: (block, content, children) => {
						const tag = headingLevel(block.data?.level);
						return `<details><summary><${tag}>${content}</${tag}></summary>${children}</details>`;
					}
				},
				// Notion's callout: an icon (`data.icon`, the picker's), a title (its own
				// text) and a content (its children, any blocks), which shows even empty
				// (`body`): Enter at the end of the title goes into it.
				callout: {
					container: true,
					body: true,
					snippet: callout,
					presets: presets('callout', [
						{ label: kinds.callout, icon: '✦', keywords: ['note', 'tip'], data: { icon } }
					]),
					// The block menu's Change icon: the keyboard's way to the picker.
					menu: (block) =>
						picker
							? [
									{
										id: 'callout.icon',
										label: labels.calloutIcon.change,
										icon: 'block.callout',
										run: () => picker.open(block)
									}
								]
							: [],
					// HTML import: its own export, the icon in its attribute.
					parse: (el) => {
						const own = el.getAttribute('data-edytor-callout');
						return own === null ? undefined : { icon: own };
					},
					html: (block, content, children) =>
						calloutHtml(iconOf(block.data, icon), content, children)
				},
				quote: {
					container: true,
					snippet: textThenChildren,
					contentElement: 'blockquote',
					// Notion: `"` + space is a quote; `>` + space is a toggle.
					presets: presets('quote', [{ label: kinds.quote, icon: '❝', markdown: ['" '] }]),
					html: 'blockquote'
				},
				divider: {
					...richTextKinds.divider,
					element: 'hr',
					presets: presets('divider', [
						{ label: kinds.divider, icon: '—', keywords: ['hr', 'separator'], markdown: ['---'] }
					]),
					empty: { content: [], children: [] },
					...rule
				},
				details: { snippet: details, ...disclosure },
				'ordered-list': {
					...richTextKinds['ordered-list'],
					itemKind: 'numbered-list-item',
					snippet: list,
					element: unlisted('ol'),
					html: 'ol'
				},
				'unordered-list': {
					...richTextKinds['unordered-list'],
					itemKind: 'bulleted-list-item',
					snippet: list,
					element: unlisted('ul'),
					html: 'ul'
				},
				'list-item': { snippet: listItem, element: unlisted('li'), html: 'li' },
				horizontalRule: {
					...richTextKinds.horizontalRule,
					element: 'hr',
					...rule
				}
			}
		};
	};

	/** The rich text kinds and marks, in English. */
	export const richTextPlugin: Plugin = createRichTextPlugin();
</script>

<!--
	Every kind that has children renders them in one container marked
	`data-edytor-children`: the core indents it by one nesting step
	(`--edytor-nest-indent`), so nesting looks the same under any kind.
-->
{#snippet nested(children: BlockSnippetPayload['children'])}
	{#if children}
		<div data-edytor-children>
			{@render children()}
		</div>
	{/if}
{/snippet}

{#snippet paragraph({ content, children }: BlockSnippetPayload)}
	<p>
		{@render content()}
	</p>
	{@render nested(children)}
{/snippet}

<!--
	A toggle: its text the `summary`, its children the body; an empty body
	shows its hint, which the browser hides with the body while closed.
-->
{#snippet details({ block, content, children }: BlockSnippetPayload)}
	<summary>
		{@render content()}
	</summary>
	{#if children}
		{@render nested(children)}
	{:else}
		<EmptyBody {block} kind="toggle" />
	{/if}
{/snippet}

<!--
	A heading's or quote's text (the core wraps it in the kind's `contentElement`,
	its `h1`–`h3` or `blockquote`); its children below, outside that tag, so
	heading styles and the heading's accessible name stop at its own text.
-->
{#snippet textThenChildren({ content, children }: BlockSnippetPayload)}
	{@render content()}
	{@render nested(children)}
{/snippet}

<!--
	A callout: its icon, its title (its own text), then its content (its
	children), or the hint of an empty one.
-->
{#snippet callout({ block, content, children }: BlockSnippetPayload<{ icon?: string }>)}
	<CalloutIcon {block} />
	<div data-edytor-callout-title>
		{@render content()}
	</div>
	{#if children}
		{@render nested(children)}
	{:else}
		<EmptyBody {block} kind="callout" />
	{/if}
{/snippet}

{#snippet todoItem({ block, content, children }: BlockSnippetPayload<{ checked?: boolean }>)}
	<TodoCheckbox {block} toggle={toggleTodo} />
	<div>
		{@render content()}
	</div>
	{@render nested(children)}
{/snippet}

{#snippet listItem({ content, children }: BlockSnippetPayload)}
	<div>{@render content()}</div>
	{@render nested(children)}
{/snippet}

<!--
	A list container (HTML import's `ol`/`ul`) groups its items: they are its
	rows, not blocks nested under its text, so its wrapper is not indented.
-->
{#snippet list({ children }: BlockSnippetPayload)}
	{#if children}
		<div>
			{@render children()}
		</div>
	{/if}
{/snippet}

<style>
	/* A callout's title reads as its heading (Notion); its content below it. */
	:global([data-edytor-callout-title]) {
		font-weight: 600;
	}
	/* An empty body's hint: chrome, not text (`body.hint`). */
	:global([data-edytor-empty-body]) {
		padding: 3px 2px;
		color: #73726e;
		cursor: pointer;
		user-select: none;
	}
	/* The icon button reads as the icon. */
	:global(button[data-edytor-callout-icon]) {
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
</style>
