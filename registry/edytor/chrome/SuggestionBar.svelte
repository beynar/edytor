<script lang="ts">
	import { Button } from '$registry/ui/button/index.js';
	import { words } from './words.svelte.js';
	import type { SuggestionBarPayload } from 'edytor';

	/**
	 * Notion AI's bar under a block suggestion, drawn for
	 * `createSuggestionsPlugin({ bar })`: its label, Accept, Discard, and Try
	 * again when the app passed `onRetry`.
	 */
	let { bar }: { bar: SuggestionBarPayload } = $props();
	const { suggestion } = $derived(bar);
	const labels = $derived(words.suggestions);
	const keep = (event: MouseEvent) => event.preventDefault();
</script>

<div data-suggestion-bar>
	<span data-edytor-suggestion-label
		>{suggestion.status === 'streaming'
			? labels.writing(suggestion.label)
			: (suggestion.label ?? labels.suggestion)}</span
	>
	{#if !bar.readonly}
		<Button variant="ghost" data-edytor-suggestion-accept onmousedown={keep} onclick={bar.accept}
			>{labels.accept} <kbd>{bar.mac ? '⌘↵' : `${labels.ctrl}+↵`}</kbd></Button
		>
	{/if}
	<Button variant="ghost" data-edytor-suggestion-discard onmousedown={keep} onclick={bar.discard}
		>{labels.discard} <kbd>{labels.escape}</kbd></Button
	>
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
		color: var(--edytor-suggestion-accent, var(--primary));
		font-weight: 500;
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
