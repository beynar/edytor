<script lang="ts">
	import EdytorComponent, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import type { Plugin } from '$lib/plugins.js';
	import type { JSONDoc } from '$lib/utils/json.js';
	import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
	import type { Awareness, DocChange, EdytorDocument, YDoc } from '$lib/crdt/index.js';
	import type { EdytorSync, PresenceOptions } from '$lib/collaboration/index.js';

	type Props = {
		value: JSONDoc;
		plugins?: Plugin[];
		readonly?: boolean;
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
		/** The view's block handles (`<Edytor blockHandles>`, on by default). */
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
	{plugins}
	defaultPlugins={false}
	{blockHandles}
	{readonly}
	{placeholder}
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
