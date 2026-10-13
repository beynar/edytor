<script lang="ts">
	import { Button } from '$registry/ui/button/index.js';
	import { Input } from '$registry/ui/input/index.js';
	import { words } from './words.svelte.js';
	import type { FindController } from 'edytor';

	/** Notion's find bar, drawn for `createFindPlugin({ bar })`: the query, the count, the steps, Replace. */
	let { find }: { find: FindController } = $props();

	const labels = $derived(words.find);
	const count = $derived(
		find.matches.length ? labels.count(find.current + 1, find.matches.length) : labels.noResults
	);

	/** A button of the bar: `data-edytor-find-<name>`, its name and hint, its text, its action. */
	type Control = {
		name: string;
		label?: string;
		hint?: string;
		text: string;
		run: () => unknown;
		pressed?: boolean;
		disabled?: boolean;
	};
	const none = $derived(!find.matches.length);
	const searching: Control[] = $derived([
		{
			name: 'case',
			label: labels.matchCase,
			hint: labels.matchCase,
			text: 'Aa',
			run: () => (find.caseSensitive = !find.caseSensitive),
			pressed: find.caseSensitive
		},
		{
			name: 'previous',
			label: labels.previous,
			hint: labels.previousHint,
			text: '↑',
			run: find.previous,
			disabled: none
		},
		{
			name: 'next',
			label: labels.next,
			hint: labels.nextHint,
			text: '↓',
			run: find.next,
			disabled: none
		},
		{
			name: 'close',
			label: labels.close,
			hint: labels.closeHint,
			text: '✕',
			run: () => find.close()
		}
	]);
	const replacing: Control[] = $derived([
		{ name: 'replace', text: labels.replace, run: find.replace, disabled: none },
		{ name: 'replace-all', text: labels.replaceAll, run: find.replaceAll, disabled: none }
	]);
</script>

{#snippet buttons(list: Control[])}
	{#each list as button (button.name)}
		<Button
			variant="ghost"
			{...{ [`data-edytor-find-${button.name}`]: '' }}
			aria-label={button.label}
			title={button.hint}
			aria-pressed={button.pressed}
			disabled={button.disabled}
			onclick={() => button.run()}>{button.text}</Button
		>
	{/each}
{/snippet}

<div data-edytor-find role="search" aria-label={labels.bar}>
	<div data-edytor-find-row>
		<Input
			data-edytor-find-query
			type="text"
			placeholder={labels.queryPlaceholder}
			aria-label={labels.query}
			autocomplete="off"
			spellcheck="false"
			value={find.query}
			oninput={(event) => (find.query = event.currentTarget.value)}
			{@attach find.field}
		/>
		<span data-edytor-find-count aria-live="polite">{find.query ? count : ''}</span>
		{@render buttons(searching)}
	</div>
	{#if find.canReplace}
		<div data-edytor-find-row>
			<Input
				data-edytor-find-replacement
				type="text"
				placeholder={labels.replaceWith}
				aria-label={labels.replaceWith}
				autocomplete="off"
				spellcheck="false"
				bind:value={find.replacement}
				{@attach find.replaceField}
			/>
			{@render buttons(replacing)}
		</div>
	{/if}
</div>

<style>
	[data-edytor-find] {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 6px 8px;
		border-radius: 8px;
		background: var(--edytor-find-background, var(--popover));
		color: var(--edytor-find-color, var(--popover-foreground));
		box-shadow:
			var(--accent) 0 0 0 1px,
			var(--border) 0 3px 6px,
			var(--border) 0 9px 24px;
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
	[data-edytor-find] :global(input) {
		width: 200px;
		min-width: 0;
		padding: 3px 6px;
		border: none;
		border-radius: 4px;
		background: var(--muted);
		box-shadow: var(--border) 0 0 0 1px inset;
		color: inherit;
		font: inherit;
		outline: none;
	}
	[data-edytor-find] :global(input:focus) {
		box-shadow:
			color-mix(in oklab, var(--ring) 57%, transparent) 0 0 0 1px inset,
			color-mix(in oklab, var(--ring) 35%, transparent) 0 0 0 2px;
	}
	[data-edytor-find-count] {
		min-width: 64px;
		color: var(--muted-foreground);
		font-size: 12px;
		text-align: center;
		white-space: nowrap;
	}
	[data-edytor-find] :global(button) {
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
	[data-edytor-find] :global(button:hover:not(:disabled)),
	[data-edytor-find] :global(button[aria-pressed='true']) {
		background: var(--accent);
	}
	[data-edytor-find] :global(button[aria-pressed='true']) {
		color: var(--primary);
	}
	[data-edytor-find] :global(button:disabled) {
		opacity: 0.4;
		cursor: default;
	}
	[data-edytor-find] :global([data-edytor-find-replace]),
	[data-edytor-find] :global([data-edytor-find-replace-all]) {
		box-shadow: var(--border) 0 0 0 1px inset;
	}
</style>
