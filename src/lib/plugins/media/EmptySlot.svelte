<script lang="ts" module>
	import type { Component, Snippet } from 'svelte';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { MediaKind } from './media.js';
	import type { EmptyView, MediaEmptyController } from './empty.svelte.js';

	/** What an empty image or media block renders in its view: the media empty plugin's host and snippet. */
	type EmptyHost = {
		Host: Component<{
			block: Block | undefined;
			kind: MediaKind | 'image';
			viewOf: (edytor: Edytor | undefined) => EmptyView | undefined;
			empty: Snippet<[MediaEmptyController]>;
		}>;
		empty: Snippet<[MediaEmptyController]>;
	};

	/** Each view's empty-block chrome (the first media empty plugin listed claims it). */
	export const emptyHosts = new WeakMap<object, EmptyHost>();
</script>

<script lang="ts">
	import { getContext, untrack } from 'svelte';

	/**
	 * Where an empty image or media block shows its empty state: the view's
	 * media empty plugin's host, when one is listed (else nothing). The view
	 * rendering it is the block's, or a suggestion preview's.
	 */
	let {
		block,
		kind,
		viewOf
	}: {
		block: Block | undefined;
		kind: MediaKind | 'image';
		viewOf: (edytor: Edytor | undefined) => EmptyView | undefined;
	} = $props();
	const view = getContext<Edytor>('edytor');
	const host = untrack(() => emptyHosts.get(block?.edytor ?? view));
</script>

{#if host}<host.Host {block} {kind} {viewOf} empty={host.empty} />{/if}
