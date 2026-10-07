<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { FindController } from './FindController.svelte.js';

	let { find, bar }: { find: FindController; bar?: Snippet<[FindController]> } = $props();

	const count = $derived(
		find.matches.length ? `${find.current + 1}/${find.matches.length}` : 'No results'
	);
</script>

{#if find.isOpen}
	<div data-edytor-find role="search" aria-label="Find in page">
		{#if bar}
			{@render bar(find)}
		{:else}
			<div data-edytor-find-row>
				<input
					data-edytor-find-query
					type="text"
					placeholder="Find in page"
					aria-label="Find"
					autocomplete="off"
					spellcheck="false"
					value={find.query}
					oninput={(event) => (find.query = event.currentTarget.value)}
					use:find.field
				/>
				<span data-edytor-find-count aria-live="polite">{find.query ? count : ''}</span>
				<button
					type="button"
					data-edytor-find-case
					aria-label="Match case"
					title="Match case"
					aria-pressed={find.caseSensitive}
					onclick={() => (find.caseSensitive = !find.caseSensitive)}>Aa</button
				>
				<button
					type="button"
					data-edytor-find-previous
					aria-label="Previous match"
					title="Previous match (Shift+Enter)"
					disabled={!find.matches.length}
					onclick={find.previous}>↑</button
				>
				<button
					type="button"
					data-edytor-find-next
					aria-label="Next match"
					title="Next match (Enter)"
					disabled={!find.matches.length}
					onclick={find.next}>↓</button
				>
				<button
					type="button"
					data-edytor-find-close
					aria-label="Close"
					title="Close (Escape)"
					onclick={() => find.close()}>✕</button
				>
			</div>
			{#if find.canReplace}
				<div data-edytor-find-row>
					<input
						data-edytor-find-replacement
						type="text"
						placeholder="Replace with"
						aria-label="Replace with"
						autocomplete="off"
						spellcheck="false"
						bind:value={find.replacement}
						use:find.replaceField
					/>
					<button
						type="button"
						data-edytor-find-replace
						disabled={!find.matches.length}
						onclick={find.replace}>Replace</button
					>
					<button
						type="button"
						data-edytor-find-replace-all
						disabled={!find.matches.length}
						onclick={find.replaceAll}>Replace all</button
					>
				</div>
			{/if}
		{/if}
	</div>
{/if}

<style>
	[data-edytor-find] {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 6px 8px;
		border-radius: 8px;
		background: var(--edytor-find-background, #fff);
		color: var(--edytor-find-color, rgb(55 53 47));
		box-shadow:
			rgb(15 15 15 / 5%) 0 0 0 1px,
			rgb(15 15 15 / 10%) 0 3px 6px,
			rgb(15 15 15 / 20%) 0 9px 24px;
		font:
			14px/1.4 ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			sans-serif;
	}
	[data-edytor-find-row] {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	input {
		width: 200px;
		min-width: 0;
		padding: 3px 6px;
		border: none;
		border-radius: 4px;
		background: rgb(242 241 238 / 60%);
		box-shadow: rgb(15 15 15 / 10%) 0 0 0 1px inset;
		color: inherit;
		font: inherit;
		outline: none;
	}
	input:focus {
		box-shadow:
			rgb(35 131 226 / 57%) 0 0 0 1px inset,
			rgb(35 131 226 / 35%) 0 0 0 2px;
	}
	[data-edytor-find-count] {
		min-width: 64px;
		color: rgb(55 53 47 / 65%);
		font-size: 12px;
		text-align: center;
		white-space: nowrap;
	}
	button {
		min-width: 24px;
		height: 24px;
		padding: 0 6px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 13px;
		cursor: pointer;
		white-space: nowrap;
	}
	button:hover:not(:disabled),
	button[aria-pressed='true'] {
		background: rgb(55 53 47 / 8%);
	}
	button[aria-pressed='true'] {
		color: rgb(35 131 226);
	}
	button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	[data-edytor-find-replace],
	[data-edytor-find-replace-all] {
		box-shadow: rgb(15 15 15 / 10%) 0 0 0 1px inset;
	}
</style>
