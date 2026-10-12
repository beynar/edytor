<script lang="ts">
	import { words } from './words.svelte.js';
	import type { SuggestionBarPayload } from '$lib/index.js';

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
		<button type="button" data-edytor-suggestion-accept onmousedown={keep} onclick={bar.accept}
			>{labels.accept} <kbd>{bar.mac ? '⌘↵' : `${labels.ctrl}+↵`}</kbd></button
		>
	{/if}
	<button type="button" data-edytor-suggestion-discard onmousedown={keep} onclick={bar.discard}
		>{labels.discard} <kbd>{labels.escape}</kbd></button
	>
	{#if bar.retry && !bar.readonly}
		<button type="button" data-edytor-suggestion-retry onmousedown={keep} onclick={bar.retry}
			>{labels.retry}</button
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
		background: var(--edytor-suggestion-bar-background, #fff);
		box-shadow:
			0 0 0 1px rgb(15 15 15 / 0.05),
			0 3px 6px rgb(15 15 15 / 0.1),
			0 9px 24px rgb(15 15 15 / 0.2);
		font-size: 13px;
		line-height: 1.2;
		white-space: nowrap;
		user-select: none;
	}
	[data-edytor-suggestion-label] {
		padding: 0 6px;
		color: var(--edytor-suggestion-accent, #2383e2);
		font-weight: 500;
	}
	button {
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
	button:hover {
		background: rgb(55 53 47 / 0.08);
	}
	kbd {
		color: rgb(55 53 47 / 0.5);
		font: inherit;
		font-size: 11px;
	}
</style>
