<script lang="ts">
	import { getContext } from 'svelte';
	import type { BlockView } from '$lib/plugins.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { DEFAULT_CODE_SETTINGS, codeSettings } from './languages.js';
	import { languageMenus } from './languageMenu.svelte.js';
	import { CodeHeader } from './header.svelte.js';

	/**
	 * A code block's header (`CodeHeader`): the plugin's `header` snippet, in
	 * the block's non-editable part (empty without one).
	 */
	let { block }: { block: BlockView<{ language?: string }> } = $props();

	/** The options of the view rendering it (a suggestion's preview included). */
	const edytor = getContext<Edytor>('edytor');
	const settings = codeSettings.get(edytor) ?? DEFAULT_CODE_SETTINGS;
	const header = new CodeHeader(() => block, settings, languageMenus.get(edytor));
	$effect(() => header.dispose);
</script>

<div use:block.void data-edytor-code-header>{@render settings.header?.(header)}</div>
