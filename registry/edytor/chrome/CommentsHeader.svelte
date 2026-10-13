<script lang="ts">
	import { Button } from '$registry/ui/button/index.js';
	import { words } from './words.svelte.js';
	import type { CommentsController } from 'edytor';

	/** Notion's top of the comments margin, drawn for `createCommentsPlugin({ header })`: the resolved toggle. */
	let { comments }: { comments: CommentsController } = $props();
</script>

{#if comments.resolved.length > 0}
	<Button
		variant="ghost"
		data-edytor-comments-toggle
		aria-pressed={comments.showResolved}
		onclick={() => (comments.showResolved = !comments.showResolved)}
		>{comments.showResolved
			? words.comments.hideResolved
			: words.comments.showResolved(comments.resolved.length)}</Button
	>
{/if}

<style>
	:global([data-edytor-comments-toggle]) {
		border: 0;
		border-radius: 6px;
		padding: 2px 8px;
		background: transparent;
		color: var(--muted-foreground);
		font:
			13px/1.45 ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			Helvetica,
			sans-serif;
		cursor: pointer;
	}
	:global([data-edytor-comments-toggle]:hover) {
		background: var(--accent);
	}
</style>
