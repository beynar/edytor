<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { BlockView } from '$lib/plugins.js';
	import { emptyBody } from './controls.svelte.js';

	/**
	 * The hint an empty body shows (`body.hint`, the default; an app's
	 * `emptyBody` snippet replaces it, `RichTextControl`): an open toggle's (a
	 * closed `details` hides it with the body), a callout's. Chrome, never
	 * content: no text element, not editable, hidden from assistive
	 * technology (Enter at the end of the header is the keyboard's way in). A
	 * press puts the caret in the header (the core's chrome press); its click
	 * starts the body (`openBody`). A readonly view, or a suggestion's
	 * preview (no handle), shows none.
	 */
	let { block, kind }: { block: BlockView; kind: 'toggle' | 'callout' } = $props();
	const view = getContext<Edytor>('edytor');
</script>

{#if block.handle && !view.readonly}
	{@const hint = emptyBody(view, block, kind)!}
	<!-- A pointer's way into the body: the keyboard's is Enter at the end of the header. -->
	<div {...hint.attributes}>{hint.label}</div>
{/if}
