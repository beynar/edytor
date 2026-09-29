<script lang="ts">
	// Two sibling views on one injected document, mounted in ONE flush: one
	// carries the provider (`sync`), the other does not (arch-v2 T3).
	import EdytorComponent, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import type { Plugin } from '$lib/plugins.js';
	import type { JSONDoc } from '$lib/utils/json.js';
	import type { EdytorDocument } from '$lib/crdt/index.js';
	import type { EdytorSync } from '$lib/collaboration/index.js';

	type Props = {
		value: JSONDoc;
		plugins?: Plugin[];
		document: EdytorDocument;
		sync: EdytorSync;
		syncFirst: boolean;
		views: { carrier?: EdytorContext; sibling?: EdytorContext };
	};

	let { value, plugins, document, sync, syncFirst, views }: Props = $props();
	let carrier = $state<EdytorContext>();
	let sibling = $state<EdytorContext>();
	$effect(() => {
		views.carrier = carrier;
		views.sibling = sibling;
	});
</script>

{#if syncFirst}
	<EdytorComponent
		bind:edytor={carrier}
		{value}
		{plugins}
		defaultPlugins={false}
		{document}
		{sync}
	/>
	<EdytorComponent bind:edytor={sibling} {value} {plugins} defaultPlugins={false} {document} />
{:else}
	<EdytorComponent bind:edytor={sibling} {value} {plugins} defaultPlugins={false} {document} />
	<EdytorComponent
		bind:edytor={carrier}
		{value}
		{plugins}
		defaultPlugins={false}
		{document}
		{sync}
	/>
{/if}
