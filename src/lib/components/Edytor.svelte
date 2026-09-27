<script lang="ts" module>
	// `EdytorClass` alias: the emitted `.svelte.d.ts` also declares `Edytor`
	// (the component + its bindable instance type) — an unaliased import
	// collides there (TS2440 for bundler-resolution consumers).
	import { Edytor as EdytorClass, useEdytor, type Snippets } from '../edytor.svelte.js';
	import type { Awareness, EdytorDocument, YDoc } from '../crdt/index.js';
	import type { EdytorSync } from '$lib/collaboration/index.js';
	export { EdytorClass as EdytorContext, useEdytor };
	import type { Placeholder, Plugin } from '$lib/plugins.js';
	import {
		blockHandlesPlugin,
		createBlockHandlesPlugin,
		isBlockHandlesPlugin,
		type BlockHandlesOptions
	} from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
	const defaultValue: JSONDoc = {
		// Empty document — the facade seeds the canonical bootstrap block of
		// the document's `defaultType` on `sync()` (D1). No block types are
		// named here, so mounting with a plugin set that lacks the optional
		// `mention`/`code`/`codeLine` definitions can't crash.
		children: []
	};

	export type EdytorProps = Snippets & {
		plugins?: Plugin[];
		/** Show built-in block handles, with optional pointer dragging and activation callback. */
		blockHandles?: boolean | BlockHandlesOptions;
		/** @deprecated Use `blockHandles`; `false` also hides the built-in handles. */
		blockDnd?: boolean;
		class?: string;
		edytor?: EdytorClass;
		/** The assembled document this view renders (see `crdt/document.ts`). */
		document?: EdytorDocument;
		doc?: YDoc;
		awareness?: Awareness;
		readonly?: boolean;
		hotKeys?: Record<string, HotKey>;
		onChange?: (value: JSONBlock) => void;
		onSelectionChange?: (selection: EdytorSelection) => void;
		value?: JSONDoc;
		placeholder?: Placeholder;
		translate?: 'yes' | 'no';
		spellcheck?: boolean;
		autocorrect?: 'on' | 'off';
		autocomplete?: 'on' | 'off';
		autocapitalize?: 'off' | 'none' | 'on' | 'sentences' | 'words' | 'characters';
		/** Virtual-keyboard hint — forwarded to the root `inputmode`
		 *  attribute; omitted from the DOM when unset (browser default). */
		inputmode?: 'none' | 'text' | 'decimal' | 'numeric' | 'tel' | 'search' | 'email' | 'url';
		/** Virtual-keyboard action-key label — forwarded to the root
		 *  `enterkeyhint` attribute; omitted from the DOM when unset. */
		enterkeyhint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send';
		sync?: EdytorSync;
	};
</script>

<script lang="ts">
	import type { JSONBlock, JSONDoc } from '../utils/json.js';
	import { onMount, setContext, untrack } from 'svelte';
	import type { HotKey } from '$lib/session/keymap.js';
	import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
	import Block from './Block.svelte';
	import RemoteSelections from '$lib/collaboration/RemoteSelections.svelte';

	let {
		plugins,
		blockHandles,
		blockDnd = true,
		class: className,
		edytor = $bindable(),
		// Aliased so the DOM `document` global keeps working in this scope.
		document: edytorDocument,
		doc,
		readonly = false,
		value = $bindable(defaultValue),
		hotKeys,
		sync,
		awareness,
		onChange,
		onSelectionChange,
		placeholder,
		translate = 'no',
		spellcheck = true,
		autocorrect = 'off',
		autocomplete = 'off',
		autocapitalize = 'none',
		inputmode,
		enterkeyhint,
		...snippets
	}: EdytorProps = $props();

	const initialEdytorOptions = untrack(() => ({
		snippets,
		readonly,
		plugins: (() => {
			const handles = blockHandles ?? blockDnd;
			const withoutDefaultHandles = plugins?.filter((plugin) => !isBlockHandlesPlugin(plugin));
			if (handles === false) {
				return withoutDefaultHandles;
			}
			if (typeof handles === 'object') {
				return [createBlockHandlesPlugin(handles), ...(withoutDefaultHandles ?? [])];
			}
			return plugins?.some(isBlockHandlesPlugin)
				? plugins
				: [blockHandlesPlugin, ...(plugins ?? [])];
		})(),
		document: edytorDocument,
		doc,
		awareness,
		hotKeys,
		onSelectionChange,
		onChange,
		sync: !!sync,
		value,
		placeholder
	}));

	edytor = new EdytorClass(initialEdytorOptions);

	// ONE attach path for owned and injected documents (U5/F3): `attachSync`
	// tracks the provider on the DOCUMENT's lifetime (one provider per
	// transport target, settle-or-bound readiness, R13). It attaches while the tree
	// initializes (client only), so every sibling view's provider is in
	// flight before any view decides on mount. A view-owned document still
	// dies with the component: `edytor.destroy()` runs `document.destroy()`,
	// which runs the tracked cleanup.
	const initialSync = untrack(() => sync);
	if (typeof window !== 'undefined' && !initialEdytorOptions.readonly && initialSync) {
		edytor.document.attachSync(initialSync, { value: initialEdytorOptions.value });
	}

	onMount(() => {
		// An editable view without a provider decides an injected pending
		// document only when no sibling's provider is in flight.
		if (!initialEdytorOptions.readonly && !initialSync && !edytor.document.syncPending) {
			edytor.document.sync(initialEdytorOptions.value);
		}

		return () => {
			// The component owns the Edytor — release its doc/awareness/facade/
			// undo-manager listeners so a shared doc doesn't retain dead mounts.
			edytor.destroy();
		};
	});

	$effect(() => {
		edytor.readonly = readonly;
	});

	setContext('edytor', edytor);

	// The display projector (R10): the root `$effect.pre` notes the focused
	// element before the flush writes the DOM; the root `$effect` — the last
	// effect of the editor subtree — displays the selection after them.
	$effect.pre(edytor.projector.pre);
	$effect(edytor.projector.post);

	type EditableRootBrowserAttributes = {
		spellcheck: boolean;
		autocorrect: 'on' | 'off';
		autocomplete: 'on' | 'off';
		autocapitalize: 'off' | 'none' | 'on' | 'sentences' | 'words' | 'characters';
		inputmode?: 'none' | 'text' | 'decimal' | 'numeric' | 'tel' | 'search' | 'email' | 'url';
		enterkeyhint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send';
	};

	const browserMutationGuardAttributes = $derived({
		spellcheck,
		autocorrect,
		autocomplete,
		autocapitalize,
		inputmode,
		enterkeyhint
	});

	const editableRootBrowserAttributes = (
		node: HTMLElement,
		attributes: EditableRootBrowserAttributes
	) => {
		const apply = (nextAttributes: EditableRootBrowserAttributes) => {
			node.setAttribute('spellcheck', String(nextAttributes.spellcheck));
			node.setAttribute('autocorrect', nextAttributes.autocorrect);
			node.setAttribute('autocomplete', nextAttributes.autocomplete);
			node.setAttribute('autocapitalize', nextAttributes.autocapitalize);
			// Optional hints stay absent when unset — emitting a guessed
			// default would override the browser/UA's own choice.
			if (nextAttributes.inputmode === undefined) {
				node.removeAttribute('inputmode');
			} else {
				node.setAttribute('inputmode', nextAttributes.inputmode);
			}
			if (nextAttributes.enterkeyhint === undefined) {
				node.removeAttribute('enterkeyhint');
			} else {
				node.setAttribute('enterkeyhint', nextAttributes.enterkeyhint);
			}
		};

		apply(attributes);

		return {
			update: apply
		};
	};

	const nonNativeEditableBlockChromeSelection = (node: HTMLElement) => {
		const handlePointerDown = (event: PointerEvent) => {
			edytor.selection.handleNonNativeEditableBlockChromePointerDown(event);
		};

		node.addEventListener('pointerdown', handlePointerDown, true);
		// `selectstart` is the only event fired before a drag-selection
		// begins — the guard keeps one from starting on non-editable
		// chrome (markers, void/island chrome, plugin UI).
		node.addEventListener('selectstart', edytor.selection.onSelectStart);

		return {
			destroy: () => {
				node.removeEventListener('pointerdown', handlePointerDown, true);
				node.removeEventListener('selectstart', edytor.selection.onSelectStart);
			}
		};
	};
</script>

{#if edytor.synced}
	{#key edytor.editorDomRevision}
		<div
			class={className}
			use:edytor.attach
			use:editableRootBrowserAttributes={browserMutationGuardAttributes}
			use:nonNativeEditableBlockChromeSelection
			data-edytor
			contenteditable={!readonly}
			role="textbox"
			aria-multiline="true"
			aria-readonly={readonly ? 'true' : 'false'}
			{translate}
		>
			{#each edytor.cells?.rootIds ?? [] as id (id)}<Block {id} />{/each}<span
				data-edytor-render-anchor
				contenteditable="false"
				aria-hidden="true"
				style="display: none"
			></span>
		</div>
	{/key}
	<RemoteSelections {edytor} />
{/if}
