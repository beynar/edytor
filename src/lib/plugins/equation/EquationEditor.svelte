<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { EquationEditor } from './equation.svelte.js';

	/**
	 * The equation editor (`EquationEditor`), in the overlay under the edited
	 * equation (Notion's), centered under a block one: the plugin's `panel`
	 * snippet, placed. It takes the field's focus and keys through the
	 * controller's attachment (`field`).
	 */
	let { editor, panel }: { editor: EquationEditor; panel: Snippet<[EquationEditor]> } = $props();

	const place = $derived(editor.place);
</script>

{#if place}
	<div
		data-edytor-equation-panel
		data-display={editor.display ? 'block' : 'inline'}
		style:position="absolute"
		style:left="{place.left}px"
		style:top="{place.top}px"
		style:transform={editor.display ? 'translateX(-50%)' : undefined}
	>
		{@render panel(editor)}
	</div>
{/if}
