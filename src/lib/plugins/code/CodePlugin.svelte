<script module lang="ts">
	import Prism from 'prismjs';
	import './prism.css';
	import type { Plugin, MarkSnippetPayload, BlockSnippetPayload } from '$lib/plugins.js';
	import type { JSONText } from '$lib/utils/json.js';
	import { id, prevent } from '$lib/utils.js';
	import { Text } from '$lib/text/text.svelte.js';
	import { Block } from '$lib/block/block.svelte.js';

	(globalThis as typeof globalThis & { Prism?: typeof Prism }).Prism = Prism;

	type PrismTokenLike = {
		type: string;
		content: unknown;
	};

	const isPrismToken = (value: unknown): value is PrismTokenLike =>
		Boolean(value && typeof value === 'object' && 'type' in value && 'content' in value);

	const getPrismTokenText = (content: unknown): string => {
		if (typeof content === 'string') {
			return content;
		}
		if (Array.isArray(content)) {
			return content.map(getPrismTokenText).join('');
		}
		if (isPrismToken(content)) {
			return getPrismTokenText(content.content);
		}
		return '';
	};

	await Promise.all([
		import('prismjs/components/prism-jsx'),
		import('prismjs/components/prism-css')
	]);

	export const codePlugin: Plugin = (edytor) => {
		return {
			hotkeys: {
				'mod+a': ({ prevent }) => {
					const { islandRoot, startBlock, isAtEndOfBlock, isAtStartOfBlock } =
						edytor.selection.state;
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
								edytor.selection.setAtTextOffset(startText, startText.yText.length);
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
						prevent(() => {
							const event =
								typeof InputEvent !== 'undefined'
									? new InputEvent('beforeinput', {
											bubbles: true,
											cancelable: true,
											inputType: 'insertParagraph'
										})
									: Object.assign(new Event('beforeinput', { bubbles: true, cancelable: true }), {
											inputType: 'insertParagraph'
										});
							edytor.onBeforeInput(event as InputEvent);
						});
					}
				}
			},
			defaultBlock: (parent) => {
				if (parent.type === 'code' || parent.type === 'codeLine') {
					return 'codeLine';
				}
			},
			onBeforeOperation: ({ operation, payload, block }) => {
				if (block.closestNextBlock?.type === 'code' && operation === 'mergeBlockForward') {
					if (block.isEmpty) {
						prevent(() => {
							block.mergeBlockBackward();
						});
					} else {
						prevent();
					}
				}
				if (block.type === 'codeLine') {
					const selection = edytor.selection.state;
					const isCollapsed = selection.isCollapsed;
					if (operation === 'insertText') {
						if (isCollapsed) {
							if (payload.value === '{') {
								payload.value = '{}';
							}
							if (payload.value === '[') {
								payload.value = '[]';
							}
							if (payload.value === '(') {
								payload.value = '()';
							}
							if (payload.value === '"') {
								payload.value = '""';
							}
							if (payload.value === "'") {
								payload.value = "''";
							}
						}
					}

					if (
						operation === 'mergeBlockBackward' &&
						block.parent &&
						block.parent.children.length === 1
					) {
						prevent();
					}
					if (
						operation === 'mergeBlockForward' &&
						block.parent &&
						block.index === block.parent.children.length - 1
					) {
						prevent();
					}
				}
			},

			blocks: {
				code: {
					snippet: code,
					island: true
				},
				codeLine: {
					snippet: codeLine,
					transformText: ({ text }) => {
						const tokens = Prism.tokenize(text.stringContent, Prism.languages['jsx']);
						return tokens.map((token) => {
							if (typeof token === 'string') {
								return {
									text: token
								};
							}
							return {
								marks: { codeToken: token.type },
								text: getPrismTokenText(token.content)
							};
						}) as JSONText[];
					},
					normalizeContent: ({ block }) => {
						// here we need to check if the code line has soft line breaks and if so, we need to insert a new code line after the current one.
						const firstText = block.content.at(0);
						if (!(firstText instanceof Text)) return;
						const yText = firstText.yText;

						const content = yText.toString();
						const lines = content.split('\n');

						if (lines.length > 1) {
							// Remove the current content
							yText.delete(0, content.length);
							// Insert the first line back
							yText.insert(0, lines[0]);
							// Create new code lines for each remaining line
							for (let i = 1; i < lines.length; i++) {
								if (!block.parent) {
									return;
								}
								const newBlock = new Block({
									edytor,
									block: {
										type: 'codeLine',
										content: [{ text: lines[i] }]
									},
									parent: block.parent
								});
								block.parent.yChildren.insert(block.index + i, [newBlock.yBlock]);
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
	<div use:block.attach class="grid gap-2 rounded bg-neutral-600 p-1">
		<div use:block.void class="text-xs flex justify-between">
			<code>html</code>
			<div>
				<button
					onclick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						// navigator.clipboard.writeText(block.content.stringContent);
					}}
				>
					Copy
				</button>
			</div>
		</div>
		<pre use:block.attach class="language-jsx"><code class="language-jsx"
				>{@render children?.()}</code
			></pre>
	</div>
{/snippet}

{#snippet codeLine({ content, block }: BlockSnippetPayload)}
	<div class="hover:bg-neutral-700" style:tab-size="7px" use:block.attach>
		{@render content()}
	</div>
{/snippet}

{#snippet codeToken({ content, mark }: MarkSnippetPayload)}
	<span class="token {mark}">{@render content()}</span>
{/snippet}
