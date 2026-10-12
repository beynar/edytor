<script lang="ts">
	import { words } from './words.svelte.js';
	import type { CommentsController } from '$lib/index.js';

	/** Notion's top of the comments margin, drawn for `createCommentsPlugin({ header })`: the resolved toggle. */
	let { comments }: { comments: CommentsController } = $props();
</script>

{#if comments.resolved.length > 0}
	<button
		type="button"
		data-edytor-comments-toggle
		aria-pressed={comments.showResolved}
		onclick={() => (comments.showResolved = !comments.showResolved)}
		>{comments.showResolved
			? words.comments.hideResolved
			: words.comments.showResolved(comments.resolved.length)}</button
	>
{/if}

<style>
	button {
		border: 0;
		border-radius: 6px;
		padding: 2px 8px;
		background: transparent;
		color: rgb(120 119 116);
		font:
			13px/1.45 ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			Helvetica,
			sans-serif;
		cursor: pointer;
	}
	button:hover {
		background: rgb(55 53 47 / 0.08);
	}
</style>
