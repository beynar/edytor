<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { BlockView } from '$lib/plugins.js';
	import { richTextLabels } from './labels.js';
	import { openBody } from './body.js';

	/**
	 * The hint an empty body shows (`body.hint`): an open toggle's (a closed
	 * `details` hides it with the body), a callout's. Chrome, never content:
	 * no text element, not editable, hidden from assistive technology (Enter
	 * at the end of the header is the keyboard's way in). A press puts the
	 * caret in the header (the core's chrome press); its click starts the body
	 * (`openBody`). A readonly view, or a suggestion's preview (no handle),
	 * shows none.
	 */
	let { block, kind }: { block: BlockView; kind: 'toggle' | 'callout' } = $props();
	const edytor = getContext<Edytor>('edytor');
	const labels = richTextLabels.of(edytor);
</script>

{#if block.handle && !edytor.readonly}
	<!-- A pointer's way into the body: the keyboard's is Enter at the end of the header. -->
	<div
		contenteditable="false"
		data-edytor-empty-body={kind}
		aria-hidden="true"
		onclick={() => block.handle && openBody(block.handle)}
	>
		{labels.emptyBody[kind]}
	</div>
{/if}
