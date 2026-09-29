<script module lang="ts">
	import { type Plugin, type InlineBlockSnippetPayload } from '$lib/plugins.js';

	export const mentionPlugin: Plugin = (edytor) => ({
		onBeforeOperation: ({ operation, payload, block, prevent }) => {
			if (operation !== 'insertText' || payload.value !== '@') return;
			const { yStart, startText } = edytor.selection.state;
			if (!startText) return;
			// The atom replaces the typed `@`; the caret lands after it.
			prevent(() => {
				const after = block.addInlineBlock({
					index: yStart,
					text: startText,
					block: { type: 'mention', data: {} }
				});
				edytor.dispatcher.caret(after, 0);
			});
		},
		inlineBlocks: {
			mention: {
				snippet: mention,
				plain: (data) => {
					const { label, name, title, id } = (data ?? {}) as Record<string, unknown>;
					const value = label ?? name ?? title ?? id;
					if (typeof value !== 'string' && typeof value !== 'number') return '@mention';
					return String(value).startsWith('@') ? String(value) : `@${value}`;
				}
			}
		}
	});
</script>

{#snippet mention({ block }: InlineBlockSnippetPayload)}
	<kbd class={block.selected ? 'ring ring-1 ring-purple-300' : ''} data-edytor-mention
		>@mention {block.selected ? 'selected' : 'false'}</kbd
	>
{/snippet}
