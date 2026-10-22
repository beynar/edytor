<script lang="ts">
	// The public `<Edytor>`, each view it builds handed to `onView` (a re-seed builds another).
	import Edytor from '$lib/components/EdytorRoot.svelte';
	import type { EdytorContext, EdytorProps } from '$lib/components/Edytor.svelte';

	let { onView, ...props }: EdytorProps & { onView: (view: EdytorContext) => void } = $props();
	let edytor = $state<EdytorContext>();
	$effect(() => {
		if (edytor) onView(edytor);
	});
</script>

<Edytor {...props} bind:edytor />
