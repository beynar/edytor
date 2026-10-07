<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { Suggestion } from '$lib/session/suggestions.svelte.js';
	import type { SuggestionBarPayload } from './suggestionsPlugin.js';

	let { edytor, bar }: { edytor: Edytor; bar?: Snippet<[SuggestionBarPayload]> } = $props();

	/** Each bar's place under its preview, layer-relative, measured once per frame (R11). */
	let places = $state<Record<string, { left: number; top: number; width: number }>>({});

	onMount(() =>
		edytor.overlay.add((origin) => {
			const next: typeof places = {};
			for (const node of edytor.node?.querySelectorAll<HTMLElement>('[data-edytor-suggestion]') ??
				[]) {
				const rect = node.getBoundingClientRect();
				next[node.dataset.edytorSuggestion!] = {
					left: rect.left - origin.left,
					top: rect.bottom - origin.top + 4,
					width: rect.width
				};
			}
			return () => (places = next);
		})
	);
	// A suggestion added, grown or gone moves what follows it: measure again.
	$effect(() => {
		void edytor.suggestions.revision;
		edytor.overlay.invalidate();
	});

	/** Block suggestions have a preview (an `end` one, past its first block). */
	const shown = $derived(
		edytor.suggestions.list.filter((s) => !('end' in s.at) || s.content.length > 1)
	);
	const payload = (suggestion: Suggestion): SuggestionBarPayload => ({
		suggestion,
		accept: () => {
			suggestion.accept();
			edytor.expectInternalFocus();
			edytor.node?.focus({ preventScroll: true });
		},
		discard: suggestion.discard,
		retry: suggestion.retryable ? suggestion.retry : undefined,
		readonly: edytor.readonly
	});
	const keep = (event: MouseEvent) => event.preventDefault();
</script>

{#each shown as suggestion (suggestion.id)}
	{@const place = places[suggestion.id]}
	{@const actions = payload(suggestion)}
	<div
		data-edytor-suggestion-bar={suggestion.id}
		data-status={suggestion.status}
		contenteditable="false"
		style:left={`${place?.left ?? 0}px`}
		style:top={`${place?.top ?? 0}px`}
		style:visibility={place ? undefined : 'hidden'}
	>
		{#if bar}
			{@render bar(actions)}
		{:else}
			<span data-edytor-suggestion-label
				>{suggestion.status === 'streaming'
					? `${suggestion.label ?? 'AI'} is writing…`
					: (suggestion.label ?? 'Suggestion')}</span
			>
			{#if !actions.readonly}
				<button
					type="button"
					data-edytor-suggestion-accept
					onmousedown={keep}
					onclick={actions.accept}>Accept <kbd>{edytor.keymap.isMac ? '⌘↵' : 'Ctrl+↵'}</kbd></button
				>
			{/if}
			<button
				type="button"
				data-edytor-suggestion-discard
				onmousedown={keep}
				onclick={actions.discard}>Discard <kbd>Esc</kbd></button
			>
			{#if actions.retry && !actions.readonly}
				<button
					type="button"
					data-edytor-suggestion-retry
					onmousedown={keep}
					onclick={actions.retry}>Try again</button
				>
			{/if}
		{/if}
	</div>
{/each}

<style>
	[data-edytor-suggestion-bar] {
		position: absolute;
		z-index: 30;
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
	[data-edytor-suggestion-bar] button {
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
	[data-edytor-suggestion-bar] button:hover {
		background: rgb(55 53 47 / 0.08);
	}
	[data-edytor-suggestion-bar] kbd {
		color: rgb(55 53 47 / 0.5);
		font: inherit;
		font-size: 11px;
	}
</style>
