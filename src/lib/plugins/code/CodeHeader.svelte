<script lang="ts">
	import { getContext } from 'svelte';
	import type { BlockView } from '$lib/plugins.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { Text } from '$lib/text/text.svelte.js';
	import { DEFAULT_CODE_SETTINGS, codeSettings, languageLabel, languageOf } from './languages.js';
	import { languageMenus } from './languageMenu.svelte.js';

	let { block }: { block: BlockView<{ language?: string }> } = $props();

	/** The options of the view rendering it (a suggestion's preview included). */
	const edytor = getContext<Edytor>('edytor');
	const settings = codeSettings.get(edytor) ?? DEFAULT_CODE_SETTINGS;
	const menu = languageMenus.get(edytor);
	const { languages, labels } = settings;
	/** The block's language id: its `data.language`, else the plugin's default. */
	const language = $derived(languageOf(block.data, settings));

	/** The language's label; a language the plugin does not list shows its id. */
	const label = $derived.by(() => {
		const row = languages.find((row) => row.id === language);
		return row ? languageLabel(row, settings) : language;
	});
	/** A suggestion's preview (no handle) and a readonly view show the label only. */
	const editable = $derived(Boolean(menu && block.handle && !block.handle.edytor.readonly));
	const expanded = $derived(Boolean(block.handle && menu?.isOpenFor(block.handle.id)));

	const getCodeText = (code: Block) =>
		code.children
			.map((line) =>
				line.content.map((part) => (part instanceof Text ? part.stringContent : '')).join('')
			)
			.join('\n');

	/** The button's keys (its own: the editor never sees them): an arrow opens the list, Escape gives the keys back. */
	const keydown = (event: KeyboardEvent) => {
		if (!block.handle || !menu) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (!expanded) menu.toggle(block.handle.id, true);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			menu.release();
		}
	};
</script>

<div use:block.void data-edytor-code-header>
	{#if editable}
		<!-- The language list (`LanguageMenu`): one key patched (`patchData`, one undo step). -->
		<button
			type="button"
			data-edytor-code-language
			aria-label="{labels.language}: {label}"
			aria-haspopup="listbox"
			aria-expanded={expanded}
			aria-controls={expanded ? menu?.listId : undefined}
			onmousedown={(event) => event.preventDefault()}
			onclick={(event) => {
				// A click from Enter or Space has no pointer (`detail` 0): the keys opened it.
				if (block.handle) menu?.toggle(block.handle.id, event.detail === 0);
			}}
			onkeydown={keydown}
			>{label}<svg aria-hidden="true" viewBox="0 0 10 10" width="10" height="10"
				><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" /></svg
			></button
		>
	{:else}
		<span data-edytor-code-language>{label}</span>
	{/if}
	<button
		type="button"
		data-edytor-code-copy
		onmousedown={(e) => e.preventDefault()}
		onclick={async (e) => {
			e.preventDefault();
			e.stopPropagation();
			const button = e.currentTarget;
			// A suggestion's preview has no block to copy.
			if (!block.handle) return;
			await navigator.clipboard.writeText(getCodeText(block.handle));
			button.textContent = labels.copied;
			setTimeout(() => (button.textContent = labels.copy), 1200);
		}}>{labels.copy}</button
	>
</div>
