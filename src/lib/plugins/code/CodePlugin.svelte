<script module lang="ts">
	import Prism from 'prismjs';
	import './prism.css';
	import 'prismjs/components/prism-jsx';
	import 'prismjs/components/prism-css';
	import type { Plugin, MarkSnippetPayload, BlockSnippetPayload } from '$lib/plugins.js';
	import type { JSONText } from '$lib/utils/json.js';
	import { prevent } from '$lib/utils.js';

	export const codePlugin: Plugin = (edytor) => {
		return {
			hotkeys: {
				tab: ({ prevent }) => {
					const { startText, yStart, startBlock } = edytor.selection.state;
					if (startText?.parent.type === 'codeLine') {
						prevent(() => {
							if (startBlock?.suggestions) {
								startBlock.acceptSuggestedText();
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
							const event = new InputEvent('', {
								inputType: 'insertParagraph'
							});
							edytor.onBeforeInput(event);
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

					if (operation === 'mergeBlockBackward' && block.parent.children.length === 1) {
						prevent();
					}
					if (
						operation === 'mergeBlockForward' &&
						block.index === block.parent.children.length - 1
					) {
						prevent();
					}
				}

				// if (block.type === 'code' && operation === 'addChildBlock') {
				// 	const selection = edytor.selection.state;
				// 	const text = selection.startText!;
				// 	const startWithTab = text.stringContent.startsWith('\t');
				// 	console.log({ startWithTab, text });
				// 	if (startWithTab && selection.isCollapsed) {
				// 		const tabsToInsert = Array.from({ length: text.stringContent.split('\t').length - 1 })
				// 			.fill('\t')
				// 			.join('');
				// 		payload.block.content = [{ text: tabsToInsert }, ...(payload.block.content || [])];
				// 	}
				// }
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
								text: token.content
							};
						}) as JSONText[];
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
	<div use:block.attach class="card rounded grid gap-2 bg-neutral-600 p-1">
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
	<div
		onclick={() => {
			if (block.suggestions) {
				block.suggestions = null;
			} else {
				block.suggestText({ value: 'hello' });
			}
		}}
		class="hover:bg-neutral-700"
		style:tab-size="7px"
		use:block.attach
	>
		{@render content()}
	</div>
{/snippet}

{#snippet codeToken({ content, mark }: MarkSnippetPayload)}
	<span class="token {mark}">{@render content()}</span>
{/snippet}
