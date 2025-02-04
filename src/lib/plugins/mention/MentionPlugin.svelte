<script module lang="ts">
	import type { Plugin, MarkSnippetPayload } from '$lib/plugins.js';
	export const mentionPlugin: Plugin = (edytor) => {
		return {
			onBeforeOperation: ({ operation, payload, text, prevent }) => {
				if (operation === 'insertText' && payload.value === '@' && !payload.marks?.mention) {
					prevent(() => {
						const { yStart } = edytor.selection.state;
						text.yText.insert(yStart, '@', { mention: 'search' });
						edytor.selection.shift(1);
						edytor.selection.setAtTextOffset(text, yStart + 1);
					});
				}
			},
			marks: {
				mention
			}
		};
	};
</script>

<script>
</script>

{#snippet mention({ content }: MarkSnippetPayload)}
	<kbd style="background-color: #f0f0f0; color: var(--color-primary-contrast);">
		{@render content()}
	</kbd>
{/snippet}
