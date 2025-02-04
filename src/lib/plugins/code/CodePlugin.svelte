<script module lang="ts">
	import Prism from 'prismjs';
	import './prism.css';
	import 'prismjs/components/prism-jsx';
	import type { Plugin, MarkSnippetPayload, BlockSnippetPayload } from '$lib/plugins.js';
	import type { JSONText } from '$lib/utils/json.js';

	export const codePlugin: Plugin = (edytor) => {
		return {
			onEnter({ prevent }) {
				const { startText, yStart } = edytor.selection.state;
				if (startText?.parent.type === 'code') {
					prevent(() => {
						if (startText) {
							startText.insertText({ value: '\n' });
							edytor.selection.setAtTextOffset(startText, yStart + 1);
						}
					});
				}
			},

			onTab({ prevent, e }) {
				const { startText, yStart } = edytor.selection.state;
				if (startText?.parent.type === 'code') {
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
			transformContent: {
				code: ({ text }) => {
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
				code
			},
			marks: {
				codeToken
			}
		};
	};
</script>

{#snippet code({ content, block }: BlockSnippetPayload)}
	<pre use:block.attach class="language-jsx"><code class="language-jsx">{@render content()}</code
		></pre>
{/snippet}

{#snippet codeToken({ content, mark }: MarkSnippetPayload)}
	<span class="token {mark}">{@render content()}</span>
{/snippet}
