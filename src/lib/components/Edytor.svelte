<script lang="ts" module>
	// `EdytorClass` alias: the emitted `.svelte.d.ts` also declares `Edytor`
	// (the component + its bindable instance type) — an unaliased import
	// collides there (TS2440 for bundler-resolution consumers).
	import { Edytor as EdytorClass, useEdytor, type Snippets } from '../edytor.svelte.js';
	import {
		SyncRefusedError,
		type Awareness,
		type DocChange,
		type DocumentActor,
		type EdytorDocument,
		type YDoc
	} from '../crdt/index.js';
	import { CLOSE, validRoomId } from '../crdt/providers/room.js';
	import type { EdytorSync, WebsocketSyncOptions } from '$lib/collaboration/index.js';
	import {
		DEFAULT_PRESENCE_THROTTLE,
		type PresenceOptions
	} from '$lib/collaboration/awarenessSelection.js';
	import { createIndexeddbSync, createWebsocketSync } from '$lib/collaboration/providers.js';
	export { EdytorClass as EdytorContext, useEdytor };
	import type { Placeholder, Plugin } from '$lib/plugins.js';
	import type { PartialLabels } from '$lib/labels.js';
	import {
		blockHandlesPlugin,
		createBlockHandlesPlugin,
		isBlockHandlesPlugin,
		type BlockHandlesOptions
	} from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
	import { isRichTextPlugin, richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
	import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
	import { imagePlugin, isImagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
	import {
		isSuggestionsPlugin,
		suggestionsPlugin
	} from '$lib/plugins/suggestions/suggestionsPlugin.js';

	/**
	 * The plugins every view has unless it lists its own (or sets
	 * `defaultPlugins={false}`), after the app's so its kinds and keys win:
	 * block moves, the suggestion UI, the image kind, then rich text.
	 */
	const withDefaults = (plugins: Plugin[] = []): Plugin[] => [
		...plugins,
		...(plugins.includes(arrowMovePlugin) ? [] : [arrowMovePlugin]),
		...(plugins.some(isSuggestionsPlugin) ? [] : [suggestionsPlugin]),
		...(plugins.some(isImagePlugin) ? [] : [imagePlugin]),
		...(plugins.some(isRichTextPlugin) ? [] : [richTextPlugin])
	];
	/**
	 * The handles: none with `false`, the configured ones (replacing any
	 * listed) with options, else the listed ones or the default, first.
	 */
	const withHandles = (plugins: Plugin[] | undefined, handles: boolean | BlockHandlesOptions) => {
		const others = plugins?.filter((plugin) => !isBlockHandlesPlugin(plugin));
		if (handles === false) return others;
		if (typeof handles === 'object') return [createBlockHandlesPlugin(handles), ...(others ?? [])];
		return plugins?.some(isBlockHandlesPlugin) ? plugins : [blockHandlesPlugin, ...(plugins ?? [])];
	};
	/**
	 * The sync of a room id no dial can carry (`validRoomId`): no socket, the
	 * refusal `routeDocumentSocket` would give (`4400`), and the local copy
	 * where there is IndexedDB (as `createWebsocketSync` keeps one).
	 */
	const invalidRoom = (persistName: string): EdytorSync =>
		Object.assign(
			({ failed, attach }: Parameters<EdytorSync>[0]) => {
				const release =
					typeof indexedDB === 'undefined' ? undefined : attach?.(createIndexeddbSync(persistName));
				failed?.(new SyncRefusedError(CLOSE.invalidDocument, 'invalid document id'), undefined);
				return release ?? undefined;
			},
			{ bound: Infinity }
		);
	const defaultValue: JSONDoc = {
		// Empty document — the facade seeds the canonical bootstrap block of
		// the document's `defaultType` on `sync()`. No block types are
		// named here, so mounting with a plugin set that lacks the optional
		// `mention`/`code`/`codeLine` definitions can't crash.
		children: []
	};

	export type EdytorProps = Snippets & {
		plugins?: Plugin[];
		/** Show built-in block handles, with optional pointer dragging and activation callback. */
		blockHandles?: boolean | BlockHandlesOptions;
		/** Add rich text, arrow moves, the suggestion UI and images unless `plugins` lists them (default `true`). */
		defaultPlugins?: boolean;
		class?: string;
		/** The root textbox's accessible name (or name it with `aria-labelledby`). */
		'aria-label'?: string;
		/** The id(s) of the element(s) naming the root textbox (a page title, a field label). */
		'aria-labelledby'?: string;
		/** The id(s) of the element(s) describing the root textbox (a hint, an error). */
		'aria-describedby'?: string;
		/** The root textbox's id (a `<label for>`, a skip link). */
		id?: string;
		edytor?: EdytorClass;
		/** The assembled document this view renders (see `crdt/document.ts`). */
		document?: EdytorDocument;
		doc?: YDoc;
		awareness?: Awareness;
		/** The local author (id, name, color) of the document this view owns: history lineage and presence. */
		actor?: DocumentActor;
		/**
		 * What this view shares of its selection with peers (`share`: `'caret'`,
		 * `'block'` or `'none'`) and how often (`throttle`, ms). Follows changes.
		 */
		presence?: PresenceOptions;
		/**
		 * Refuse this view's edits. Follows changes. The view still attaches
		 * its sync (`room`/`server`/`sync`): a live viewer, and a flip keeps
		 * the connection.
		 */
		readonly?: boolean;
		/** Chords (`mod+s`, `shift+alt+enter`) the view binds before plugins and built-ins. Read once. */
		hotkeys?: Partial<Record<HotKeyCombination, HotKey>>;
		/** After every commit that changed the visible document: a `JSONDoc`, the type `value` takes. */
		onChange?: (value: JSONDoc) => void;
		/**
		 * After every commit that changed the visible document: the change report
		 * (`DocChange`), with no whole-document export. Read once.
		 */
		onDocChange?: (change: DocChange) => void;
		onSelectionChange?: (selection: EdytorSelection) => void;
		/** The initial content, read once (not bindable): follow edits with `onChange` or `edytor.value`. */
		value?: JSONDoc;
		placeholder?: Placeholder;
		/**
		 * The words the view says itself, over the English ones: its
		 * announcements to assistive technology and a suggestion's name. Each
		 * plugin takes its own `labels`. Read once.
		 */
		labels?: PartialLabels<'editor'>;
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
		/**
		 * The document's id. Alone: a local IndexedDB copy under that name. With
		 * `server`: the room on that server, plus the local copy (1 to 256
		 * characters, not `.` or `..`, with no lone surrogate: another id is
		 * refused `4400` through `onSyncRefused`, never dialed). Read once.
		 */
		room?: string;
		/** The sync server's base URL (`wss://…/rooms`); the view dials `<server>/<room>`. Read once. */
		server?: string;
		/** Query parameters sent with each dial (auth token…). Updates reach the next reconnect. */
		params?: Record<string, string>;
		/**
		 * With `server`: the room closed the connection with `4401` (expired
		 * credentials). Pass fresh `params` before the redial, due in `nextRetryMs`.
		 */
		onSyncExpired?: WebsocketSyncOptions['onExpired'];
		/**
		 * The server refused a provider of this view's document for good (see
		 * `document.syncRefusal`): a refusal standing at mount, then each new one.
		 */
		onSyncRefused?: (refusal: SyncRefusedError) => void;
		/** Advanced: a custom sync factory. Overrides `room`/`server`. */
		sync?: EdytorSync;
		/**
		 * Keep the view read-only, and seed nothing, until its document was
		 * fetched once (a provider synced): a first visit offline shows no
		 * `value` that the room's content would later duplicate. For the
		 * document this view owns (with `document`, set it there). Read once.
		 */
		requireHydration?: boolean;
		/**
		 * The document as JSON, shown read-only until this view's document is
		 * ready: a first visit to a room-backed document paints at once
		 * — server-side too — instead of waiting for the room. Its own view of
		 * the same plugins, replaced by the live one in the same update. Fetch
		 * it with `documentSnapshot({ server, room, params })` (or the room's
		 * `read()` in your server load). Read once.
		 */
		snapshot?: JSONDoc;
	};
</script>

<script lang="ts">
	import type { JSONDoc } from '../utils/json.js';
	import { onDestroy, onMount, setContext, untrack } from 'svelte';
	import type { HotKey, HotKeyCombination } from '$lib/session/keymap.js';
	import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
	import Block from './Block.svelte';
	import Snapshot from './Edytor.svelte';

	let {
		plugins: userPlugins,
		blockHandles,
		defaultPlugins = true,
		class: className,
		'aria-label': ariaLabel,
		'aria-labelledby': ariaLabelledby,
		'aria-describedby': ariaDescribedby,
		id,
		edytor = $bindable(),
		// Aliased so the DOM `document` global keeps working in this scope.
		document: edytorDocument,
		doc,
		readonly = false,
		value = defaultValue,
		hotkeys,
		sync,
		room,
		server,
		params,
		onSyncExpired,
		onSyncRefused,
		requireHydration,
		snapshot,
		awareness,
		actor,
		presence,
		onChange,
		onDocChange,
		onSelectionChange,
		placeholder,
		labels,
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
		plugins: withHandles(
			defaultPlugins ? withDefaults(userPlugins) : userPlugins,
			blockHandles ?? true
		),
		document: edytorDocument,
		doc,
		awareness,
		actor,
		requireHydration,
		hotkeys,
		onSelectionChange,
		onChange,
		onDocChange,
		sync: !!sync || room !== undefined,
		value,
		placeholder,
		labels
	}));

	edytor = new EdytorClass(initialEdytorOptions);

	// ONE attach path for owned and injected documents: `attachSync`
	// tracks the provider on the DOCUMENT's lifetime (one provider per
	// transport target, settle-or-bound readiness). It attaches while the tree
	// initializes (client only), so every sibling view's provider is in
	// flight before any view decides on mount. A view-owned document still
	// dies with the component: `edytor.destroy()` runs `document.destroy()`,
	// which runs the tracked cleanup.
	// Live query params: the provider reads this object at every dial.
	const dialParams: Record<string, string> = untrack(() => ({ ...params }));
	$effect(() => {
		for (const key of Object.keys(dialParams)) delete dialParams[key];
		Object.assign(dialParams, params);
	});
	const initialSync = untrack((): EdytorSync | undefined => {
		// The server render builds no provider. A readonly view attaches its
		// sync like an editable one (a live viewer): `readonly` refuses
		// this view's writes, never the room's updates, so a flip keeps it.
		if (typeof window === 'undefined') return undefined;
		if (sync || room === undefined) return sync;
		if (server === undefined) return createIndexeddbSync(room);
		// Per author: the room refuses one user's socket delivering another's edits.
		// Named from the server the socket dials (no trailing slash).
		const persistName = `edytor:${actor ? `${actor.id}@` : ''}${server.replace(/\/+$/, '')}/${room}`;
		// An id no dial can carry is refused as the router would (4400), never thrown
		// from the view; its local copy is kept, as the socket's companion would be.
		if (!validRoomId(room)) return invalidRoom(persistName);
		return createWebsocketSync({
			server,
			room,
			params: dialParams,
			onExpired: (state) => onSyncExpired?.(state),
			persistName
		});
	});
	if (initialSync) edytor.document.attachSync(initialSync, { value: initialEdytorOptions.value });

	let offRefused: (() => void) | undefined;
	onMount(() => {
		const { document } = edytor;
		// An editable view without a provider decides an injected pending
		// document only when no sibling's provider is in flight, and never
		// over a refusal.
		const refusal = document.syncRefusal;
		if (!initialEdytorOptions.readonly && !initialSync && !document.syncPending && !refusal) {
			document.sync(initialEdytorOptions.value);
		}
		// Subscribe first, then replay the standing refusal isolated like the
		// later ones: a throwing callback still hears the next refusal.
		offRefused = document.onSyncRefused((next) => onSyncRefused?.(next));
		if (refusal) {
			try {
				onSyncRefused?.(refusal);
			} catch (error) {
				console.error('[edytor] onSyncRefused failed; continuing', error);
			}
		}
	});

	// The component owns the Edytor — release its doc/awareness/facade/
	// undo-manager listeners so a shared doc doesn't retain dead mounts.
	// `onDestroy` also runs after a server render: a view-owned document
	// (and its awareness timer) must not outlive the request.
	onDestroy(() => {
		offRefused?.();
		edytor.destroy();
	});

	$effect(() => {
		edytor.readonly = readonly;
	});
	$effect(() => {
		edytor.presence.throttle = presence?.throttle ?? DEFAULT_PRESENCE_THROTTLE;
		edytor.presence.share = presence?.share ?? 'caret';
	});
	// A readonly change shows or hides chrome: the overlay repositions it.
	$effect(() => {
		void edytor.readonly;
		edytor.overlay.invalidate();
	});

	setContext('edytor', edytor);

	/** The chrome popup open on this view (`edytor.popups`): the root names it while it is. */
	const popup = $derived(edytor.popups.current);

	// The display projector: the root `$effect.pre` notes the focused
	// element before the flush writes the DOM; the root `$effect` — the last
	// effect of the editor subtree — displays the selection after them.
	// The compare-to-truth observer: the pre pass snapshots edited
	// contents before the flush's writes, the compare pass runs after them.
	$effect.pre(edytor.surface.pre);
	$effect.pre(edytor.projector.pre);
	$effect(edytor.surface.post);
	$effect(edytor.projector.post);

	const browserMutationGuardAttributes = $derived({
		spellcheck,
		autocorrect,
		autocomplete,
		autocapitalize,
		inputmode,
		enterkeyhint
	});

	/**
	 * The root's browser attributes. Optional hints (`inputmode`,
	 * `enterkeyhint`) stay absent when unset — emitting a guessed default
	 * would override the browser/UA's own choice.
	 */
	const editableRootBrowserAttributes = (
		node: HTMLElement,
		attributes: typeof browserMutationGuardAttributes
	) => {
		const apply = (next: typeof attributes) => {
			for (const [name, value] of Object.entries(next))
				if (value === undefined) node.removeAttribute(name);
				else node.setAttribute(name, String(value));
		};
		apply(attributes);
		return { update: apply };
	};

	const nonNativeEditableBlockChromeSelection = (node: HTMLElement) => {
		const { selection } = edytor;
		// `selectstart` is the only event fired before a drag-selection
		// begins — the guard keeps one from starting on non-editable
		// chrome (markers, void/island chrome, plugin UI). A press on that
		// chrome is the press's (`events/onFocus.ts`).
		node.addEventListener('selectstart', selection.onSelectStart);
		return {
			destroy: () => node.removeEventListener('selectstart', selection.onSelectStart)
		};
	};
</script>

{#if edytor.synced}
	<!-- The editing host is focusable (contenteditable): no tabindex of its own. -->
	<!-- svelte-ignore a11y_aria_activedescendant_has_tabindex -->
	<div
		class={className}
		use:edytor.attach
		use:editableRootBrowserAttributes={browserMutationGuardAttributes}
		use:nonNativeEditableBlockChromeSelection
		data-edytor
		data-edytor-selection={edytor.selection.value.kind === 'blocks' ? 'blocks' : undefined}
		contenteditable={!readonly}
		role="textbox"
		{id}
		aria-label={ariaLabel}
		aria-labelledby={ariaLabelledby}
		aria-describedby={ariaDescribedby}
		aria-multiline="true"
		aria-readonly={readonly ? 'true' : 'false'}
		aria-controls={popup?.id}
		aria-haspopup={popup?.haspopup}
		aria-activedescendant={popup?.active}
		aria-keyshortcuts={popup?.keys}
		{translate}
	>
		{#each edytor.cells?.rootIds ?? [] as id (id)}<Block {id} />{/each}<span
			data-edytor-render-anchor
			contenteditable="false"
			aria-hidden="true"
			style="display: none"
			use:edytor.surface.anchor
		></span>
	</div>
{:else if snapshot}
	<!-- The room's JSON, read-only, while this view's document hydrates. -->
	<div data-edytor-snapshot style="display: contents">
		<Snapshot
			value={snapshot}
			readonly
			plugins={userPlugins}
			{defaultPlugins}
			{blockHandles}
			class={className}
			{placeholder}
			{labels}
			aria-label={ariaLabel}
			aria-labelledby={ariaLabelledby}
			aria-describedby={ariaDescribedby}
			{id}
			{...snippets}
		/>
	</div>
{/if}

<style>
	/*
	 * A block selection shows as its selected blocks, never as a native range:
	 * the range a pointer drag across columns still extends under it
	 * (`sel.drag.across-columns`) is not highlighted, over any theme.
	 */
	:global([data-edytor][data-edytor-selection='blocks'] ::selection),
	:global([data-edytor][data-edytor-selection='blocks']::selection) {
		background: transparent !important;
	}
</style>
