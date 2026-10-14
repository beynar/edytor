<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';

	/**
	 * An anchored panel's place in the overlay (`Anchored`: the code language
	 * list, the callout icon picker, the equation editor): the app's `snippet`
	 * with `payload`, absolutely placed where `place` says (centered on it with
	 * `center`), marked by `attributes`. It renders while `shown` holds (by
	 * default, once placed); shown before its first placement it is
	 * transparent, never `display: none` (it may take the focus as it mounts).
	 */
	let {
		snippet,
		payload,
		place,
		shown = () => Boolean(place()),
		attributes,
		center = () => false
	}: {
		snippet: Snippet<[T]>;
		payload: T;
		place: () => { left: number; top: number } | null | false | undefined;
		shown?: () => boolean;
		attributes: () => Record<string, string>;
		center?: () => boolean;
	} = $props();

	const at = $derived(place());
</script>

{#if shown()}
	<div
		{...attributes()}
		style:position="absolute"
		style:left="{at ? at.left : 0}px"
		style:top="{at ? at.top : 0}px"
		style:opacity={at ? undefined : 0}
		style:transform={center() ? 'translateX(-50%)' : undefined}
	>
		{@render snippet(payload)}
	</div>
{/if}
