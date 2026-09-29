<script module lang="ts">
	/**
	 * A consumer kind with two presets differing on a key other than `level`:
	 * the kind catalogue must name a block by its closest preset.
	 */
	import type { BlockSnippetPayload, Plugin } from '$lib/plugins.js';

	export const notePlugin: Plugin = () => ({
		blocks: {
			note: {
				snippet: note,
				presets: [
					{ label: 'Info note', icon: 'i', data: { tone: 'info' } },
					{ label: 'Warning note', icon: '!', data: { tone: 'warn' } }
				]
			}
		}
	});
</script>

{#snippet note({ content, children }: BlockSnippetPayload)}
	<div>{@render content()}</div>
	{@render children?.()}
{/snippet}
