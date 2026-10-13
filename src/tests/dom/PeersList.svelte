<script lang="ts">
	import type { Edytor } from '$lib/edytor.svelte.js';

	let { edytor }: { edytor: Edytor } = $props();
</script>

<ul>
	{#each edytor.presence.peers as person (person.clientId)}
		<li data-client={person.clientId} style:color={person.color}>{person.name ?? 'Anonymous'}</li>
	{/each}
</ul>
