<script lang="ts" module>
	// `EdytorClass` alias: the emitted `.svelte.d.ts` also declares `Edytor`
	// (the component + its bindable instance type) — an unaliased import
	// collides there (TS2440 for bundler-resolution consumers).
	import { Edytor as EdytorClass, useEdytor, type Snippets } from '../edytor.svelte.js';
	import {
		SyncRefusedError,
		type Awareness,
		type DocumentActor,
		type EdytorDocument,
		type YDoc
	} from '../crdt/index.js';
	import { CLOSE, validRoomId } from '../crdt/providers/room.js';
	import type { EdytorSync, WebsocketSyncOptions } from '$lib/collaboration/index.js';
	import { createIndexeddbSync, createWebsocketSync } from '$lib/collaboration/providers.js';
	export { EdytorClass as EdytorContext, useEdytor };
	import type { Placeholder, Plugin } from '$lib/plugins.js';
	import {
		blockHandlesPlugin,
		createBlockHandlesPlugin,
		isBlockHandlesPlugin,
		type BlockHandlesOptions
	} from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
	import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
	import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
	import { imagePlugin, isImagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';

	/**
	 * The plugins every view has unless it lists its own (or sets
	 * `defaultPlugins={false}`), after the app's so its kinds and keys win:
	 * block moves, the image kind, then rich text.
	 */
	const withDefaults = (plugins: Plugin[] = []): Plugin[] => [
		...plugins,
		...(plugins.includes(arrowMovePlugin) ? [] : [arrowMovePlugin]),
		...(plugins.some(isImagePlugin) ? [] : [imagePlugin]),
		...(plugins.includes(richTextPlugin) ? [] : [richTextPlugin])
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
		// the document's `defaultType` on `sync()` (D1). No block types are
		// named here, so mounting with a plugin set that lacks the optional
		// `mention`/`code`/`codeLine` definitions can't crash.
		children: []
	};

	export type EdytorProps = Snippets & {
		plugins?: Plugin[];
		/** Show built-in block handles, with optional pointer dragging and activation callback. */
		blockHandles?: boolean | BlockHandlesOptions;
		/** Add rich text, arrow moves and images unless `plugins` lists them (default `true`). */
		defaultPlugins?: boolean;
		/** @deprecated Use `blockHandles`; `false` also hides the built-in handles. */
		blockDnd?: boolean;
		class?: string;
		edytor?: EdytorClass;
		/** The assembled document this view renders (see `crdt/document.ts`). */
		document?: EdytorDocument;
		doc?: YDoc;
		awareness?: Awareness;
		/** The local author (id, name, color) of the document this view owns: history lineage and presence. */
		actor?: DocumentActor;
		readonly?: boolean;
		/** Chords (`mod+s`, `shift+alt+enter`) the view binds before plugins and built-ins. */
		hotKeys?: Partial<Record<HotKeyCombination, HotKey>>;
		onChange?: (value: JSONBlock) => void;
		onSelectionChange?: (selection: EdytorSelection) => void;
		/** The initial content, read once (not bindable): follow edits with `onChange` or `edytor.value`. */
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
	};
</script>

<script lang="ts">
	import type { JSONBlock, JSONDoc } from '../utils/json.js';
	import { onDestroy, onMount, setContext, untrack } from 'svelte';
	import type { HotKey, HotKeyCombination } from '$lib/session/keymap.js';
	import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
	import Block from './Block.svelte';

	let {
		plugins: userPlugins,
		blockHandles,
		defaultPlugins = true,
		blockDnd = true,
		class: className,
		edytor = $bindable(),
		// Aliased so the DOM `document` global keeps working in this scope.
		document: edytorDocument,
		doc,
		readonly = false,
		value = defaultValue,
		hotKeys,
		sync,
		room,
		server,
		params,
		onSyncExpired,
		onSyncRefused,
		awareness,
		actor,
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
		plugins: withHandles(
			defaultPlugins ? withDefaults(userPlugins) : userPlugins,
			blockHandles ?? blockDnd
		),
		document: edytorDocument,
		doc,
		awareness,
		actor,
		hotKeys,
		onSelectionChange,
		onChange,
		sync: !!sync || room !== undefined,
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
	// Live query params: the provider reads this object at every dial.
	const dialParams: Record<string, string> = untrack(() => ({ ...params }));
	$effect(() => {
		for (const key of Object.keys(dialParams)) delete dialParams[key];
		Object.assign(dialParams, params);
	});
	const initialSync = untrack((): EdytorSync | undefined => {
		// Only a view that attaches builds a provider: never a readonly view or the server render.
		if (typeof window === 'undefined' || initialEdytorOptions.readonly) return undefined;
		if (sync || room === undefined) return sync;
		if (server === undefined) return createIndexeddbSync(room);
		// Per author: the room refuses one user's socket delivering another's edits.
		const persistName = actor
			? `edytor:${actor.id}@${server}/${room}`
			: `edytor:${server.replace(/\/+$/, '')}/${room}`;
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
	// A readonly change shows or hides chrome: the overlay repositions it.
	$effect(() => {
		void edytor.readonly;
		edytor.overlay.invalidate();
	});

	setContext('edytor', edytor);

	// The display projector (R10): the root `$effect.pre` notes the focused
	// element before the flush writes the DOM; the root `$effect` — the last
	// effect of the editor subtree — displays the selection after them.
	// The compare-to-truth observer (R12): the pre pass snapshots edited
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
		const pointerdown = (event: PointerEvent) =>
			selection.handleNonNativeEditableBlockChromePointerDown(event);
		node.addEventListener('pointerdown', pointerdown, true);
		// `selectstart` is the only event fired before a drag-selection
		// begins — the guard keeps one from starting on non-editable
		// chrome (markers, void/island chrome, plugin UI).
		node.addEventListener('selectstart', selection.onSelectStart);
		return {
			destroy: () => {
				node.removeEventListener('pointerdown', pointerdown, true);
				node.removeEventListener('selectstart', selection.onSelectStart);
			}
		};
	};
</script>

{#if edytor.synced}
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
			use:edytor.surface.anchor
		></span>
	</div>
{/if}
