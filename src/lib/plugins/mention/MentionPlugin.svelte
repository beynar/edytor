<script module lang="ts">
	import { type Plugin, type InlineBlockSnippetPayload } from '$lib/plugins.js';
	import { Text } from '$lib/text/text.svelte.js';
	import { tick } from 'svelte';
	export const mentionPlugin: Plugin = (edytor) => {
		return {
			onBeforeOperation: ({ operation, payload, block, prevent }) => {
				if (operation === 'insertText' && payload.value === '@') {
					const { yStart, startText } = edytor.selection.state;
					if (!startText) {
						return;
					}

					prevent(() => {
						const newText = block.addInlineBlock({
							index: yStart,
							text: startText,
							block: {
								type: 'mention',
								data: {}
							}
						});

						edytor.selection.setAtTextOffset(newText.id, 0);
					});
				}
			},
			inlineBlocks: {
				mention: {
					snippet: mention
				}
			}
		};
	};
</script>

<script>
</script>

{#snippet mention({ block }: InlineBlockSnippetPayload)}
	<kbd>@mention</kbd>
{/snippet}

<style>
	kbd {
		@apply px-0.5 py-0.5 rounded-md bg-slate-600/50;
	}
</style>
