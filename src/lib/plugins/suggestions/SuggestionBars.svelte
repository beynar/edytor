<script lang="ts" module>
	import { mount, unmount } from 'svelte';
	import type { Plugin } from '$lib/plugins.js';
	import type { SuggestionBarOptions } from './suggestionsPlugin.js';
	import Self from './SuggestionBars.svelte';

	/**
	 * The suggestion bar (Notion AI's): your `bar` under each block
	 * suggestion (Accept, Discard, and Try again when the app passed
	 * `onRetry`) and under each shared suggestion's last block (its author,
	 * Accept and Reject for a view that decides, Withdraw for its author);
	 * its keys are the suggestions plugin's.
	 */
	export const createSuggestionBarPlugin =
		({ bar }: SuggestionBarOptions): Plugin =>
		(edytor) => ({
			onEdytorAttached: () => {
				const bars = mount(Self, { target: edytor.overlay.layer!, props: { edytor, bar } });
				return () => void unmount(bars);
			}
		});
</script>

<script lang="ts">
	import { takeKeys } from '$lib/events/onFocus.js';
	import { onMount, type Snippet } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { AnySuggestion } from '$lib/session/suggestions.svelte.js';
	import type { SuggestionBarPayload } from './suggestionsPlugin.js';

	/** The plugin's `bar` under each block suggestion's preview, placed once per frame. */
	let { edytor, bar }: { edytor: Edytor; bar: Snippet<[SuggestionBarPayload]> } = $props();

	/** Each bar's place under its preview, layer-relative, measured once per frame. */
	let places = $state<Record<string, { left: number; top: number; width: number }>>({});

	onMount(() =>
		edytor.overlay.add((origin) => {
			// No suggestion listed, no preview: nothing to find in the page (a long
			// page would be searched every frame) and nothing to place.
			if (!edytor.suggestions.list.length)
				return Object.keys(places).length ? () => (places = {}) : undefined;
			const next: typeof places = {};
			const put = (id: string, node: Element | null | undefined) => {
				const rect = node?.getBoundingClientRect();
				if (rect)
					next[id] = {
						left: rect.left - origin.left,
						top: rect.bottom - origin.top + 4,
						width: rect.width
					};
			};
			for (const node of edytor.node?.querySelectorAll<HTMLElement>('[data-edytor-suggestion]') ??
				[])
				put(node.dataset.edytorSuggestion!, node);
			// A shared one's bar: under the last block it changes.
			for (const s of shown)
				if (s.shared) put(s.id, edytor.idToBlock.get(s.changes.at(-1)?.block ?? '')?.node);
			return () => (places = next);
		})
	);
	// A suggestion added, grown or gone moves what follows it: measure again.
	$effect(() => {
		void edytor.suggestions.revision;
		edytor.overlay.invalidate();
	});

	/** Block suggestions have a preview (an `end` one, past its first block); a shared one, a change. */
	const shown = $derived(
		edytor.suggestions.list.filter((s) =>
			s.shared ? s.changes.length > 0 : !(s.at && 'end' in s.at) || s.content.length > 1
		)
	);
	const payload = (suggestion: AnySuggestion): SuggestionBarPayload => {
		const by = suggestion.shared ? suggestion.by : undefined;
		const profile = by === undefined ? undefined : edytor.document.attribution.actors.get(by);
		return {
			suggestion,
			accept: () => {
				suggestion.accept();
				takeKeys(edytor);
			},
			discard: suggestion.discard,
			reject: suggestion.shared ? suggestion.reject : suggestion.discard,
			retry: suggestion.retryable ? suggestion.retry : undefined,
			readonly: edytor.readonly,
			canDecide: suggestion.shared ? suggestion.canDecide : !edytor.readonly,
			author: by === undefined ? undefined : { id: by, ...profile },
			mac: edytor.keymap.isMac
		};
	};
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
