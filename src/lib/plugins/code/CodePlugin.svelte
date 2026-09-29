<script module lang="ts">
	import { createHighlighter } from '@tanstack/highlight/core';
	import { jsx } from '@tanstack/highlight/languages/jsx';
	import './code.css';
	import type { Plugin, MarkSnippetPayload, BlockSnippetPayload } from '$lib/plugins.js';
	import type { JSONText } from '$lib/utils/json.js';
	import { id, prevent } from '$lib/utils.js';
	import { Text } from '$lib/text/text.svelte.js';
	import { Block } from '$lib/block/block.svelte.js';
	import { runIntent } from '$lib/events/beforeInputCommands.js';
	import { codeKinds } from '$lib/crdt/semantics.js';

	// The code kind tokenizes through `transformText`; only the renderer writes the DOM.
	const highlighter = createHighlighter({ languages: [jsx] });

	/** Auto-pairs typed at a collapsed caret in a code line. */
	const PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')', '"': '"', "'": "'" };
	const CLOSERS = new Set(Object.values(PAIRS));
	const QUOTES = new Set(['"', "'"]);

	const getCodeText = (block: Block) =>
		block.children
			.map((line) =>
				line.content.map((part) => (part instanceof Text ? part.stringContent : '')).join('')
			)
			.join('\n');

	export const codePlugin: Plugin = (edytor) => {
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
		 * Tab (`1`) or Shift+Tab (`-1`) over code lines, as one command: each line
		 * the selection touches gains a leading tab, or loses one leading tab or
		 * up to two spaces (the tab size); the selection keeps its characters.
		 */
		const indent = (step: 1 | -1) => {
			const { startText, endText, yStart, yEnd, isReversed } = edytor.selection.state;
			const shifts = new Map<Text, number>();
			edytor.dispatcher.run(step > 0 ? 'indentLines' : 'dedentLines', () => {
				for (const line of touchedLines() ?? []) {
					const text = line.firstText;
					if (!text) continue;
					if (step > 0) {
						text.insertText({ value: '\t', start: 0, end: 0 });
						shifts.set(text, 1);
						continue;
					}
					const removed = /^(\t| {1,2})/.exec(text.stringContent)?.[0].length ?? 0;
					if (!removed) continue;
					line.deleteContentAtRange({ start: [text.index, 0], end: [text.index, removed] });
					shifts.set(text, -removed);
				}
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
			hotkeys: {
				'mod+a': ({ prevent }) => {
					const { startBlock } = edytor.selection.state;
					const {
						islandRoot: root,
						isAtEndOfBlock,
						isAtStartOfBlock
					} = edytor.selection.projection;
					const islandRoot = edytor.idToBlock.get(root ?? '');
					if (
						startBlock?.type === 'codeLine' &&
						!edytor.selection.selectedBlocks.size &&
						!(isAtEndOfBlock && isAtStartOfBlock)
					) {
						prevent(() => {
							const firstText = islandRoot?.firstEditableText;
							let lastText = islandRoot?.lastEditableText;
							if (firstText && lastText && firstText instanceof Text && lastText instanceof Text) {
								edytor.selection.setAtTextsRange(firstText, lastText);
							}
						});
					}
				},
				escape: () => {
					const { startBlock } = edytor.selection.state;
					if (startBlock?.type === 'codeLine' && startBlock?.suggestions) {
						startBlock.suggestions = null;
					}
				},
				tab: ({ prevent }) => {
					const { startText, yStart, startBlock, isCollapsed } = edytor.selection.state;
					if (startText?.parent.type !== 'codeLine') return;
					if (startBlock?.suggestions) {
						return prevent(() => {
							startBlock.acceptSuggestedText();
							edytor.selection.setAtTextOffset(startText, startText.length);
						});
					}
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
				'shift+enter': () => {
					const { startText } = edytor.selection.state;
					if (startText?.parent.type === 'codeLine') {
						prevent(() => runIntent(edytor, 'insertParagraph'));
					}
				}
			},
			onBeforeOperation: ({ operation, payload, block }) => {
				// Delete before a code block: an empty block is removed, the caret at
				// the end of the text before it (else the start of the code); any other
				// is refused.
				const code =
					operation === 'mergeBlockForward' ? edytor.selection.shown(block, 'blockAfter') : null;
				if (code?.type === 'code') {
					if (!block.isEmpty) prevent();
					prevent(() => {
						const before = edytor.selection.shown(block, 'blockBefore')?.lastEditableText;
						block.removeBlock();
						const text = before ?? code.firstEditableText;
						edytor.dispatcher.caret(text, before?.length ?? 0);
					});
				}
				// Backspace in an empty block right after a code block removes it; the
				// caret goes to the end of the code (the merge would be refused).
				const previous =
					operation === 'mergeBlockBackward' && block.type !== 'codeLine' && block.isEmpty
						? edytor.selection.shown(block, 'blockBefore')
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
				// (the code block renders no content of its own, XW-12).
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
							label: 'Code',
							icon: '</>',
							keywords: ['code block', 'snippet'],
							markdown: ['```'],
							group: 'Media'
						}
					],
					empty: { content: [], children: [{ type: 'codeLine', content: [{ text: '' }] }] }
				},
				codeLine: {
					snippet: codeLine,
					html: (_, content) => `<pre><code>${content}</code></pre>`,
					transformText: ({ text }) =>
						highlighter
							.tokenize(text.stringContent, { lang: 'jsx' })
							.tokens.map(
								({ className, value }): JSONText =>
									className ? { text: value, marks: { codeToken: className } } : { text: value }
							),
					normalizeContent: ({ block }) => {
						// here we need to check if the code line has soft line breaks and if so, we need to insert a new code line after the current one.
						const firstText = block.content.at(0);
						if (!(firstText instanceof Text)) return;

						const content = firstText.stringContent;
						const lines = content.split('\n');

						if (lines.length > 1) {
							// Remove the current content
							firstText.deleteAt(0, content.length);
							// Insert the first line back
							firstText.insertAt(0, lines[0]);
							// Create new code lines for each remaining line
							for (let i = 1; i < lines.length; i++) {
								if (!block.parent) {
									return;
								}
								block.parent.insertChildren(block.index + i, [
									{ type: 'codeLine', content: [{ text: lines[i]! }] }
								]);
							}
						}
					}
				}
			},
			marks: {
				codeToken
			}
		};
	};
</script>

{#snippet code({ block, children }: BlockSnippetPayload)}
	<div use:block.void data-edytor-code-header>
		<span data-edytor-code-language>JavaScript</span>
		<button
			type="button"
			onmousedown={(e) => e.preventDefault()}
			onclick={async (e) => {
				e.preventDefault();
				e.stopPropagation();
				const button = e.currentTarget;
				await navigator.clipboard.writeText(getCodeText(block.handle));
				button.textContent = 'Copied';
				setTimeout(() => (button.textContent = 'Copy'), 1200);
			}}>Copy</button
		>
	</div>
	<pre class="th-code"><code>{@render children?.()}</code></pre>
{/snippet}

{#snippet codeLine({ content }: BlockSnippetPayload)}
	{@render content()}
{/snippet}

{#snippet codeToken({ content, mark }: MarkSnippetPayload)}
	<span class="th-{mark}">{@render content()}</span>
{/snippet}
