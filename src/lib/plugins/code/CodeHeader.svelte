<script lang="ts">
	import { getContext } from 'svelte';
	import type { BlockView } from '$lib/plugins.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { DEFAULT_CODE_SETTINGS, codeSettings } from './languages.js';
	import { languageMenus } from './languageMenu.svelte.js';
	import { CodeHeader } from './header.svelte.js';

	/**
	 * A code block's header (`CodeHeader`): the plugin's `header` snippet, else
	 * the language's button (or its label where it cannot change) and Copy.
	 * Both open the language list through the controller's `button`
	 * attachment.
	 */
	let { block }: { block: BlockView<{ language?: string }> } = $props();

	/** The options of the view rendering it (a suggestion's preview included). */
	const edytor = getContext<Edytor>('edytor');
	const settings = codeSettings.get(edytor) ?? DEFAULT_CODE_SETTINGS;
	const header = new CodeHeader(() => block, settings, languageMenus.get(edytor));
	const labels = settings.labels;
	$effect(() => header.dispose);
</script>

<div use:block.void data-edytor-code-header>
	{#if settings.header}
		{@render settings.header(header)}
	{:else}
		{#if header.editable}
			<!-- The language list (`LanguageMenu`): one key patched (`patchData`, one undo step). -->
			<button
				type="button"
				data-edytor-code-language
				aria-label="{labels.language}: {header.label}"
				{@attach header.button}
				>{header.label}<svg aria-hidden="true" viewBox="0 0 10 10" width="10" height="10"
					><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" /></svg
				></button
			>
		{:else}
			<span data-edytor-code-language>{header.label}</span>
		{/if}
		<button
			type="button"
			data-edytor-code-copy
			onmousedown={(e) => e.preventDefault()}
			onclick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				void header.copy();
			}}>{header.copied ? labels.copied : labels.copy}</button
		>
	{/if}
</div>
