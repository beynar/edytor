<script module lang="ts">
	import './richtext.css';
	import type { Plugin, BlockSnippetPayload, KindPreset, PlaceholderView } from '$lib/plugins.js';
	import { branded } from '../brand.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { presetId } from '$lib/kinds.js';
	import type { Text } from '$lib/text/text.svelte.js';
	import type { SerializableContent } from '$lib/utils/json.js';
	import type { HotKey } from '$lib/session/keymap.js';
	import {
		openLink,
		pastedLink,
		richTextOperations,
		typedLink,
		type RichTextMark
	} from './richTextOperations.js';
	import { marksForInsertion } from '$lib/session/editing/text.js';
	import { firstUriListEntry } from '$lib/events/dataTransferPayload.js';
	import { flipToggles, shownSelectionBlocks } from '$lib/selection/replaceSelection.js';
	import { mediaKinds, richTextKinds } from '$lib/crdt/semantics.js';
	import { richTextEnglish, keywordsOf, labelsOf, type RichTextLabels } from '$lib/labels.js';
	import TodoCheckbox from './TodoCheckbox.svelte';
	import EmptyBody from './EmptyBody.svelte';
	import CalloutIcon from './CalloutIcon.svelte';
	import RichTextControl from './RichTextControl.svelte';
	import { DEFAULT_CALLOUT_ICON, calloutIcons, calloutPickers, iconOf } from './callouts.js';
	import { listen } from '$lib/utils/listen.js';
	import {
		HEADING_LEVELS,
		calloutRead,
		calloutWrite,
		dividerRead,
		dividerWrite,
		headingLevel,
		headingRead,
		headingWrite,
		itemRead,
		itemWrite,
		numberedRead,
		orderedRead,
		orderedWrite,
		quoteRead,
		quoteWrite,
		richTextMarkForms,
		todoWrite,
		toggleHeadingRead,
		toggleHeadingWrite,
		toggleRead,
		unorderedRead,
		unorderedWrite
	} from '$lib/export/forms.js';
	import { onLastLine } from '$lib/session/navigation.js';
	import { bodyShows } from '$lib/selection/visibility.js';
	import { openBody } from './body.js';
	import type { Snippet } from 'svelte';
	import {
		richTextControls,
		toggleTodo,
		type CalloutIconPayload,
		type EmptyBodyPayload,
		type TodoCheckboxPayload
	} from './controls.svelte.js';

	export type { CalloutIconPayload, EmptyBodyPayload, TodoCheckboxPayload };

	export { richTextOperations };

	const nativeFormatMarks = {
		formatBold: 'bold',
		formatItalic: 'italic',
		formatUnderline: 'underline',
		formatStrikeThrough: 'strike',
		formatSuperscript: 'superscript',
		formatSubscript: 'subscript'
	} as const;

	/** A native disclosure: the browser owns `open` (declared view state). */
	const disclosure = { viewState: ['open'] };
	/** The kinds drawn as a disclosure: a toggle this view creates opens (`body.open`). */
	const DISCLOSURES = new Set(['toggle', 'toggle-heading']);

	/**
	 * The kinds whose empty text names them, by placeholder (a callout's
	 * title, as a toggle's, names itself).
	 */
	const NAMED: Record<string, 'list' | 'todo' | 'toggle' | 'quote' | 'callout'> = {
		'bulleted-list-item': 'list',
		'numbered-list-item': 'list',
		'todo-item': 'todo',
		toggle: 'toggle',
		quote: 'quote',
		callout: 'callout'
	};

	/**
	 * Notion's placeholders, in the view's `richText` labels (English by
	 * default): headings, lists, to-dos, toggles and quotes name their kind
	 * while empty; a paragraph invites a command only while focused.
	 */
	export const richTextPlaceholder = (
		{ type, data, focused }: PlaceholderView,
		edytor?: Edytor
	): string | null => {
		const { placeholders } = labelsOf(edytor, 'richText', richTextEnglish);
		if (type === 'heading' || type === 'toggle-heading')
			return placeholders[type === 'heading' ? 'heading' : 'toggleHeading'](
				Number(headingLevel(data.level).slice(1)) as 1 | 2 | 3
			);
		if (Object.hasOwn(NAMED, type)) return placeholders[NAMED[type]!];
		// Code shows nothing in an empty line (Notion).
		if (type === 'codeLine' || !focused) return null;
		return type === 'image' || Object.hasOwn(mediaKinds, type)
			? placeholders.caption
			: placeholders.empty;
	};

	export type RichTextPluginOptions = {
		/** Callouts' icons (their picker is `createCalloutIconsPlugin`'s). */
		callout?: {
			/**
			 * A new callout's icon, and the one a callout whose `data.icon` is
			 * unset shows (`💡` by default).
			 */
			icon?: string;
		};
		/**
		 * A to-do's checkbox (default: a native `input type="checkbox"`). Spread
		 * `checkbox.attributes` on the control, an `input` (with
		 * `checked={checkbox.checked}`) or a `button`: its click checks the to-do
		 * through the document.
		 */
		checkbox?: Snippet<[TodoCheckboxPayload]>;
		/**
		 * A callout's icon (default: a `button` showing it, or the icon alone
		 * where it cannot be picked). Spread `icon.attributes` on its element:
		 * a click opens the view's picker (`createCalloutIconsPlugin`), which
		 * opens under it.
		 */
		calloutIcon?: Snippet<[CalloutIconPayload]>;
		/**
		 * The hint an open toggle's or a callout's empty body shows (default: a
		 * `div` with the view's `richText.emptyBody` words). Spread
		 * `hint.attributes` on it: a click starts the body, a dragged block
		 * drops inside.
		 */
		emptyBody?: Snippet<[EmptyBodyPayload]>;
	};

	/** Notion's "turn into" chords: Mod+Alt+0 text … 8 code (`block.<type>` command ids, by digit). */
	const TURN_INTO = [
		'paragraph',
		'heading1',
		'heading2',
		'heading3',
		'todo-item',
		'bulleted-list-item',
		'numbered-list-item',
		'toggle',
		'code'
	];

	/**
	 * The rich text kinds and marks, their words and slash keywords the
	 * view's (`labels`, English by default).
	 */
	export const createRichTextPlugin = (options: RichTextPluginOptions = {}): Plugin => {
		const plugin: Plugin = (edytor) => {
			const labels = labelsOf(edytor, 'richText', richTextEnglish);
			// The view's default callout icon and its controls' markup: the first rich text plugin listed sets them.
			if (edytor && !calloutIcons.has(edytor)) {
				calloutIcons.set(edytor, options.callout?.icon ?? DEFAULT_CALLOUT_ICON);
				const { checkbox, calloutIcon, emptyBody } = options;
				richTextControls.set(edytor, { checkbox, calloutIcon, emptyBody });
			}
			return richText(edytor, labels, options);
		};
		return branded('richText', plugin);
	};

	/** The rich text records of `edytor`, in `labels`, its presets' keywords the view's. */
	const richText = (
		edytor: Edytor,
		labels: RichTextLabels,
		{ callout: calloutOptions, checkbox, calloutIcon, emptyBody }: RichTextPluginOptions
	): ReturnType<Plugin> => {
		const { kinds, marks: words } = labels;
		const marks = richTextMarkForms;
		/** A new callout's icon. */
		const icon = calloutOptions?.icon ?? DEFAULT_CALLOUT_ICON;
		/** The block this view is retyping into a disclosure (`body.open`), until it applied. */
		let retyping: string | null = null;
		/** The disclosures this view created, opened once drawn (`onBlockAttached`). */
		const opening = new Set<string>();
		const presets = (type: string, rows: KindPreset[]) =>
			rows.map((row, index) => {
				const own = keywordsOf(edytor, presetId(type, index, rows.length), row.keywords);
				return own ? { ...row, keywords: own } : row;
			});
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
				// ArrowDown on the last line of a header whose body shows and is empty
				// (an open toggle, a callout) goes into that body, as its hint's click
				// does (`body.down`): one command, one undo step. Elsewhere the key
				// moves as usual.
				arrowdown: ({ prevent }) => {
					const header = onLastLine(edytor);
					if (!header || header.hasChildren || !bodyShows(header)) return;
					if (!edytor.dispatcher.permits()) return;
					prevent(() => void openBody(header));
				},
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
					TURN_INTO.map((type, digit): [string, HotKey] => [
						`mod+alt+${digit}`,
						({ prevent }) => {
							const id = `block.${type}`;
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
				const { startText: text, yStart } = edytor.selection.textRange();
				const { isCollapsed } = edytor.selection.projection;
				if (!isCollapsed)
					return prevent(() =>
						edytor.dispatcher.run('insertFromPaste', () => operations.setLinkAtRange({ href }))
					);
				if (!text || !plainAt(text, yStart)) return;
				prevent(() => {
					const end = yStart + href.length;
					edytor.dispatcher.run('insertFromPaste', () => {
						edytor.insertText(text.parent.id, text.segStart + yStart, href);
						edytor.dispatcher.caretIn(text, end);
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
				// slash menu, a markdown shortcut, Turn into: their planned `setBlockType`):
				// the toggle it becomes opens on its empty body (`body.open`). One with
				// children keeps them out of sight.
				if (change.operation === 'setBlockType') {
					const [, type] = change.payload;
					const opens =
						DISCLOSURES.has(type) &&
						!DISCLOSURES.has(change.block.type) &&
						!change.block.hasChildren;
					retyping = opens ? change.block.id : null;
				}
				if (autolinking || change.operation !== 'insertText') return;
				const { payload, text, prevent } = change;
				if (payload[2] !== ' ' || !linkable()) return;
				const { startText, yStart } = edytor.selection.textRange();
				const { isCollapsed } = edytor.selection.projection;
				if (!isCollapsed || !text || text !== startText) return;
				if (payload[1] !== text.segStart + yStart) return;
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
						edytor.insertText(...payload);
					} finally {
						autolinking = false;
					}
					edytor.dispatcher.caretIn(text, yStart + 1);
					operations.linkText(text, found.start, end, found.href);
				});
			},
			onAfterOperation: (change) => {
				if (retyping !== change.block.id) return;
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
			// it: Meta, or Ctrl off a Mac.
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
				return listen(node, 'click', click);
			},
			onBeforeInput: ({ e, prevent }) => {
				const { inputType, data } = e;
				if (inputType in nativeFormatMarks) {
					const mark = nativeFormatMarks[inputType as keyof typeof nativeFormatMarks];
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
				...marks,
				// The toolbar's marks, by their icons.
				...Object.fromEntries(
					(['bold', 'italic', 'underline', 'strike', 'code'] as const).map((name, i) => [
						name,
						{
							...marks[name],
							toolbar: { label: words[name], icon: ['B', 'I', 'U', 'S', '</>'][i]! }
						}
					])
				)
			},
			blocks: {
				paragraph: {
					snippet: paragraph,
					presets: presets('paragraph', [
						{ label: kinds.paragraph, icon: 'T', keywords: ['paragraph', 'plain'] }
					])
				},
				heading: {
					...headingRead,
					...headingWrite,
					snippet: textThenChildren,
					presets: presets(
						'heading',
						HEADING_LEVELS.map((level, index) => ({
							label: [kinds.heading1, kinds.heading2, kinds.heading3][index]!,
							icon: `H${['₁', '₂', '₃'][index]}`,
							keywords: [level, ...[['title'], ['subtitle'], []][index]!],
							data: { level },
							markdown: [`${'#'.repeat(index + 1)} `]
						}))
					)
				},
				'bulleted-list-item': {
					...itemRead,
					...itemWrite,
					continues: true,
					snippet: listItem,
					presets: presets('bulleted-list-item', [
						{
							label: kinds.bulletedList,
							icon: '•',
							keywords: ['bullet', 'ul'],
							markdown: ['- ', '* ', '+ ']
						}
					])
				},
				'numbered-list-item': {
					...numberedRead,
					...itemWrite,
					continues: true,
					snippet: listItem,
					presets: presets('numbered-list-item', [
						{
							label: kinds.numberedList,
							icon: '1.',
							keywords: ['number', 'ol'],
							markdown: ['1. ', 'a. ', 'i. ']
						}
					])
				},
				'todo-item': {
					...todoWrite,
					continues: true,
					// The app's control markup, if any, through its own snippet: the default costs no branch.
					snippet: checkbox ? todoItemOwn : todoItem,
					presets: presets('todo-item', [
						{
							label: kinds.todoList,
							icon: '☐',
							keywords: ['task', 'check'],
							data: { checked: false },
							markdown: ['[ ] ', '[] ']
						}
					])
				},
				toggle: {
					...toggleRead,
					continues: true,
					container: true,
					snippet: emptyBody ? detailsOwn : details,
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
					...toggleHeadingRead,
					...toggleHeadingWrite,
					container: true,
					snippet: emptyBody ? detailsOwn : details,
					...disclosure,
					presets: presets(
						'toggle-heading',
						HEADING_LEVELS.map((level, index) => {
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
					)
				},
				// Notion's callout: an icon (`data.icon`, the picker's), a title (its own
				// text) and a content (its children, any blocks), which shows even empty
				// (`body`): Enter at the end of the title goes into it.
				callout: {
					...calloutRead,
					container: true,
					body: true,
					snippet: calloutIcon || emptyBody ? calloutOwn : callout,
					presets: presets('callout', [
						{ label: kinds.callout, icon: '✦', keywords: ['note', 'tip'], data: { icon } }
					]),
					// A callout without its own icon exports the view's.
					...calloutWrite((data) => iconOf(data, edytor)),
					// The block menu's Change icon, while the view lists a picker: the keyboard's way to it.
					menu: (block) => {
						const picker = calloutPickers.get(edytor);
						return picker
							? [
									{
										id: 'callout.icon',
										label: labels.calloutIcon.change,
										icon: 'block.callout',
										run: () => picker.open(block)
									}
								]
							: [];
					}
				},
				quote: {
					...quoteRead,
					...quoteWrite,
					container: true,
					snippet: textThenChildren,
					// Notion: `"` + space is a quote; `>` + space is a toggle.
					presets: presets('quote', [{ label: kinds.quote, icon: '❝', markdown: ['" '] }])
				},
				divider: {
					...richTextKinds.divider,
					...dividerRead,
					...dividerWrite,
					presets: presets('divider', [
						{ label: kinds.divider, icon: '—', keywords: ['hr', 'separator'], markdown: ['---'] }
					]),
					empty: { content: [], children: [] }
				},
				'ordered-list': {
					...richTextKinds['ordered-list'],
					...orderedRead,
					...orderedWrite,
					snippet: list
				},
				'unordered-list': {
					...richTextKinds['unordered-list'],
					...unorderedRead,
					...unorderedWrite,
					snippet: list
				},
				'list-item': { ...itemRead, ...itemWrite, snippet: listItem }
			}
		};
	};
</script>

<!--
	Every kind that has children renders them in one container marked
	`data-edytor-children`: the core indents it by one nesting step
	(`--edytor-nest-indent`), so nesting looks the same under any kind. Each
	snippet writes the container itself, with no whitespace between its tags
	(the comments hold the lines; prettier would add whitespace back): a
	nested snippet or a text node between tags is one more node per block for
	the browser to walk (`render.markers`).
-->
<!-- prettier-ignore -->
{#snippet nested(children: Snippet)}<div data-edytor-children>{@render children()}</div>{/snippet}

<!-- prettier-ignore -->
{#snippet paragraph({ content, children }: BlockSnippetPayload)}<!--
--><p>{@render content()}</p><!--
-->{#if children}{@render nested(children)}{/if}<!--
-->{/snippet}

<!--
	A toggle: its text the `summary`, its children the body; an empty body
	shows its hint, which the browser hides with the body while closed.
-->
<!-- prettier-ignore -->
{#snippet details({ block, content, children }: BlockSnippetPayload)}<!--
--><summary>{@render content()}</summary><!--
-->{#if children}{@render nested(children)}<!--
-->{:else}<EmptyBody {block} kind="toggle" />{/if}<!--
-->{/snippet}

<!--
	A heading's or quote's text (the core wraps it in the kind's `contentElement`,
	its `h1`–`h3` or `blockquote`); its children below, outside that tag, so
	heading styles and the heading's accessible name stop at its own text.
-->
<!-- prettier-ignore -->
{#snippet textThenChildren({ content, children }: BlockSnippetPayload)}<!--
-->{@render content()}<!--
-->{#if children}{@render nested(children)}{/if}<!--
-->{/snippet}

<!--
	A callout: its icon, its title (its own text), then its content (its
	children), or the hint of an empty one.
-->
<!-- prettier-ignore -->
{#snippet callout({ block, content, children }: BlockSnippetPayload<{ icon?: string }>)}<!--
--><CalloutIcon {block} /><!--
--><div data-edytor-callout-title>{@render content()}</div><!--
-->{#if children}{@render nested(children)}<!--
-->{:else}<EmptyBody {block} kind="callout" />{/if}<!--
-->{/snippet}

<!-- prettier-ignore -->
{#snippet todoItem({ block, content, children }: BlockSnippetPayload<{ checked?: boolean }>)}<!--
--><TodoCheckbox {block} /><!--
--><div>{@render content()}</div><!--
-->{#if children}{@render nested(children)}{/if}<!--
-->{/snippet}

<!--
	The same kinds, their controls drawn by the app's snippets (`checkbox`,
	`calloutIcon`, `emptyBody`) where it passes them.
-->
<!-- prettier-ignore -->
{#snippet todoItemOwn({ block, content, children }: BlockSnippetPayload<{ checked?: boolean }>)}<!--
--><RichTextControl {block} control="checkbox" /><!--
--><div>{@render content()}</div><!--
-->{#if children}{@render nested(children)}{/if}<!--
-->{/snippet}

<!-- prettier-ignore -->
{#snippet detailsOwn({ block, content, children }: BlockSnippetPayload)}<!--
--><summary>{@render content()}</summary><!--
-->{#if children}{@render nested(children)}<!--
-->{:else}<RichTextControl {block} control="toggle" />{/if}<!--
-->{/snippet}

<!-- prettier-ignore -->
{#snippet calloutOwn({ block, content, children }: BlockSnippetPayload<{ icon?: string }>)}<!--
--><RichTextControl {block} control="calloutIcon" /><!--
--><div data-edytor-callout-title>{@render content()}</div><!--
-->{#if children}{@render nested(children)}<!--
-->{:else}<RichTextControl {block} control="callout" />{/if}<!--
-->{/snippet}

<!-- prettier-ignore -->
{#snippet listItem({ content, children }: BlockSnippetPayload)}<!--
--><div>{@render content()}</div><!--
-->{#if children}{@render nested(children)}{/if}<!--
-->{/snippet}

<!--
	A list container (HTML import's `ol`/`ul`) groups its items: they are its
	rows, not blocks nested under its text, so its wrapper is not indented.
-->
<!-- prettier-ignore -->
{#snippet list({ children }: BlockSnippetPayload)}<!--
-->{#if children}<div>{@render children()}</div>{/if}<!--
-->{/snippet}
