<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';

	/**
	 * A chrome surface the app draws (`mountChrome`): its snippet with the
	 * controller's payload while `shown` holds; a view turning readonly
	 * closes it (`close`), as its actions would be refused.
	 */
	let {
		edytor,
		snippet,
		payload,
		shown,
		close
	}: {
		edytor: Edytor;
		snippet: Snippet<[T]>;
		payload: T;
		shown: () => unknown;
		close?: () => void;
	} = $props();

	$effect(() => {
		if (close && shown() && edytor.readonly) close();
	});
</script>

{#if shown()}{@render snippet(payload)}{/if}
