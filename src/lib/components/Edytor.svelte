<script lang="ts" module>
	// `EdytorClass` alias: the emitted `.svelte.d.ts` also declares `Edytor`
	// (the component + its bindable instance type) — an unaliased import
	// collides there (TS2440 for bundler-resolution consumers).
	import { Edytor as EdytorClass, useEdytor } from '../edytor.svelte.js';
	import {
		SyncRefusedError,
		type DocChange,
		type DocumentActor,
		type EdytorDocument
	} from '../crdt/index.js';
	import { CLOSE, validRoomId } from '../crdt/providers/room.js';
	import type { EdytorSync, WebsocketSyncOptions } from '$lib/collaboration/index.js';
	import {
		DEFAULT_PRESENCE_THROTTLE,
		type PresenceOptions
	} from '$lib/collaboration/awarenessSelection.js';
	import { createIndexeddbSync, createWebsocketSync } from '$lib/collaboration/providers.js';
	export { EdytorClass as EdytorContext, useEdytor };
	import type { Plugin } from '$lib/plugins.js';
	import { brandOf } from '$lib/plugins/brand.js';
	import type { PartialLabels } from '$lib/labels.js';
	import { createRichTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
	import { createSuggestionsPlugin } from '$lib/plugins/suggestions/suggestionsPlugin.js';

	/**
	 * The plugins every view has unless it lists one of their kind (or sets
	 * `defaultPlugins={false}`), after the app's so its kinds and keys win:
	 * the suggestion UI, then rich text (an app lists `createArrowMovePlugin()`
	 * for block moves and `createImagePlugin({ upload })` for images itself).
	 */
	const DEFAULTS = [createSuggestionsPlugin(), createRichTextPlugin()];
	const withDefaults = (plugins: Plugin[] = []): Plugin[] => {
		const listed = new Set(plugins.map(brandOf));
		return [...plugins, ...DEFAULTS.filter((plugin) => !listed.has(brandOf(plugin)))];
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

	export type EdytorProps = {
		plugins?: Plugin[];
		/** Add rich text and the suggestion UI unless `plugins` lists them (default `true`). */
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
		/** The local author (id, name, color) of the document this view owns: attribution and presence. */
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
		/**
		 * Let users nest blocks (default `false`): Tab and Shift+Tab nest and
		 * unnest, drops and handle keys may place a block inside another. Off,
		 * Tab is left to the browser and no gesture nests; containers keep their
		 * bodies. Read once.
		 */
		allowNesting?: boolean;
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
		/**
		 * The words the package shows and says in this view, over the English
		 * ones: any entry of any section (`editor`, `richText`, `table`…) and
		 * the commands' slash `keywords` by id. Read once.
		 */
		labels?: PartialLabels;
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
		/** @internal The view's own rebuild (`EdytorRoot`): a new view on a new document. */
		rebuild?: () => void;
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
		defaultPlugins = true,
		class: className,
		'aria-label': ariaLabel,
		'aria-labelledby': ariaLabelledby,
		'aria-describedby': ariaDescribedby,
		id,
		edytor = $bindable(),
		// Aliased so the DOM `document` global keeps working in this scope.
		document: edytorDocument,
		readonly = false,
		allowNesting = false,
		value = defaultValue,
		hotkeys,
		sync,
		room,
		server,
		params,
		onSyncExpired,
		onSyncRefused,
		rebuild,
		requireHydration,
		snapshot,
		actor,
		presence,
		onChange,
		onDocChange,
		onSelectionChange,
		labels,
		translate = 'no',
		spellcheck = true,
		autocorrect = 'off',
		autocomplete = 'off',
		autocapitalize = 'none',
		inputmode,
		enterkeyhint
	}: EdytorProps = $props();

	const initialEdytorOptions = untrack(() => ({
		readonly,
		allowNesting,
		plugins: defaultPlugins ? withDefaults(userPlugins) : userPlugins,
		document: edytorDocument,
		actor,
		requireHydration,
		hotkeys,
		onSelectionChange,
		onChange,
		onDocChange,
		sync: !!sync || room !== undefined,
		value,
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
		offRefused = document.onSyncRefused((next) => {
			onSyncRefused?.(next);
			// A re-seed (`4410`): a view that owns its document builds itself again on a new one.
			if (next.code === CLOSE.reseeded && !edytorDocument) rebuild?.();
		});
		if (refusal) {
			try {
				onSyncRefused?.(refusal);
			} catch (error) {
				console.error('[edytor] onSyncRefused failed; continuing', error);
			}
		}
	});

	// The component owns the Edytor — release its facade/
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

	/**
	 * The root's browser hints, several of them unknown to Svelte's element
	 * types; one left unset is absent (a guessed default would override the
	 * browser's own choice).
	 */
	const browserAttributes = (node: HTMLElement, attributes: Record<string, unknown>) => {
		const apply = (next: Record<string, unknown>) => {
			for (const [name, value] of Object.entries(next))
				if (value === undefined) node.removeAttribute(name);
				else node.setAttribute(name, String(value));
		};
		apply(attributes);
		return { update: apply };
	};
</script>

{#if edytor.synced}
	<!-- The editing host is focusable (contenteditable): no tabindex of its own. -->
	<!-- svelte-ignore a11y_aria_activedescendant_has_tabindex -->
	<!-- `selectstart`, fired before a drag-selection begins, keeps one from starting on
	non-editable chrome (a press there is the press's: `events/onFocus.ts`). -->
	<div
		class={className}
		use:edytor.attach
		onselectstart={edytor.selection.pointer.onSelectStart}
		use:browserAttributes={{
			spellcheck,
			autocorrect,
			autocomplete,
			autocapitalize,
			inputmode,
			enterkeyhint
		}}
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
		{#each edytor.suggestions.around(edytor.cells?.rootIds ?? []) as kid (kid)}<Block
				{kid}
			/>{/each}<span
			data-edytor-render-anchor
			contenteditable="false"
			aria-hidden="true"
			style="display: none"
			use:edytor.surface.own
		></span>
	</div>
{:else if snapshot}
	<!-- The room's JSON, read-only, while this view's document hydrates. -->
	<div data-edytor-snapshot style="display: contents">
		<Snapshot
			{...{
				value: snapshot,
				readonly: true,
				plugins: userPlugins,
				defaultPlugins,
				class: className,
				labels,
				'aria-label': ariaLabel,
				'aria-labelledby': ariaLabelledby,
				'aria-describedby': ariaDescribedby,
				id
			}}
		/>
	</div>
{/if}

<style>
	/* Where a drag lands, a block handle's or files' from outside (`DropIndicator`):
	 * the bar (4px) and the nest backdrop, placed in the overlay and shown
	 * (`data-shown`) by the drag; their look is a theme's (`edytor/themes/notion.css`). */
	:global([data-edytor-drop-indicator]),
	:global([data-edytor-drop-backdrop]) {
		position: absolute;
		pointer-events: none;
	}

	:global([data-edytor-drop-indicator]) {
		z-index: 100;
		box-sizing: border-box;
		height: 4px;
	}

	:global([data-edytor-drop-backdrop]) {
		z-index: 99;
	}

	:global([data-edytor-drop-backdrop]:not([data-shown='true'])) {
		visibility: hidden;
	}

	/*
	 * Room below the last block, where a press puts the caret in a trailing
	 * paragraph (`nav.trailing.press`): `--edytor-trailing-space`. No
	 * specificity, so any rule of the app's sets the padding instead.
	 */
	:global(:where([data-edytor])) {
		padding-block-end: var(--edytor-trailing-space, 2em);
	}
	/*
	 * Long pages, opt-in: the `edytor-long-page` class on the editor or an
	 * ancestor lets a top-level block off screen skip its rendering (style,
	 * layout, paint) until it nears the viewport; the browser keeps its DOM,
	 * selection, find-in-page and accessibility. Until it was rendered once it
	 * counts as one 32px row (`auto` remembers its real height after). Both
	 * properties come with the one switch: the remembered height alone makes
	 * Chromium track every top-level block's size each frame (about 2.5 ms at
	 * 5,000 blocks), so without the switch neither is set. Only top-level
	 * blocks: a nested one is skipped with its ancestor. The containment it
	 * brings (layout, paint) clips what a block paints outside its own box.
	 * No specificity: an app's own rule wins.
	 */
	:global(:where([data-edytor]:is(.edytor-long-page, .edytor-long-page *) > [data-edytor-block])) {
		content-visibility: auto;
		contain-intrinsic-block-size: auto 32px;
	}
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
