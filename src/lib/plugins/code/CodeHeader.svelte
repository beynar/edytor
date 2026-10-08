<script lang="ts">
	import { getContext } from 'svelte';
	import type { BlockView } from '$lib/plugins.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { Text } from '$lib/text/text.svelte.js';
	import { DEFAULT_CODE_SETTINGS, codeSettings, languageLabel, languageOf } from './languages.js';

	let { block }: { block: BlockView<{ language?: string }> } = $props();

	/** The options of the view rendering it (a suggestion's preview included). */
	const settings = codeSettings.get(getContext<Edytor>('edytor')) ?? DEFAULT_CODE_SETTINGS;
	const { languages, labels } = settings;
	/** The block's language id: its `data.language`, else the plugin's default. */
	const language = $derived(languageOf(block.data, settings));

	/** The language's label; a language the plugin does not list shows its id. */
	const label = $derived.by(() => {
		const row = languages.find((row) => row.id === language);
		return row ? languageLabel(row, settings) : language;
	});
	/** A suggestion's preview (no handle) and a readonly view show the label only. */
	const editable = $derived(Boolean(block.handle && !block.handle.edytor.readonly));

	const getCodeText = (code: Block) =>
		code.children
			.map((line) =>
				line.content.map((part) => (part instanceof Text ? part.stringContent : '')).join('')
			)
			.join('\n');
</script>

<div use:block.void data-edytor-code-header>
	{#if editable}
		<!-- One key patched (`patchData`, one undo step); a peer's other keys are kept. -->
		<select
			data-edytor-code-language
			aria-label={labels.language}
			value={language}
			onchange={(event) => {
				if (block.handle) block.handle.data.language = event.currentTarget.value;
			}}
		>
			{#if !languages.some((row) => row.id === language)}
				<option value={language}>{label}</option>
			{/if}
			{#each languages as row (row.id)}
				<option value={row.id}>{languageLabel(row, settings)}</option>
			{/each}
		</select>
	{:else}
		<span data-edytor-code-language>{label}</span>
	{/if}
	<button
		type="button"
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
