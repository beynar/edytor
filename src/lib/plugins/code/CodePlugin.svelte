<script module lang="ts">
	import Prism from 'prismjs';
	import './prism.css';
	import 'prismjs/components/prism-jsx';
	import type { Plugin, MarkSnippetPayload, BlockSnippetPayload } from '$lib/plugins.js';
	import type { JSONText } from '$lib/utils/json.js';
	import { prevent } from '$lib/utils.js';

	class Test {
		state = $state(0);
	}

	export const codePlugin: Plugin = (edytor) => {
		const test = new Test();

		return {
			defaultBlock: (parent) => {
				if (parent.type === 'code' || parent.type === 'codeLine') {
					return 'codeLine';
				}
			},
			onTab({ prevent, e }) {
				const { startText, yStart } = edytor.selection.state;
				if (startText?.parent.type === 'codeLine') {
					e.preventDefault();
					e.stopPropagation();
					prevent(() => {
						if (startText) {
							startText.insertText({ value: '\t' });
							edytor.selection.setAtTextOffset(startText, yStart + 1);
						}
					});
				}
			},
			onSoftBreak: ({ prevent, e }) => {
				const { startText } = edytor.selection.state;
				if (startText?.parent.type === 'codeLine') {
					prevent(() => {
						const event = new InputEvent('insertParagraph', {
							inputType: 'insertParagraph'
						});
						edytor.onBeforeInput(event);
					});
				}
			},
			onBeforeOperation: ({ operation, payload, edytor, block }) => {
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
						test.state++;
						console.log('mergeBlockBackward', test.state);
						prevent();
					}
					if (
						operation === 'mergeBlockForward' &&
						block.index === block.parent.children.length - 1
					) {
						prevent();
					}
				}

				if (block.type === 'code' && operation === 'addBlock') {
					const selection = edytor.selection.state;
					const text = selection.startText!;
					const startWithTab = text.stringContent.startsWith('\t');
					if (startWithTab && selection.isCollapsed && selection.isAtEnd) {
						const tabsToInsert = Array.from({ length: text.stringContent.split('\t').length - 1 })
							.fill('\t')
							.join('');
						console.log({ tabsToInsert });
						payload.block.content = [{ text: tabsToInsert }, ...(payload.block.content || [])];
					}
				}
			},
			transformContent: {
				codeLine: ({ text }) => {
					console.log('here', test.state);
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
			},
			blocks: {
				code,
				codeLine
			},
			marks: {
				codeToken
			}
		};
	};
</script>

{#snippet code({ content, block, children }: BlockSnippetPayload)}
	<div use:block.attach class="card rounded grid gap-2 bg-neutral-600 p-1">
		<div use:block.edytor.void class="text-xs flex justify-between">
			<code>html</code>
			<div>
				<button
					onclick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						navigator.clipboard.writeText(block.content.stringContent);
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
	<div class="hover:bg-neutral-700" style:tab-size="7px" use:block.attach={{ isIsolate: true }}>
		{@render content()}
	</div>
{/snippet}

{#snippet codeToken({ content, mark }: MarkSnippetPayload)}
	<span class="token {mark}">{@render content()}</span>
{/snippet}
