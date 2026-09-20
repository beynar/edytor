<script module lang="ts">
	import { type Plugin, type InlineBlockSnippetPayload } from '$lib/plugins.js';
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

						const getLiveText = () => edytor.getTextById(newText.id) ?? newText;
						const trailingTextBeforeNextInput = getLiveText().stringContent;
						const shouldRestoreSelection = () =>
							getLiveText().stringContent === trailingTextBeforeNextInput;
						const restoreSelection = () => {
							if (!shouldRestoreSelection()) {
								return;
							}
							edytor.selection.setCollapsedStateAtTextOffset(getLiveText(), 0);
						};
						const restoreDomSelection = () => {
							if (!shouldRestoreSelection()) {
								return;
							}
							if (!edytor.node) {
								restoreSelection();
								return;
							}
							edytor.selection.ignoreNextSelectionChange = true;
							void edytor.selection.setAtTextOffset(getLiveText(), 0).finally(restoreSelection);
						};

						edytor.selection.ignoreNextSelectionChange = true;
						restoreSelection();
						void tick().then(() => {
							restoreDomSelection();
							setTimeout(restoreDomSelection);
							setTimeout(restoreDomSelection, 30);
						});
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
