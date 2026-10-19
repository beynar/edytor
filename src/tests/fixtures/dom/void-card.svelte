<script module lang="ts">
	import type { BlockSnippetPayload } from '$lib/plugins.js';

	export { card };
</script>

<!-- A void kind with controls inside (`sel.press.void`): the rows of `selectstart-guard.test.tsx`. -->
{#snippet card({ block, content }: BlockSnippetPayload)}
	<div use:block.void data-card>
		<button type="button">Button</button>
		<input type="text" />
		<div role="button">Role</div>
		<div data-edytor-control>Marked</div>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div tabindex="0">Focusable</div>
		<div data-card-empty>Empty area</div>
	</div>
	<div>{@render content()}</div>
{/snippet}
