<script lang="ts">
	import { Button } from '$registry/ui/button/index.js';
	import { words } from './words.svelte.js';
	import type { SuggestionBarPayload } from 'edytor';

	/**
	 * Notion AI's bar under a block suggestion, drawn for
	 * `createSuggestionBarPlugin({ bar })`: its label, Accept, Discard, and Try
	 * again when the app passed `onRetry`. Under a shared suggestion: its
	 * author ("Ada (AI)"), Accept and Reject for a view that may decide,
	 * Withdraw for its author, and "Suggested" for a view that only reads.
	 */
	let { bar }: { bar: SuggestionBarPayload } = $props();
	const { suggestion, author } = $derived(bar);
	const labels = $derived(words.suggestions);
	const keep = (event: MouseEvent) => event.preventDefault();
	const name = $derived(author && labels.author(author.name ?? author.id, suggestion.via));
</script>

<div data-suggestion-bar>
	<span data-edytor-suggestion-label style:--edytor-range-color={author?.color}
		>{suggestion.status === 'streaming'
			? labels.writing(suggestion.label)
			: suggestion.shared
				? name
				: (suggestion.label ?? labels.suggestion)}</span
	>
	{#if bar.canDecide}
		<Button variant="ghost" data-edytor-suggestion-accept onmousedown={keep} onclick={bar.accept}
			>{labels.accept}
			{#if !suggestion.shared}<kbd>{bar.mac ? '⌘↵' : `${labels.ctrl}+↵`}</kbd>{/if}</Button
		>
	{/if}
	{#if suggestion.shared && bar.canDecide && !suggestion.mine}
		<Button variant="ghost" data-edytor-suggestion-reject onmousedown={keep} onclick={bar.reject}
			>{labels.reject}</Button
		>
	{:else if !suggestion.shared || !bar.readonly}
		<Button variant="ghost" data-edytor-suggestion-discard onmousedown={keep} onclick={bar.discard}
			>{suggestion.shared ? labels.withdraw : labels.discard}
			{#if !suggestion.shared}<kbd>{labels.escape}</kbd>{/if}</Button
		>
	{:else}
		<span data-edytor-suggestion-pending>{labels.pending}</span>
	{/if}
	{#if bar.retry && !bar.readonly}
		<Button variant="ghost" data-edytor-suggestion-retry onmousedown={keep} onclick={bar.retry}
			>{labels.retry}</Button
		>
	{/if}
</div>

<style>
	[data-suggestion-bar] {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px;
		border-radius: 8px;
		background: var(--edytor-suggestion-bar-background, var(--popover));
		box-shadow:
			0 0 0 1px var(--accent),
			0 3px 6px var(--border),
			0 9px 24px var(--border);
		font-size: 13px;
		line-height: 1.2;
		white-space: nowrap;
		user-select: none;
	}
	[data-edytor-suggestion-label] {
		padding: 0 6px;
		color: var(--edytor-range-color, var(--edytor-suggestion-accent, var(--primary)));
		font-weight: 500;
	}
	[data-edytor-suggestion-pending] {
		padding: 0 6px;
		color: var(--muted-foreground);
	}
	[data-suggestion-bar] :global(button) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 26px;
		padding: 0 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	[data-suggestion-bar] :global(button:hover) {
		background: var(--accent);
	}
	kbd {
		color: var(--muted-foreground);
		font: inherit;
		font-size: 11px;
	}
</style>
