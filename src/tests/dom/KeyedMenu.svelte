<!--
	A `+` menu of an app's own that holds the keyboard on itself (`keys` on a
	focusable element, no field): typing edits the query
	(`plus-insert-menu.test.tsx`). `seen.controller` is the controller it drew.
-->
<script module lang="ts">
	import type { SlashMenuController } from '$lib/index.js';

	export const seen: { controller?: SlashMenuController } = {};
	export { keyedMenu };
</script>

{#snippet keyedMenu(controller: SlashMenuController)}
	<div
		data-testid="custom-menu"
		tabindex="-1"
		role="presentation"
		{@attach (node) => void (seen.controller = controller)}
		{@attach controller.keys}
	></div>
{/snippet}
