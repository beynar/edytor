<script lang="ts" generics="T">
	import { getContext, type Snippet } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';

	/**
	 * A control inside a block: the app's snippet for it in the view
	 * rendering it (`own`; a suggestion's preview's too), else the package's
	 * markup (`initial`), with the control's `payload`.
	 */
	let {
		own,
		initial,
		payload
	}: {
		own: (view: Edytor | undefined) => Snippet<[T]> | undefined;
		initial: Snippet<[T]>;
		payload: T;
	} = $props();
	const view = getContext<Edytor | undefined>('edytor');
	const snippet = $derived(own(view) ?? initial);
</script>

{@render snippet(payload)}
