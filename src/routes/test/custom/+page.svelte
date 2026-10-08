<!--
	Every chrome surface drawn by its own snippet, keeping the built-in keys
	and ARIA through the controllers' attachments (Playwright:
	`tests/editor-dom/custom-chrome.spec.ts`; the jsdom rows render the same
	fixture, `src/tests/fixtures/dom/custom-ui.test.ts`).
-->
<script lang="ts">
	import type { EdytorContext } from '$lib/components/Edytor.svelte';
	import CustomChrome from '../../../tests/dom/CustomChrome.svelte';

	let edytor = $state<EdytorContext>();
	const hooks = window as unknown as { __EDYTOR__: unknown };
	// The view, for the truth check every row ends with.
	$effect(() => void (hooks.__EDYTOR__ = edytor));
</script>

<main>
	<CustomChrome
		bind:edytor
		value={{
			children: [
				{ id: 'one', type: 'paragraph', content: [{ text: 'hello world' }] },
				{ id: 'two', type: 'paragraph', content: [{ text: 'second line' }] },
				{ id: 'three', type: 'paragraph', content: [{ text: 'third line' }] }
			]
		}}
	/>
</main>

<style>
	main {
		max-width: 720px;
		margin: 48px auto;
		padding: 0 64px;
	}
</style>
