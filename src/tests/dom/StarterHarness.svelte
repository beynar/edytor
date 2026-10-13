<script lang="ts">
	// The starter editor with its view handed to the row (`bind:edytor`).
	import { StarterEditor, type StarterEditorProps } from '$registry/edytor/starter/index.js';
	import type { EdytorInstance } from '$lib/index.js';

	let { onedytor, ...props }: StarterEditorProps & { onedytor?: (edytor: EdytorInstance) => void } =
		$props();
	let edytor = $state<EdytorInstance>();
	$effect(() => {
		if (edytor) onedytor?.(edytor);
	});
</script>

<StarterEditor {...props} bind:edytor />
