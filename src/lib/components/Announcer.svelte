<script lang="ts">
	import type { Announcer } from '$lib/session/announcer.svelte.js';

	/**
	 * The view's polite live region (`session/announcer`), beside the host in
	 * the overlay: visually hidden, each announcement a new node so the same
	 * words twice are read twice.
	 */
	let { announcer }: { announcer: Announcer } = $props();
</script>

<div data-edytor-live role="status" aria-live="polite" aria-atomic="true" class="edytor-live">
	{#key announcer.serial}{#if announcer.message}<span>{announcer.message}</span>{/if}{/key}
</div>

<style>
	.edytor-live {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}
</style>
