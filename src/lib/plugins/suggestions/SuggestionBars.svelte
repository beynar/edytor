<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { Suggestion } from '$lib/session/suggestions.svelte.js';
	import type { SuggestionBarPayload } from './suggestionsPlugin.js';
	import type { SuggestionsLabels } from '$lib/labels.js';

	/** The plugin's `bar` under each block suggestion's preview, placed once per frame. */
	let {
		edytor,
		bar,
		labels
	}: { edytor: Edytor; bar: Snippet<[SuggestionBarPayload]>; labels: SuggestionsLabels } = $props();

	/** Each bar's place under its preview, layer-relative, measured once per frame. */
	let places = $state<Record<string, { left: number; top: number; width: number }>>({});

	onMount(() =>
		edytor.overlay.add((origin) => {
			// No suggestion listed, no preview: nothing to find in the page (a long
			// page would be searched every frame) and nothing to place.
			if (!edytor.suggestions.list.length)
				return Object.keys(places).length ? () => (places = {}) : undefined;
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
		readonly: edytor.readonly,
		mac: edytor.keymap.isMac,
		labels
	});
</script>

{#each shown as suggestion (suggestion.id)}
	{@const place = places[suggestion.id]}
	<div
		data-edytor-suggestion-bar={suggestion.id}
		data-status={suggestion.status}
		contenteditable="false"
		style:left={`${place?.left ?? 0}px`}
		style:top={`${place?.top ?? 0}px`}
		style:visibility={place ? undefined : 'hidden'}
	>
		{@render bar(payload(suggestion))}
	</div>
{/each}

<style>
	[data-edytor-suggestion-bar] {
		position: absolute;
		z-index: 30;
	}
</style>
