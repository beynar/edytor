<script lang="ts">
	import { words } from './words.svelte.js';
	import type { CodeHeader } from '$lib/index.js';

	/**
	 * Notion's code header, drawn for `createCodePlugin({ header })`: the
	 * language's button (or its label where it cannot change) and Copy.
	 */
	let { header }: { header: CodeHeader } = $props();
	const labels = $derived(words.code);
</script>

{#if header.editable}
	<!-- The language list (`LanguageMenu`): one key patched (`patchData`, one undo step). -->
	<button
		type="button"
		data-edytor-code-language
		aria-label="{labels.language}: {header.label}"
		{@attach header.button}
		>{header.label}<svg aria-hidden="true" viewBox="0 0 10 10" width="10" height="10"
			><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" /></svg
		></button
	>
{:else}
	<span data-edytor-code-language>{header.label}</span>
{/if}
<button
	type="button"
	data-edytor-code-copy
	onmousedown={(e) => e.preventDefault()}
	onclick={(e) => {
		e.preventDefault();
		e.stopPropagation();
		void header.copy();
	}}>{header.copied ? labels.copied : labels.copy}</button
>

<style>
	/*
	 * The header's colors are custom properties a theme may set:
	 * `--edytor-code-chrome-color` (the language and Copy),
	 * `--edytor-code-chrome-hover` (their background under the pointer),
	 * `--edytor-code-accent` (their focus ring).
	 */
	button,
	span {
		font-size: 12px;
		line-height: 20px;
		color: var(--edytor-code-chrome-color, #726f6a);
	}
	/* The language: a button with its chevron, which opens the language list. */
	button[data-edytor-code-language] {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin: 0;
		padding: 0 4px 0 6px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		font-family: inherit;
		cursor: pointer;
	}
	button[data-edytor-code-language] svg {
		opacity: 0.7;
	}
	button[data-edytor-code-language]:hover,
	button[data-edytor-code-language]:global([aria-expanded='true']) {
		background: var(--edytor-code-chrome-hover, rgba(33, 27, 23, 0.06));
	}
	button:focus-visible {
		outline: 2px solid var(--edytor-code-accent, #2383e2);
		outline-offset: 1px;
	}
	span[data-edytor-code-language] {
		padding: 0 6px;
	}
	[data-edytor-code-copy] {
		padding: 0 6px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		font-family: inherit;
		cursor: pointer;
		opacity: 0;
		transition: opacity 150ms ease;
	}
	:global([data-edytor-type='code']:hover) [data-edytor-code-copy],
	[data-edytor-code-copy]:focus-visible {
		opacity: 1;
	}
	[data-edytor-code-copy]:hover {
		background: var(--edytor-code-chrome-hover, rgba(33, 27, 23, 0.06));
	}
</style>
