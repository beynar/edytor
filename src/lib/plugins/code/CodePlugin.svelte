<script module lang="ts">
	import './code.css';
	import type { Plugin, MarkSnippetPayload, BlockSnippetPayload } from '$lib/plugins.js';
	import { Text } from '$lib/text/text.svelte.js';
	import { runIntent } from '$lib/events/beforeInputCommands.js';
	import { codeKinds } from '$lib/crdt/semantics.js';
	import { shown } from '$lib/selection/visibility.js';
	import { caretBeside } from '$lib/selection/replaceSelection.js';
	import CodeHeader from './CodeHeader.svelte';
	import LanguageMenuPanel from './LanguageMenu.svelte';
	import { LanguageMenu, languageMenus } from './languageMenu.svelte.js';
	import { onPress } from '$lib/events/onFocus.js';
	import { keywordsOf, labelsWith } from '$lib/labels.js';
	import {
		DEFAULT_CODE_SETTINGS,
		codeSettings,
		languageOf,
		tokenizeCode,
		type CodePluginOptions,
		type CodeSettings
	} from './languages.js';

	export {
		CODE_LANGUAGES,
		loadCodeLanguage,
		type CodeLanguage,
		type CodePluginOptions
	} from './languages.js';

	/** Auto-pairs typed at a collapsed caret in a code line. */
	const PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')', '"': '"', "'": "'" };
	const CLOSERS = new Set(Object.values(PAIRS));
	const QUOTES = new Set(['"', "'"]);

	/**
	 * Code blocks, in the languages `options` lists (`code.language`): the
	 * header names the block's language and picks another; each line is
	 * highlighted with its block's language, its grammar loaded the first
	 * time a line of it renders.
	 */
	export const createCodePlugin =
		(options: CodePluginOptions = {}): Plugin =>
		(edytor) => {
			const own: CodeSettings = {
				languages: options.languages ?? DEFAULT_CODE_SETTINGS.languages,
				defaultLanguage: options.defaultLanguage ?? DEFAULT_CODE_SETTINGS.defaultLanguage,
				labels: labelsWith('code', options.labels)
			};
			codeSettings.set(edytor, own);
			// The view's language list: the first code plugin listed owns it.
			if (edytor && !languageMenus.has(edytor))
				languageMenus.set(edytor, new LanguageMenu(edytor, own));
			const ownMenu = () => {
				const menu = languageMenus.get(edytor);
				return menu?.settings === own ? menu : undefined;
			};
			/** A line's language: its code block's (read through the cell: a pick re-renders it). */
			const lineLanguage = (id: string) => {
				const language = languageOf(edytor.idToBlock.get(id)?.parent?.data, own);
				return own.languages.find((row) => row.id === language);
			};
			/**
			 * The code lines a selection touches, when both its ends are lines of
			 * one code block. A range ending at a line's start leaves that line out,
			 * as code editors do.
			 */
			const touchedLines = () => {
				const { startText, endText, yEnd, isCollapsed } = edytor.selection.state;
				const [from, to] = [startText?.parent, endText?.parent];
				if (from?.type !== 'codeLine' || to?.type !== 'codeLine' || from.parent !== to.parent)
					return null;
				const lines = from.parent!.children.slice(from.index, to.index + 1);
				return !isCollapsed && lines.length > 1 && yEnd === 0 ? lines.slice(0, -1) : lines;
			};

			/**
			 * Tab (`1`) or Shift+Tab (`-1`) over code lines, as one command over
			 * several parts (`dispatcher.each`): each line the selection touches
			 * gains a leading tab, or loses one leading tab or up to two spaces (the
			 * tab size); a line a plugin vetoes is skipped and the others still
			 * move. The selection keeps its characters.
			 */
			const indent = (step: 1 | -1) => {
				const { startText, endText, yStart, yEnd, isReversed } = edytor.selection.state;
				const shifts = new Map<Text, number>();
				const kind = step > 0 ? 'indentLines' : 'dedentLines';
				edytor.dispatcher.each(kind, touchedLines() ?? [], (line) => {
					const text = line.firstText;
					if (!text) return;
					if (step > 0) {
						text.insertText({ value: '\t', start: 0, end: 0 });
						return shifts.set(text, 1);
					}
					const removed = /^(\t| {1,2})/.exec(text.stringContent)?.[0].length ?? 0;
					if (!removed) return;
					line.deleteContentAtRange({ start: [text.index, 0], end: [text.index, removed] });
					shifts.set(text, -removed);
				});
				const moved = (text: Text | null, offset: number) =>
					Math.max(0, offset + (text ? (shifts.get(text) ?? 0) : 0));
				if (startText && endText)
					edytor.selection.setAtRange(
						startText,
						moved(startText, yStart),
						endText,
						moved(endText, yEnd),
						{ isReversed }
					);
			};

			return {
				onEdytorAttached: ({ node }) => {
					const menu = ownMenu();
					if (!menu) return;
					const offPress = onPress(edytor, node.ownerDocument, menu.pressed, true);
					const unmount = edytor.overlay.mount(
						LanguageMenuPanel,
						{ menu, readonly: () => edytor.readonly },
						'edytor-code-language-host',
						// Above the block handles (5), as the equation editor.
						7,
						menu.measure
					);
					return () => {
						offPress();
						unmount();
						menu.close();
					};
				},
				hotkeys: {
					// Alt+F10 at a caret in a code line: the keys go to its language button
					// (as to a toolbar); Escape there gives them back.
					'alt+f10': ({ prevent }) => {
						const button = ownMenu()?.buttonAtCaret();
						if (button) prevent(() => button.focus({ preventScroll: true }));
					},
					'mod+a': ({ prevent }) => {
						// Select the code block's text; once it is (or when it has none), Select
						// all takes the next step: the code block.
						const { startBlock, startText, endText, yStart, yEnd } = edytor.selection.state;
						if (startBlock?.type !== 'codeLine' || edytor.selection.selectedBlocks.size) return;
						const code = edytor.idToBlock.get(edytor.selection.projection.islandRoot ?? '');
						const [first, last] = [code?.firstEditableText, code?.lastEditableText];
						if (!first || !last) return;
						const whole =
							startText === first && yStart === 0 && endText === last && yEnd === last.length;
						if (!whole) prevent(() => edytor.selection.setAtTextsRange(first, last));
					},
					escape: () => {
						// A completion (`end` suggestion) in a code line goes; the key goes on.
						const { startBlock } = edytor.selection.state;
						if (startBlock?.type === 'codeLine')
							for (const ghost of edytor.suggestions.at(startBlock.id).end) ghost.discard();
					},
					tab: ({ prevent }) => {
						const { startText, yStart, startBlock, isCollapsed } = edytor.selection.state;
						if (startText?.parent.type !== 'codeLine') return;
						// Tab accepts a completion in a code line (its caret ends it), else indents.
						const ghost = startBlock && edytor.suggestions.at(startBlock.id).end.at(-1);
						if (ghost) return prevent(() => ghost.accept());
						if (isCollapsed) {
							return prevent(() => {
								startText.insertText({ value: '\t', start: yStart, end: yStart });
								edytor.selection.setAtTextOffset(startText, yStart + 1);
							});
						}
						if (touchedLines()) prevent(() => indent(1));
					},
					'shift+tab': ({ prevent }) => {
						if (touchedLines()) prevent(() => indent(-1));
					},
					'shift+enter': ({ prevent }) => {
						// Always a new line, in the empty last line too (where Enter leaves the block).
						const { startBlock: line, isCollapsed } = edytor.selection.state;
						if (line?.type !== 'codeLine') return;
						if (isCollapsed && line.isEmpty) {
							const next = () => line.insertBlockAfter({ block: { type: 'codeLine' } });
							return prevent(() => edytor.dispatcher.caret(next()?.firstText, 0));
						}
						prevent(() => runIntent(edytor, 'insertParagraph'));
					}
				},
				onBeforeOperation: ({ operation, payload, block, prevent }) => {
					// Delete before a code block: an empty block is removed, the caret at
					// the end of the text before it (else the start of the code); any other
					// is refused.
					const code = operation === 'mergeBlockForward' ? shown(block, 'blockAfter') : null;
					if (code?.type === 'code') {
						if (!block.isEmpty) prevent();
						prevent(() => {
							const before = caretBeside(block, 'blockBefore', new Set([block]));
							block.removeBlock();
							edytor.dispatcher.caret(before?.text ?? code.firstEditableText, before?.offset ?? 0);
						});
					}
					// Backspace in an empty block right after a code block removes it; the
					// caret goes to the end of the code (the merge would be refused).
					const previous =
						operation === 'mergeBlockBackward' && block.type !== 'codeLine' && block.isEmpty
							? shown(block, 'blockBefore')
							: null;
					if (previous?.type === 'codeLine') {
						prevent(() => {
							block.removeBlock();
							const text = previous.lastText;
							edytor.dispatcher.caret(text, text?.length ?? 0);
						});
					}
					if (block.type !== 'codeLine') return;
					const { startText, yStart, isCollapsed } = edytor.selection.state;
					if (operation === 'insertText' && isCollapsed && startText) {
						const { value } = payload;
						const [at, line] = [payload.start ?? yStart, startText.stringContent];
						// A closer typed before the same character steps over it.
						if (CLOSERS.has(value) && line[at] === value) {
							prevent(() => edytor.dispatcher.caret(startText, at + 1));
						}
						// Quotes pair only at a word boundary: the apostrophe in `don't` stays single.
						const inWord = QUOTES.has(value) && /\w/.test((line[at - 1] ?? '') + (line[at] ?? ''));
						if (Object.hasOwn(PAIRS, value) && !inWord) {
							return { ...payload, value: value + PAIRS[value] };
						}
					}
					// A code line never merges out of its island's first or last slot
					// (the code block renders no content of its own).
					const siblings = block.parent?.children.length ?? 0;
					if (operation === 'mergeBlockBackward' && block.index === 0) prevent();
					if (operation === 'mergeBlockForward' && block.index === siblings - 1) prevent();
				},

				blocks: {
					code: {
						...codeKinds.code,
						snippet: code,
						presets: [
							{
								label: own.labels.code,
								icon: '</>',
								keywords: keywordsOf('block.code', ['code block', 'snippet'], options.keywords),
								markdown: ['```'],
								group: 'Media'
							}
						],
						empty: { content: [], children: [{ type: 'codeLine', content: [{ text: '' }] }] }
					},
					codeLine: {
						snippet: codeLine,
						html: (_, content) => `<pre><code>${content}</code></pre>`,
						transformText: ({ text, block }) =>
							tokenizeCode(text.stringContent, lineLanguage(block.id)),
						// A line holding newlines keeps its first line; each other becomes a code line after it.
						normalizeContent: ({ block }) => {
							const text = block.content.at(0);
							if (!(text instanceof Text)) return;
							const [first, ...rest] = text.stringContent.split('\n');
							if (!rest.length) return;
							text.deleteAt(0, text.stringContent.length);
							text.insertAt(0, first!);
							block.parent?.insertChildren(
								block.index + 1,
								rest.map((line) => ({ type: 'codeLine', content: [{ text: line }] }))
							);
						}
					}
				},
				marks: {
					codeToken
				}
			};
		};

	/** Code blocks in `CODE_LANGUAGES`, JavaScript by default. */
	export const codePlugin: Plugin = createCodePlugin();
</script>

{#snippet code({ block, children }: BlockSnippetPayload<{ language?: string }>)}
	<CodeHeader {block} />
	<pre class="th-code"><code>{@render children?.()}</code></pre>
{/snippet}

{#snippet codeLine({ content }: BlockSnippetPayload)}
	{@render content()}
{/snippet}

{#snippet codeToken({ content, mark }: MarkSnippetPayload)}
	<span class="th-{mark}">{@render content()}</span>
{/snippet}
