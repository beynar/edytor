<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { BlockView } from '$lib/plugins.js';
	import { todoCheckbox } from './controls.svelte.js';

	/**
	 * A to-do's checkbox, named in the labels of the view rendering it (a
	 * suggestion's preview included): a native checkbox (the default; an
	 * app's `checkbox` snippet replaces it, `RichTextControl`).
	 */
	let { block }: { block: BlockView<{ checked?: boolean }> } = $props();
	const box = todoCheckbox(getContext<Edytor>('edytor'), () => block);
</script>

<!-- What a server render shows (a readonly view's) is written here; the attachment acts in the browser. -->
<input
	type="checkbox"
	data-edytor-todo-checkbox
	contenteditable="false"
	aria-label={box.label}
	checked={box.checked}
	{@attach box.control}
/>
