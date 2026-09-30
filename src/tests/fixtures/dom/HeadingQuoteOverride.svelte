<script module lang="ts">
	/**
	 * The snippet override of editor/edytor-component.mdx for heading and quote:
	 * a mark before the text, the children after it. The override replaces the
	 * snippet only; the heading's `h1`–`h3` and the quote's `blockquote` stay.
	 */
	import type { BlockSnippetPayload } from '$lib/plugins.js';

	export { ownBlock };
</script>

{#snippet ownBlock({ content, children }: BlockSnippetPayload)}
	<span class="own-mark" contenteditable="false">“</span>
	{@render content()}
	{#if children}<div class="own-children">{@render children()}</div>{/if}
{/snippet}
