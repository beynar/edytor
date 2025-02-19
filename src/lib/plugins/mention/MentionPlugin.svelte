<script module lang="ts">
	import { type Plugin, type InlineBlockSnippetPayload } from '$lib/plugins.js';
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
	<kbd
		class={block.selected ? 'ring ring-1 ring-purple-300' : ''}
		data-edytor-mention
		use:block.attach>@mention {block.selected ? 'selected' : 'false'}</kbd
	>
{/snippet}
