<script lang="ts">
	import EdytorComponent, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import type { Plugin } from '$lib/plugins.js';
	import type { JSONDoc } from '$lib/utils/json.js';
	import type { JSONBlock } from '$lib/utils/json.js';
	import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
	import type { Awareness, EdytorDocument, YDoc } from '$lib/crdt/index.js';
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
		onChange?: (value: JSONBlock) => void;
		onSelectionChange?: (selection: EdytorSelection) => void;
		onReady?: (edytor: EdytorContext) => void;
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
		onSelectionChange,
		onReady = () => {}
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
	{onSelectionChange}
/>
