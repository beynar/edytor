<script lang="ts">
	import EdytorComponent, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import type { Plugin } from '$lib/plugins.js';
	import type { JSONDoc } from '$lib/utils/json.js';
	import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
	import type { Awareness, DocChange, EdytorDocument, YDoc } from '$lib/crdt/index.js';
	import type { EdytorSync, PresenceOptions } from '$lib/collaboration/index.js';
	import { blockHandlesPlugin, handlePlugins } from '$registry/edytor/chrome/plugins.js';

	type Props = {
		value: JSONDoc;
		plugins?: Plugin[];
		readonly?: boolean;
		allowNesting?: boolean;
		placeholder?: string;
		translate?: 'yes' | 'no';
		spellcheck?: boolean;
		autocorrect?: 'on' | 'off';
		autocomplete?: 'on' | 'off';
		autocapitalize?: 'off' | 'none' | 'on' | 'sentences' | 'words' | 'characters';
		inputmode?: 'none' | 'text' | 'decimal' | 'numeric' | 'tel' | 'search' | 'email' | 'url';
		enterkeyhint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send';
		document?: EdytorDocument;
		doc?: YDoc;
		awareness?: Awareness;
		sync?: EdytorSync;
		presence?: PresenceOptions;
		onChange?: (value: JSONDoc) => void;
		onDocChange?: (change: DocChange) => void;
		onSelectionChange?: (selection: EdytorSelection) => void;
		onReady?: (edytor: EdytorContext) => void;
		/**
		 * The demo chrome's block handles, on by default (`false`: none); a
		 * handles plugin listed in `plugins` stands for them.
		 */
		blockHandles?: boolean;
		/** The root textbox's name and id (`aria-label`, `aria-labelledby`, `aria-describedby`, `id`). */
		label?: {
			'aria-label'?: string;
			'aria-labelledby'?: string;
			'aria-describedby'?: string;
			id?: string;
		};
	};

	let {
		value,
		plugins,
		readonly = false,
		allowNesting,
		placeholder,
		translate = 'no',
		spellcheck,
		autocorrect,
		autocomplete,
		autocapitalize,
		inputmode,
		enterkeyhint,
		document: edytorDocument,
		doc,
		awareness,
		sync,
		presence,
		onChange,
		onDocChange,
		onSelectionChange,
		onReady = () => {},
		blockHandles,
		label
	}: Props = $props();

	let edytor = $state<EdytorContext>();

	$effect(() => {
		if (edytor) {
			onReady(edytor);
		}
	});
</script>

<EdytorComponent
	bind:edytor
	{value}
	plugins={[
		// The placeholder is a plugin's (the first listed wins).
		...(placeholder ? [() => ({ placeholder })] : []),
		...((blockHandles === false
			? plugins?.filter((plugin) => !handlePlugins.has(plugin))
			: plugins?.some((plugin) => handlePlugins.has(plugin))
				? plugins
				: [blockHandlesPlugin, ...(plugins ?? [])]) ?? [])
	]}
	defaultPlugins={false}
	{readonly}
	{allowNesting}
	{translate}
	{spellcheck}
	{autocorrect}
	{autocomplete}
	{autocapitalize}
	{inputmode}
	{enterkeyhint}
	document={edytorDocument}
	{doc}
	{awareness}
	{sync}
	{presence}
	{onChange}
	{onDocChange}
	{onSelectionChange}
	{...label}
/>
