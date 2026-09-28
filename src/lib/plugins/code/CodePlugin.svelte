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

	// The code kind tokenizes through `transformText`; only the renderer writes the DOM.
	const highlighter = createHighlighter({ languages: [jsx] });

	/** Auto-pairs typed at a collapsed caret in a code line. */
	const PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')', '"': '"', "'": "'" };

	const getCodeText = (block: Block) =>
		block.children
			.map((line) =>
				line.content.map((part) => (part instanceof Text ? part.stringContent : '')).join('')
			)
			.join('\n');

	export const codePlugin: Plugin = (edytor) => {
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
					const { startText, yStart, startBlock } = edytor.selection.state;
					if (startText?.parent.type === 'codeLine') {
						prevent(() => {
							if (startBlock?.suggestions) {
								startBlock.acceptSuggestedText();
								edytor.selection.setAtTextOffset(startText, startText.length);
							} else {
								if (startText) {
									startText.insertText({ value: '\t' });
									edytor.selection.setAtTextOffset(startText, yStart + 1);
								}
							}
						});
					}
				},
				'shift+enter': () => {
					const { startText } = edytor.selection.state;
					if (startText?.parent.type === 'codeLine') {
						prevent(() => runIntent(edytor, 'insertParagraph'));
					}
				}
			},
			onBeforeOperation: ({ operation, payload, block }) => {
				// Delete before a code block: an empty block is removed (the command is
				// replaced by merging it backward), any other is refused.
				if (operation === 'mergeBlockForward' && block.closestNextBlock?.type === 'code') {
					if (!block.isEmpty) prevent();
					prevent(() => {
						const into = block.mergeBlockBackward();
						const text = into?.lastText;
						edytor.dispatcher.caret(text, text?.length ?? 0);
					});
				}
				if (block.type !== 'codeLine') return;
				if (
					operation === 'insertText' &&
					edytor.selection.state.isCollapsed &&
					Object.hasOwn(PAIRS, payload.value)
				) {
					return { ...payload, value: payload.value + PAIRS[payload.value] };
				}
				// A code line never merges out of its island's first or last slot.
				const siblings = block.parent?.children.length ?? 0;
				if (operation === 'mergeBlockBackward' && siblings === 1) prevent();
				if (operation === 'mergeBlockForward' && block.index === siblings - 1) prevent();
			},

			blocks: {
				code: {
					snippet: code,
					element: { tag: 'div', attributes: { class: 'grid gap-2 rounded bg-neutral-600 p-1' } },
					island: true,
					rendersContent: false,
					defaultChild: 'codeLine',
					presets: [
						{ label: 'Code', icon: '</>', keywords: ['code block', 'snippet'], markdown: ['```'] }
					],
					empty: { content: [], children: [{ type: 'codeLine', content: [{ text: '' }] }] }
				},
				codeLine: {
					snippet: codeLine,
					element: { tag: 'div', attributes: { style: 'tab-size: 7px' } },
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
	<div use:block.void class="text-xs flex justify-between">
		<code>JavaScript</code>
		<div>
			<button
				onclick={async (e) => {
					e.preventDefault();
					e.stopPropagation();
					await navigator.clipboard.writeText(getCodeText(block.handle));
				}}
			>
				Copy
			</button>
		</div>
	</div>
	<pre class="th-code"><code>{@render children?.()}</code></pre>
{/snippet}

{#snippet codeLine({ content }: BlockSnippetPayload)}
	{@render content()}
{/snippet}

{#snippet codeToken({ content, mark }: MarkSnippetPayload)}
	<span class="th-{mark}">{@render content()}</span>
{/snippet}
