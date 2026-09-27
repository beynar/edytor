import { getContext, hasContext, setContext, tick, type Snippet, onMount } from 'svelte';
import { onBeforeInput } from './events/onBeforeInput.js';
import { onCopy } from './events/onCopy.js';
import { onCut } from './events/onCut.js';
import { observeDomTextMutations } from './events/domTextMutationObserver.js';
import {
	isNativeInteractiveEvent,
	isNestedForeignEditableTarget
} from './events/nativeInteractiveControl.js';
import { onInput } from './events/onInput.js';
import { onPaste } from './events/onPaste.js';
import { preventUnsupportedDrop } from './events/onDrop.js';
import { Attempts } from './session/attempt.js';
import { Composition } from './session/composition.svelte.js';
import { type JSONBlock, type JSONDoc } from '$lib/utils/json.js';
import { onKeyDown } from '$lib/events/onKeyDown.js';
import { EdytorSelection } from './selection/selection.svelte.js';
import { Projector } from './surface/projector.svelte.js';
import { Block } from './block/block.svelte.js';
import { Text } from './text/text.svelte.js';
import { SvelteMap } from 'svelte/reactivity';
import { Y } from '$lib/crdt/engine.js';
import {
	attachDocument,
	bindCrdt,
	SemanticConflictError,
	type Awareness,
	type Crdt,
	type DocChange,
	type EdytorDoc,
	type EdytorDocument,
	type OrderPolicy,
	type ProjectedBlock,
	type ProjectedDoc,
	type YDoc,
	type YUndoManager
} from '$lib/crdt/index.js';
import { whenDocumentReady } from '$lib/collaboration/documentSync.js';
import { mintPresenceKey, publishPresence } from '$lib/collaboration/awarenessSelection.js';
import { batch } from './block/block.utils.js';
import {
	canMoveBlocks as canMoveBlocksRelative,
	moveBlocks as moveBlocksRelative,
	type BlockMoveRequest
} from './session/moves.js';
import type {
	Plugin,
	BlockSnippetPayload,
	InitializedPlugin,
	MarkSnippetPayload,
	BlockDefinition,
	MarkDefinition,
	InlineBlockDefinition,
	InlineBlockSnippetPayload,
	EditorCommand
} from './plugins.js';
import { on } from 'svelte/events';
import { Keymap, type HotKey } from './session/keymap.js';
import { TRANSACTION } from './constants.js';
import type { InlineBlock } from './block/inlineBlock.svelte.js';
import {
	deleteBlocks,
	deleteContentWithinSelection,
	insertFlow,
	prepareDeleteBlocks,
	prepareDeleteContent,
	prepareFlow
} from './edytor.utils.js';
import { Dispatcher } from './session/commands.js';
import { History } from './session/history.js';
import type { SelectionValue } from './session/selection.js';
import { kindCatalogue, kindCommand, type KindRow } from './kinds.js';
import {
	clearDomSelection,
	getActiveElement,
	getDomSelection,
	getDomSelectionSnapshot
} from './selection/domSelection.js';
import { getYIndex } from './selection/selection.utils.js';
import {
	createPlaceholderRepairQueue,
	type PlaceholderRepairQueue
} from './text/removeStalePlaceholders.js';

export type Snippets = {
	// `mentionInlineBlock` satisfies BOTH the `*InlineBlock` and `*Block`
	// domain patterns, so property lookup intersects the matching arms —
	// a bare `Snippet<[BlockSnippetPayload]>` on the `*Block` arm would
	// make `*InlineBlock` props unassignable. Unioning the inline payload
	// into the `*Block` arm collapses the intersection back to the inline
	// type while keeping `*Block` overrides precisely typed.
	[K in
		| `${string}InlineBlock`
		| `${string}Block`
		| `${string}Mark`]: K extends `${string}InlineBlock`
		? Snippet<[InlineBlockSnippetPayload]>
		: K extends `${string}Block`
			? Snippet<[BlockSnippetPayload]> | Snippet<[InlineBlockSnippetPayload]>
			: Snippet<[MarkSnippetPayload]>;
};

export type EdytorOptions = {
	readonly?: boolean;
	snippets?: Snippets;
	hotKeys?: Record<string, HotKey>;
	plugins?: Plugin[];
	/**
	 * The assembled document this view renders — shared facade, history,
	 * awareness and semantics live on it (see `crdt/document.ts`). When
	 * injected the view borrows it: `destroy()` releases only view-owned
	 * resources. When absent the view internally owns a document built
	 * around `doc`/`awareness` (the legacy path — same behavior as before).
	 */
	document?: EdytorDocument;
	doc?: YDoc;
	awareness?: Awareness;
	sync?: boolean;
	value?: JSONDoc;
	onChange?: (value: JSONBlock) => void;
	onSelectionChange?: (selection: EdytorSelection) => void;
	placeholder?: string | Snippet<[{ block: Block }]>;
};

export type RootBlock = Block & {
	readonly type: 'root';
	readonly id: 'root';
	readonly depth: 0;
};

const getEventTimeStamp = (event: Event | undefined) =>
	event?.timeStamp || (typeof performance === 'undefined' ? Date.now() : performance.now());

/**
 * One `bindCrdt` binding shared by every `Edytor` — the binding exists for
 * legacy consumers only (peer-facade helpers in tests, migration, provider
 * plumbing), so paying a second binding per view buys nothing.
 *
 * CONTRACT: `crdt.doc.create` on a raw doc already wrapped by an
 * `EdytorDocument` would fork a SECOND maintained run view for that doc —
 * the document's `facade` is the only structural surface and the fork is
 * forbidden. `create` on an UNWRAPPED doc (a remote peer's replica in
 * tests) stays legitimate.
 */
const sharedCrdt = bindCrdt(Y);

/** Register definitions a first extension has not: a bare snippet is `{ snippet }`. */
const define = <T extends object>(into: Map<string, T>, definitions: object = {}) => {
	for (const [key, value] of Object.entries(definitions))
		if (!into.has(key))
			into.set(key, typeof value === 'object' ? value : ({ snippet: value } as T));
};

export class Edytor {
	node?: HTMLElement;
	marks = new Map<string, MarkDefinition>();
	blocks = new Map<string, BlockDefinition>();
	inlineBlocks = new Map<string, InlineBlockDefinition>();
	commands = new Map<string, EditorCommand>();
	/** The kind catalogue: one row per preset of each kind record (slash, markdown, block menus). */
	kinds: KindRow[] = [];
	plugins: InitializedPlugin[];
	container = $state<HTMLDivElement>();
	idToBlock = new SvelteMap<string, Block>();
	idToInlineBlock = new SvelteMap<string, InlineBlock>();
	nodeToInlineBlock = new SvelteMap<Node, InlineBlock>();
	idToText = new SvelteMap<string, Text>();
	nodeToText = new SvelteMap<Node, Text>();
	transaction = new TRANSACTION();
	hotKeys: Keymap;
	readonly = $state(false);
	root = $state<Block>();
	editorDomRevision = $state(0);
	/** The view is bound to its decided document (its root is built). */
	get synced(): boolean {
		return this.root !== undefined;
	}
	edytor = this;
	selection: EdytorSelection;
	/** The only writer of the DOM selection (R10, `surface/projector`). */
	readonly projector: Projector = new Projector(this);
	private off: (() => void)[] = [];
	private onChange?: (value: JSONBlock) => void;
	placeholder?: string | Snippet<[{ block: Block }]>;
	/** The view's composition session (R8, L7, O34): at most one, live then tail. */
	readonly composition: Composition = new Composition(this);
	/** A composition session is live. */
	get isComposing() {
		return this.composition.live;
	}
	/**
	 * True for the synchronous duration of a real user-input event
	 * (beforeinput/input/keydown/paste/cut). Selection writes use it to
	 * gate typing affordances — scrolling the caret into view must follow
	 * the user's input, not programmatic writes (`clear()`, remote sync,
	 * API-driven selection changes must never move the page).
	 */
	isHandlingUserInput = false;
	/**
	 * Depth counter suppressing caret scroll during programmatic DOM
	 * writes — remote mirror flushes and mutation-observer repairs can
	 * land inside an `isHandlingUserInput` window; their selection writes
	 * are maintenance, not typing, and must not move the page.
	 */
	suppressCaretScrollDepth = 0;
	/**
	/** The view's input attempts (R8, L6): one per user occurrence. */
	readonly attempts = new Attempts();
	/** The DOM observer: the only adopter of browser-made text (R8, L31). */
	observer: ReturnType<typeof observeDomTextMutations> | null = null;

	// CRDT (v14) — the document is the composition owner: it holds the ONE
	// engine doc, the shared facade (only structural read/write surface),
	// the default local history and the shared awareness. Injected
	// documents are borrowed; a view with no `document` option internally
	// owns one (built around `doc`/`awareness` when those are injected).
	document: EdytorDocument;
	/** `true` when this view created its document — `destroy()` then releases it. */
	ownsDocument = false;
	get doc(): YDoc {
		return this.document.doc;
	}
	get facade(): EdytorDoc {
		return this.document.facade;
	}

	// Document order (O7): the view's walkers and block-selection keys read
	// the document's one pre-order; `policy` is its island-sealing policy.
	blockAfter = (block: Block, policy?: OrderPolicy): Block | null =>
		this.idToBlock.get(this.facade.next(block.id, policy) ?? '') ?? null;
	blockBefore = (block: Block, policy?: OrderPolicy): Block | null =>
		this.idToBlock.get(this.facade.previous(block.id, policy) ?? '') ?? null;
	compareBlocks = (a: Block, b: Block): number => this.facade.compare(a.id, b.id);
	/** `start`, `end` and every block between them in document order (no `end`: to the last). */
	blocksBetween = (start: Block, end: Block | null): Block[] => {
		const ids = this.facade.order();
		const from = ids.indexOf(start.id);
		if (from < 0) return [start];
		const to = end ? ids.indexOf(end.id, from) : -1;
		return ids
			.slice(from, to < 0 ? undefined : to + 1)
			.flatMap((id) => this.idToBlock.get(id) ?? []);
	};
	get awareness(): Awareness {
		return this.document.awareness;
	}
	/**
	 * Legacy accessor — the view no longer binds the engine (the document
	 * shares the production binding). Returns the module-level singleton:
	 * one binding per runtime, not one per view. Do NOT `crdt.doc.create`
	 * on this view's `doc` — the document's facade is the only maintained
	 * surface for it (see `sharedCrdt`'s contract note).
	 */
	get crdt(): Crdt {
		return sharedCrdt;
	}
	/**
	 * Counts committed document transactions (local, remote, undo/redo) —
	 * bumped only inside the facade `onChange` listener. Selection-restore
	 * code reads this to detect real edits landing in an async restore
	 * window. (The memoized live projection invalidates on `facade.version`
	 * — the model-state token the facade itself owns — so this counter is
	 * purely a commit signal, not a read-cache key.)
	 */
	_docCommitVersion = 0;
	private _treeCache: {
		version: number;
		doc: ProjectedDoc;
		index: Map<string, ProjectedBlock>;
	} | null = null;
	/**
	 * The document's shared undo manager — assigned at the end of `sync()`,
	 * never in the constructor, so history capture still starts only after
	 * the document decides its content state (the bootstrap-before-capture
	 * invariant: `document.sync()` seeds/asserts first, then attaches the
	 * manager). Only absent before first sync, which is also before the
	 * editor mounts, so all runtime readers see it set.
	 */
	undoManager!: YUndoManager;
	/**
	 * The DocChange currently being applied to the mirror (set while the
	 * facade onChange dispatch runs) — lets wrappers distinguish
	 * remote/programmatic updates from local ops.
	 */
	_mirrorChange: DocChange | null = null;
	/** Detached block wrappers awaiting adoption onto a fresh facade id. */
	_pendingBlocks = new Map<string, Block>();
	/**
	 * Coalesced stale-placeholder repair — ONE pending-roots set per view.
	 * Commits queue only the block roots their `DocChange` touched; the
	 * queue's phase chain (immediate → microtask → rAF → deferred retries)
	 * scans just those roots, so a burst of N commits costs one repair
	 * round instead of N overlapping full-editor sweeps. `destroy()`
	 * releases it — no scheduled pass may act on a dead view.
	 */
	readonly placeholderRepair: PlaceholderRepairQueue = createPlaceholderRepairQueue();

	/** The view's command dispatcher (R7): every mutation this view makes goes through it. */
	readonly dispatcher: Dispatcher = new Dispatcher(this);

	transact = <T>(cb: () => T): T => {
		this.attempts.hold();
		return this.doc.transact(() => {
			const result = cb();
			return result;
		}, this.transaction);
	};

	/** Whether a block move (relative step or beside/inside a target) is structurally allowed. */
	canMoveBlocks = (request: BlockMoveRequest): boolean => canMoveBlocksRelative(this, request);

	/** Move blocks one relative step (D-5), or before, after or inside a live target block. */
	moveBlocks = (request: BlockMoveRequest): Block[] => moveBlocksRelative(this, request);

	/** This view's history (R7's named exception): bare engine undo/redo, one restorer. */
	readonly history = new History(this);

	/**
	 * Undo/redo through THIS view: the only history entry points that restore
	 * a view's selection (its recorded `before`/`after`); sibling views and a
	 * headless `document.history.undo()` restore none (their carets ride the
	 * change, as for a remote undo).
	 */
	historyUndo = (): void => this.history.undo();
	historyRedo = (): void => this.history.redo();

	private deferredEditorDomRefresh = false;
	refreshEditorDom = () => {
		// `{#key editorDomRevision}` remounts the whole subtree — that would
		// destroy the DOM node the IME owns: the remount waits for the session's end.
		if (this.deferredEditorDomRefresh) return;
		this.deferredEditorDomRefresh = true;
		this.composition.ended(() => {
			this.deferredEditorDomRefresh = false;
			if (!this.destroyed) this.editorDomRevision += 1;
		});
	};

	constructor({
		snippets,
		readonly,
		hotKeys,
		plugins,
		document,
		doc,
		awareness,
		sync,
		value,
		onSelectionChange,
		placeholder,
		onChange
	}: EdytorOptions) {
		if (document !== undefined) {
			if (doc !== undefined || awareness !== undefined) {
				throw new Error(
					'EdytorOptions: `document` cannot be combined with `doc`/`awareness` — ' +
						'the document owns them (compose them via attachDocument first).'
				);
			}
			this.document = document;
		} else {
			// Legacy path — the view internally owns a document composed
			// around the injected (or a fresh) doc/awareness.
			this.document = attachDocument(doc ?? new Y.Doc(), { awareness });
			this.ownsDocument = true;
		}
		this.readonly = readonly || false;
		this.onChange = onChange;

		// From here on a throw must unwind what this view already claimed
		// on the shared document: the enrolled history origin and the
		// awareness listeners — and, only when the view OWNS the document,
		// the document's attach reference itself. A borrowed/injected
		// document is never destroyed by a failed view.
		try {
			// Initialize plugins. Default children are merged across extensions
			// before definition precedence applies: two extensions declaring
			// different default children for one parent type is an error (D-13).
			const defaultChild: Record<string, string> = {};
			this.plugins = (plugins || []).map((plugin) => {
				const initializedPlugin = plugin(this);
				for (const [type, definition] of Object.entries(initializedPlugin.blocks ?? {})) {
					const child = typeof definition === 'object' ? definition.defaultChild : undefined;
					if (child !== undefined && (defaultChild[type] ??= child) !== child) {
						throw new SemanticConflictError(`defaultChild "${type}"`, defaultChild[type], child);
					}
				}

				// Duplicate definitions: the first extension wins (README, D-11).
				define(this.marks, initializedPlugin.marks);
				define(this.blocks, initializedPlugin.blocks);
				define(this.inlineBlocks, initializedPlugin.inlineBlocks);
				for (const command of initializedPlugin.commands ?? [])
					if (!this.commands.has(command.id)) this.commands.set(command.id, command);
				return initializedPlugin;
			});

			// We set the custom snippets after plugins are initialized in order to be able to override the plugins snippets.
			// Keys are `{type}Mark` / `{type}Block` / `{type}InlineBlock` — the
			// definition maps are keyed by the BARE type name, so the suffix
			// comes off here (`*InlineBlock` is checked before `*Block`:
			// `mentionInlineBlock` matches both). The override merges with
			// the plugin definition so `void`/`island`/`transformText`/
			// lifecycle hooks survive — the snippet is the only thing
			// replaced.
			Object.entries(snippets || {}).forEach(([key, snippet]) => {
				const isMark = key.endsWith('Mark');
				const isInlineBlock = key.endsWith('InlineBlock');
				const isBlock = key.endsWith('Block');
				if (isMark) {
					const name = key.slice(0, -'Mark'.length);
					this.marks.set(name, {
						...this.marks.get(name),
						snippet: snippet as Snippet<[MarkSnippetPayload]>
					});
				} else if (isInlineBlock) {
					const name = key.slice(0, -'InlineBlock'.length);
					this.inlineBlocks.set(name, {
						...this.inlineBlocks.get(name),
						snippet: snippet as Snippet<[InlineBlockSnippetPayload]>
					});
				} else if (isBlock) {
					const name = key.slice(0, -'Block'.length);
					this.blocks.set(name, {
						...this.blocks.get(name),
						snippet: snippet as Snippet<[BlockSnippetPayload]>
					});
				}
			});

			// Kind records generate their commands; an extension's own command id wins.
			this.kinds = kindCatalogue(this.blocks);
			for (const row of this.kinds)
				if (!this.commands.has(row.id)) this.commands.set(row.id, kindCommand(this, row));

			this.placeholder =
				placeholder || this.plugins.find((plugin) => plugin.placeholder)?.placeholder;

			// Contribute this view's capability (R5) to the document — roles,
			// `rendersContent` and default children outlive any single view.
			// The first declaration for a type is adopted; a conflicting one is
			// an error (views cannot silently impose incompatible structural
			// rules on a shared document). Atomic: a conflict validates before
			// ANYTHING is applied, so a failed view cannot half-seed semantics.
			const blocks = Array.from(this.blocks);
			this.document.adoptSemantics({
				roles: Object.fromEntries(
					blocks.map(([type, { void: v, island }]) => [type, { void: v, island }])
				),
				rendersContent: Object.fromEntries(
					blocks.map(([type, definition]) => [type, definition.rendersContent !== false])
				),
				defaultChild
			});

			// Enroll this view's local-edit origin in the document's history —
			// AFTER semantic adoption: a conflicting view must not strand a
			// tracked origin for a view that never came up. Identity tracking:
			// this document's undo manager captures THIS view's edits.
			this.document.trackOrigin(this.transaction);

			// Readiness (R13): the document decides. A view seeds only the
			// document it owns, unless its own provider (`sync`) owns the
			// decision; every other view binds on the one readiness event
			// (`<Edytor>` decides an injected document at mount, once the
			// providers of its sibling views attached).
			if (this.ownsDocument && !(sync && !readonly)) {
				this.sync(value || { children: [] });
			} else {
				this._readinessRelease = whenDocumentReady(this.document, () => {
					if (!this.destroyed) this.sync(value || { children: [] });
				});
			}

			this.selection = new EdytorSelection(this, onSelectionChange);
			this.hotKeys = new Keymap(this, hotKeys, this.plugins);
		} catch (error) {
			// Constructor failure — release what the partial view claimed:
			// the history origin (untracked live — already-captured commits
			// stay undoable) and the document attach reference when this
			// view owns it. Semantic
			// contributions already adopted stay — they are
			// document-lifetime additive declarations, and an injected
			// document's are left for the views that legitimately share it.
			this.document.untrackOrigin(this.transaction);
			if (this.ownsDocument) {
				this.document.destroy();
			}
			throw error;
		}
	}

	getBlockDefinition = <M extends 'inline' | 'block'>(
		mode: M,
		type: string
	): M extends 'block' ? BlockDefinition : InlineBlockDefinition => {
		const definition = mode === 'block' ? this.blocks.get(type) : this.inlineBlocks.get(type);
		if (type === 'root') {
			return {} as any;
		}
		if (!definition) {
			throw new Error(`Block type ${type} is not defined`);
		}
		return definition as M extends 'block' ? BlockDefinition : InlineBlockDefinition;
	};

	private _valueCache: {
		version: number;
		revision: number;
		root: Block | undefined;
		json: JSONBlock;
	} | null = null;

	/**
	 * Committed-change revision counter — the reactive subscription point
	 * for {@link value}. Bumped inside the facade `onChange` dispatch
	 * (before consumers are invoked) so every commit re-triggers tracked
	 * reads of the export.
	 */
	valueRevision = $state(0);

	/**
	 * Full-document JSON export — memoized on `facade.version` (the
	 * model-state token the facade bumps on every write and every
	 * committed update) + the root wrapper identity. Wrapper state only
	 * changes through a facade write (a version bump) or the mirror
	 * reconcile that follows a commit, so a version match guarantees the
	 * cached export is current — repeated reads inside one version share
	 * the one computed tree instead of re-serializing per call.
	 *
	 * `valueRevision` participates in the cache key and is read purely
	 * for reactivity: it is a `$state` counter bumped on every committed
	 * transaction, so `$derived`/`$effect` consumers of `edytor.value`
	 * re-run per commit even though `facade.version` itself is not a
	 * tracked source. Without it a reactive consumer can freeze on the
	 * first cached export (the wrapper fields it happened to track are
	 * not guaranteed to re-fire once the memo key stops changing).
	 *
	 * Callers receive the SAME object until the next version bump — code
	 * that needs an owned copy must clone it (same caveat as the runs /
	 * projected publication boundaries).
	 */
	get value(): JSONBlock {
		// `valueRevision` is the reactive invalidation source: a `$state`
		// counter bumped on every committed change, read here so tracked
		// consumers (`$derived`/`$effect` on `edytor.value`) re-run per
		// commit. `facade.version` — the freshness key — is NOT reactive,
		// so without this read a consumer's subscription depends on
		// incidental wrapper-field tracking and can freeze on a stale
		// export while the model keeps advancing.
		const revision = this.valueRevision;
		const version = this.facade.version;
		const root = this.root;
		const cache = this._valueCache;
		if (cache && cache.version === version && cache.revision === revision && cache.root === root) {
			return cache.json;
		}
		const json: JSONBlock = {
			type: 'root',
			// `facade.toJSON()` is the canonical document export — the one
			// serializer (S6, L14).
			children: root ? this.facade.toJSON().children : []
		};
		this._valueCache = { version, revision, root, json };
		return json;
	}

	runCommand = async (id: string) => {
		const command = this.commands.get(id);
		if (!command || command.isEnabled?.(this) === false) {
			return false;
		}

		await command.run(this);
		return true;
	};

	/** The adopted default type for a new child of `parent` — its actual parent (R5, O9). */
	defaultChild = (parent: Block): string =>
		this.document.defaultChild(parent.isRoot ? null : parent.type);

	/** Releases the readiness wait of a view bound before its document decided. */
	private _readinessRelease: (() => void) | undefined;

	sync = ({ children = [] }: JSONDoc = { children: [] }) => {
		if (this.synced) {
			return;
		}

		// The document owns the content decision: `assertSchema` on an
		// already-initialized (hydrated) doc, `init` on a still-fresh one,
		// then history attaches — the same deferral this method enforced
		// when the view owned it.
		this.document.sync({ children });

		this.undoManager = this.document.history;
		this.history.bind();
		this.root = new Block({
			edytor: this,
			blockId: null
		});
		this.root.reconcileChildren(this.projectedChildren(null));
		// The root has no facade content node — give it the same empty-text
		// sentinel mirror shape blocks get so `root.content` invariants hold.
		this.root.reconcileContent([]);
		this.ensureFacadeChangeSub();
	};

	/**
	 * Unsubscribe handle for the facade→mirror change subscription, when live.
	 */
	private _facadeChangeOff: (() => void) | null = null;

	/**
	 * The facade→mirror change subscription is an EDYTOR-lifetime listener,
	 * but its unsubscribe rides in `this.off`, which the attach action drains
	 * on every remount (`{#key editorDomRevision}` re-runs `use:edytor.attach`
	 * after structural DOM refreshes like undo/redo). Without re-establishing
	 * it, the first remount permanently detaches the mirror from doc changes —
	 * undo/redo and remote updates stop reconciling `root.children` while the
	 * doc itself stays correct. Re-subscribing on each attach (and forcing a
	 * resync, in case a change landed while detached) keeps the mirror bound.
	 */
	ensureFacadeChangeSub = () => {
		if (this._facadeChangeOff || this.destroyed) return;
		const off = this.facade.onChange((change) => {
			// The facade already bumped `facade.version` for this commit —
			// the memoized projection recomputes on next read.
			this._docCommitVersion++;
			this.valueRevision++;
			this._mirrorChange = change;
			// A commit this view did not issue re-renders under the caret: the
			// projector displays the current value after that flush (R10).
			if (change.origin !== this.transaction) this.projector.render++;
			// Remote/programmatic mirror writes run under the scroll
			// suppressor — a remote commit landing inside an in-flight
			// `isHandlingUserInput` window must not scroll the page.
			this.suppressCaretScrollDepth++;
			let mirrorWasIncremental = true;
			try {
				mirrorWasIncremental = this.flushMirror();
			} finally {
				this.suppressCaretScrollDepth--;
				this._mirrorChange = null;
			}
			// `this.value` is a full-document export (O(doc) — ~17ms at 5k
			// blocks) — compute it only when a consumer actually exists. The
			// version-keyed memo keeps repeated reads inside one commit cheap.
			if (this.onChange || this.plugins.some((plugin) => plugin.onChange)) {
				const value = this.value;
				this.onChange?.(value);
				this.plugins.forEach((plugin) => {
					plugin.onChange?.(value);
				});
			}
			void tick().then(() => this.queuePlaceholderRepair(change, mirrorWasIncremental));
		});
		const release = () => {
			if (this._facadeChangeOff !== release) return;
			this._facadeChangeOff = null;
			off();
		};
		this._facadeChangeOff = release;
		this.off.push(release);
		if (this.root) {
			// A change may have landed while the sub was detached — converge the
			// mirror now (the projection re-derives from `facade.version`, so
			// this flush always reads current state).
			this.flushMirror();
		}
	};

	/**
	 * The live projected tree — `facade.project()` reads current node state,
	 * so unlike the maintained runs view it reflects writes made earlier in
	 * the SAME uncommitted transaction. Memoized on `facade.version` — the
	 * model-state token the facade bumps on every write (inside the same
	 * transaction) and on every committed update — so command-layer reads
	 * always observe post-write state (read-your-writes).
	 */
	private _projectedTree = (): {
		doc: ProjectedDoc;
		index: Map<string, ProjectedBlock>;
	} => {
		const version = this.facade.version;
		if (this._treeCache?.version === version) {
			return this._treeCache;
		}
		const doc = this.facade.project();
		const index = new Map<string, ProjectedBlock>();
		const walk = (nodes: ProjectedBlock[]) => {
			for (const node of nodes) {
				index.set(node.id, node);
				walk(node.children);
			}
		};
		walk(doc.children);
		this._treeCache = { version, doc, index };
		return this._treeCache;
	};

	/** Full projected subtree of a visible block id (null when hidden/deleted). */
	projectedBlock = (blockId: string): ProjectedBlock | null =>
		this._projectedTree().index.get(blockId) ?? null;

	/** Projected children of `parent` (`null` = root). */
	projectedChildren = (parent: string | null): ProjectedBlock[] => {
		const tree = this._projectedTree();
		if (parent === null) {
			return tree.doc.children;
		}
		return tree.index.get(parent)?.children ?? [];
	};

	/**
	 * Incremental mirror apply — patch the wrapper tree from one committed
	 * {@link DocChange} instead of re-projecting + re-reconciling the whole
	 * document (~5ms project + O(doc) reconcile at 5k blocks, per commit).
	 *
	 * The DocChange contract (same one `src/tests/crdt/doc/mirror.test.ts`
	 * builds a convergent mirror from): `order` lists are authoritative for
	 * every parent whose visible children changed, `added` roots carry their
	 * full projected subtree, `removed` ids and every visible child a commit
	 * re-placed elsewhere is claimed by an `order` list. That makes the
	 * change self-contained — no projected index needed.
	 *
	 * Returns false when an id the change references cannot be resolved
	 * from the current mirror (divergence — e.g. a missed event while the
	 * subscription was detached): the caller then falls back to the full
	 * `reconcileChildren(projectedChildren(null))` path, which converges
	 * regardless of history.
	 */
	private applyMirrorChange = (change: DocChange): boolean => {
		const root = this.root;
		if (!root) {
			return true;
		}

		// `claimed` = every id listed by a changed parent's new child list —
		// the change's own "still visible" oracle. Protects children moved
		// out of a doomed subtree (see `_drop(keep)`) and fast-paths the
		// per-parent drop check before the `facade.positionOf` fallback.
		const claimed = new Set<string>();
		for (const ids of change.order.values()) {
			for (const id of ids) {
				claimed.add(id);
			}
		}

		// Ids inside an `added` subtree — resolvable once the subtree root is
		// placed by its parent's order entry (the projected node carries
		// descendants, so covered ids never need individual patches).
		const addedIds = new Set<string>();
		const collectAdded = (node: ProjectedBlock) => {
			addedIds.add(node.id);
			for (const child of node.children) {
				collectAdded(child);
			}
		};
		for (const node of change.added.values()) {
			collectAdded(node);
		}

		// Mirror-side ids inside a `removed` subtree — collected off the
		// pre-change wrapper tree, before any drop mutates it.
		const doomed = new Set<string>();
		const collectDoomed = (block: Block) => {
			doomed.add(block.id);
			for (const child of block.children) {
				if (!claimed.has(child.id)) {
					collectDoomed(child);
				}
			}
		};
		for (const id of change.removed) {
			const wrapper = this.idToBlock.get(id);
			if (wrapper) {
				collectDoomed(wrapper);
			}
		}

		// Preflight — every id the apply below dereferences must resolve
		// without the projected index, or be provably covered by an
		// added/removed subtree. Anything else ⇒ mirror diverged from the
		// diff stream ⇒ caller runs the full reconcile instead.
		for (const [parentId, ids] of change.order) {
			if (
				parentId !== null &&
				!this.idToBlock.has(parentId) &&
				!addedIds.has(parentId) &&
				!doomed.has(parentId)
			) {
				return false;
			}
			for (const id of ids) {
				if (!this.idToBlock.has(id) && !this._pendingBlocks.has(id) && !addedIds.has(id)) {
					return false;
				}
			}
		}
		for (const id of change.meta.keys()) {
			if (!this.idToBlock.has(id)) {
				return false;
			}
		}
		for (const id of change.content.keys()) {
			if (!this.idToBlock.has(id)) {
				return false;
			}
		}

		// Removed subtree roots — the claimed-aware cascade keeps children
		// this same commit re-placed elsewhere.
		const keepAlive = (id: string) => claimed.has(id);
		for (const id of change.removed) {
			this.idToBlock.get(id)?._drop(keepAlive);
		}

		// Changed parents — each new child list is authoritative; mirrors
		// `reconcileChildren` (reuse by id → pending adoption → create).
		for (const [parentId, ids] of change.order) {
			const parent = parentId === null ? root : this.idToBlock.get(parentId);
			if (!parent) {
				// Parent inside an added subtree (built with its root) or
				// removed with an ancestor — validated by the preflight.
				continue;
			}
			const prev = parent.children;
			const used = new Set<Block>();
			let degraded = false;
			const next: Block[] = [];
			ids.forEach((id) => {
				let child = this.idToBlock.get(id);
				const pending = this._pendingBlocks.get(id);
				this._pendingBlocks.delete(id);
				if (!child && pending) {
					child = pending;
				}
				const addedNode = change.added.get(id);
				if (!child && !addedNode) {
					degraded = true; // preflight-guaranteed unreachable — guard anyway
					return;
				}
				if (!child) {
					child = new Block({ parent, edytor: this, blockId: id });
				}
				child._bind(id, parent);
				child.parent = parent;
				used.add(child);
				if (addedNode) {
					// `added` roots carry the full projected subtree — the same
					// `_reconcile` the full path runs for them.
					child._reconcile(addedNode);
				}
				next.push(child);
			});
			if (degraded) {
				return false;
			}
			for (const old of prev) {
				if (
					!used.has(old) &&
					old._live &&
					!claimed.has(old.id) &&
					!this.facade.isVisibleBlock(old.id)
				) {
					old._drop(keepAlive);
				}
			}
			parent.children = next;
		}

		for (const [id, meta] of change.meta) {
			this.idToBlock.get(id)?._reconcileMeta(meta.type, meta.data);
		}
		for (const [id, items] of change.content) {
			this.idToBlock.get(id)?.reconcileContent(items);
		}
		return true;
	};

	/**
	 * Reconcile the wrapper tree with the projected tree. Called by the facade
	 * onChange dispatch on every commit, and directly by the typed mutation
	 * surface (`insertChildren`/`insertParts`/`deleteParts`/…) after an op so
	 * intra-transaction mirror reads (`parent.children`, `content`) stay fresh.
	 *
	 * Commit dispatch carries the committed {@link DocChange} in
	 * `_mirrorChange` — the incremental path patches only touched blocks.
	 * Direct mid-transaction calls (`_mirrorChange === null`) keep the full
	 * projected reconcile: `project()` reflects uncommitted same-transaction
	 * writes, which DocChange deltas (commit-boundary only) cannot.
	 */
	/**
	 * Scoped stale-placeholder repair. The commit queues only the block
	 * roots its {@link DocChange} touched — `content` (text composition
	 * changed: the only way a placeholder becomes stale or needed),
	 * `moved`/`meta` (re-parented or re-typed subtrees render their content
	 * under a new context), and `added` subtree roots (freshly placed —
	 * their projected descendants render inside the root's node). Each id
	 * resolves lazily through `idToBlock`, so a `{#key}` remount between
	 * commit and pass retargets the FRESH node instead of scanning a
	 * detached one; `removed` ids are detached by definition and skipped.
	 *
	 * When the mirror fell back to a full reconcile (`applyMirrorChange`
	 * returned false — divergence the diff can't describe), the affected
	 * set is unknowable from the change: scope the pass to the editor root
	 * once, still through the same coalesced window.
	 */
	private queuePlaceholderRepair = (change: DocChange, mirrorWasIncremental: boolean) => {
		const repair = this.placeholderRepair;
		if (!mirrorWasIncremental) {
			repair.addKeyed('edytor:root', () => this.node);
			return;
		}
		const addBlock = (id: string) =>
			repair.addKeyed(`block:${id}`, () => this.idToBlock.get(id)?.node ?? undefined);
		for (const id of change.content.keys()) {
			addBlock(id);
		}
		for (const id of change.moved) {
			addBlock(id);
		}
		for (const id of change.meta.keys()) {
			addBlock(id);
		}
		for (const id of change.added.keys()) {
			addBlock(id);
		}
	};

	/** Bumped by every mirror flush: wrappers are looked up again after it. */
	mirrorRevision = 0;
	flushMirror = (): boolean => {
		if (!this.root) {
			return true;
		}
		const change = this._mirrorChange;
		const applied = change !== null && this.applyMirrorChange(change);
		if (!applied) this.root.reconcileChildren(this.projectedChildren(null));
		this.mirrorRevision++;
		// Remote/programmatic kills (`_drop`/`reconcileContent`) never run
		// `_setItems` on the caret's wrapper — repair a selection that no
		// longer resolves. (`this.selection` is undefined during the
		// constructor's first sync — nothing is selected yet anyway.)
		this.selection?.restoreDeadSelectionEndpoints();
		if (applied) return true;
		// `change === null` (a mid-transaction flush for read-your-writes)
		// still ran the incremental-safe path — no DocChange exists, so
		// nothing needed scoping; report incremental. Only a real change
		// that failed to apply reports a fallback.
		return change === null;
	};

	onBeforeInput = onBeforeInput.bind(this);
	onCopy = onCopy.bind(this);
	onCut = onCut.bind(this);
	onInput = onInput.bind(this);
	onPaste = onPaste.bind(this);
	/**
	 * Mark the synchronous extent of a real user-input event — see
	 * `isHandlingUserInput`. Deferred (rAF/timeout) work intentionally
	 * runs with the flag cleared so async restores can't trigger typing
	 * affordances long after the gesture ended.
	 */
	private userInputHandlingDepth = 0;
	private withUserInput = <E extends Event>(
		handler: (event: E) => unknown,
		opts: { bumpSerial?: boolean } = {}
	) => {
		return (event: E): unknown => {
			// Depth-counted, not boolean: a synchronous wrapped listener
			// landing inside an awaited handler's hold window must not
			// clear the flag the outer handler still needs.
			this.userInputHandlingDepth++;
			this.isHandlingUserInput = true;
			if (opts.bumpSerial !== false) {
				this.markUserGesture();
			}
			const clear = () => {
				this.userInputHandlingDepth--;
				if (this.userInputHandlingDepth <= 0) {
					this.userInputHandlingDepth = 0;
					this.isHandlingUserInput = false;
				}
			};
			try {
				const result = handler(event);
				// Async handlers keep the flag until they settle — the
				// awaited model ops + selection writes are still "the
				// user's input". Timer/rAF-deferred restores run after
				// settlement and stay unflagged.
				if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
					// A failed async handler (a command's hook or write) surfaces
					// through the platform's error reporting; the DOM ignores
					// the listener's promise.
					void Promise.resolve(result)
						.finally(clear)
						.catch((error) =>
							typeof reportError === 'function' ? reportError(error) : console.error(error)
						);
				} else {
					clear();
				}
				return result;
			} catch (error) {
				clear();
				throw error;
			}
		};
	};
	/**
	 * Bump the gesture serial without claiming input handling — pointer
	 * and focus gestures don't write model text, but they must disarm
	 * pending deferred selection restores. Public so event modules
	 * (onKeyDown) can mark real keys AFTER swallow checks — a swallowed
	 * phantom composition key is not a gesture.
	 */
	markUserGesture = () => {
		this.intentSerial++;
	};
	/**
	 * The next `focusin` was caused by the editor's own `.focus()` call —
	 * a selection write refocusing its text host is programmatic
	 * housekeeping, not a user gesture. Armed immediately before the
	 * call; `focusin` dispatches synchronously inside it, so the flag is
	 * consumed there; the microtask reset covers a focus that never
	 * fires (element already focused).
	 */
	private expectInternalFocusArmed = false;
	expectInternalFocus = () => {
		this.expectInternalFocusArmed = true;
		queueMicrotask(() => {
			this.expectInternalFocusArmed = false;
		});
	};
	/**
	 * The one gesture serial (Surface bookkeeping, L8): pointer, focus, key,
	 * `beforeinput`, cut, paste and drop bump it; an `input` does not (it
	 * records what the browser did, not where the user wants the selection).
	 * Attempts are per occurrence (`attempts`), not counted here.
	 */
	intentSerial = 0;
	/**
	 * The last pointerdown landed outside the editor (or focus moved to a
	 * relatedTarget outside it) — subsequent focus/selection state is
	 * user-owned until an inside gesture or focusin returns it. Repair
	 * restores must not steal it back. This is deliberately DOM evidence,
	 * not a gesture count: a foreign mutation that blurs the editor (e.g.
	 * removing `contenteditable` from the root) produces the same
	 * focusout signal as a user blur but must still be repaired.
	 */
	lastUserGestureOutsideEditor = false;
	/** Run `body` as part of the user's input (deferred work of an occurrence). */
	userInput = <T>(body: () => T) =>
		this.withUserInput(body, { bumpSerial: false })(new Event('input'));
	/**
	 * A commit's caret: select it (the projector displays it once the pin's
	 * render lands) and arm the IME post-commit jump rule — a move right after
	 * the commit with no gesture since is displayed back (`surface/projector`).
	 */
	stabilizeCompositionSelection = async (textOrId: Text | string, offset: number) => {
		const text = this.getTextById(typeof textOrId === 'string' ? textOrId : textOrId.id);
		if (this.readonly || this.isComposing || !text) return;
		const active = getActiveElement(this.node);
		const selection = getDomSelection(this.node);
		const ours = (node?: Node | null) => Boolean(node && this.node?.contains(node));
		// Focus left for a foreign element with no selection of ours, or moved
		// into a nested editable island (its own caret): the user owns it.
		if (
			(active &&
				!ours(active) &&
				!ours(selection?.anchorNode) &&
				!ours(this.selection.state.startText?.node)) ||
			(active && isNestedForeignEditableTarget(this.node, active))
		)
			return;
		this.projector.committed();
		await this.selection.setAtTextOffset(text, Math.min(offset, text.length));
	};
	/** An event of this view's own composition (not a native control's, not a nested island's). */
	private ownComposition = (event?: Event) =>
		!event ||
		(!isNativeInteractiveEvent(event) && !isNestedForeignEditableTarget(this.node, event.target));

	onCompositionStart = (event?: CompositionEvent) => {
		if (!this.ownComposition(event)) return;
		this.selection.applySelectionSnapshot(getDomSelectionSnapshot(this.node));
		this.composition.start();
	};

	/** `compositionend`: the live session's commit, or its explicit cancel; the tail swallows a late one. */
	onCompositionEnd = (event?: CompositionEvent) => {
		if (!this.ownComposition(event) || this.readonly) return;
		const value = event?.data ?? this.composition.preview;
		if (value) this.composition.commit(value);
		else this.composition.cancel();
	};

	/** Phantom structural keys the composition tail swallowed (a test oracle). */
	get postCompositionGuardSwallows() {
		return this.composition.swallows;
	}

	deleteContentWithinSelection = batch(
		'deleteContentWithinSelection',
		deleteContentWithinSelection,
		prepareDeleteContent
	);

	insertFlow = batch('insertFlow', insertFlow, prepareFlow);

	deleteBlocks = batch('deleteBlocks', deleteBlocks, prepareDeleteBlocks);

	getTextById = (id: string) => {
		const isText = id.startsWith('t');
		if (!isText) {
			throw new Error('Invalid id, expected text id');
		}

		return this.idToText.get(id);
	};

	clear = () => {
		const newBlock = this.transact(() => {
			const root = this.root!;
			root.deleteChildren(0, root.children.length);
			const block = new Block({
				edytor: this,
				parent: this.root,
				block: {
					type: this.defaultChild(root)
				}
			});
			root.insertChildren(root.children.length, [block]);
			return block;
		});
		this.refreshEditorDom();
		void this.selection.setAtTextOffset(newBlock.firstText ?? this.root?.children[0]?.firstText, 0);
		void tick().then(() => {
			this.expectInternalFocus();
			this.node?.focus({ preventScroll: true });
			this.selection.display();
		});
	};

	attach = (node: HTMLDivElement) => {
		let lastPointerDownInsideEditorAt = Number.NEGATIVE_INFINITY;
		// A remount must not inherit a stale "user is outside" verdict —
		// ownership is re-derived from live gestures from here on.
		this.lastUserGestureOutsideEditor = false;

		const selectionIsInsideEditor = () => {
			const selection = getDomSelection(node);
			return Boolean(
				selection?.anchorNode &&
				(node.contains(selection.anchorNode) ||
					(selection.focusNode && node.contains(selection.focusNode)))
			);
		};

		const clearNativeSelectionAfterExternalFocus = () => {
			const activeElement = getActiveElement(node);
			if (activeElement instanceof Node && node.contains(activeElement)) {
				return;
			}
			if (selectionIsInsideEditor()) {
				clearDomSelection(node);
			}
		};

		const handleFocusOut = (event: FocusEvent) => {
			if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) {
				return;
			}
			// Focus leaving abandons a live composition: the browser committed what it shows.
			this.composition.abandon();
			setTimeout(clearNativeSelectionAfterExternalFocus);
		};

		const clearAttachedNativeState = () => {
			if (selectionIsInsideEditor()) {
				clearDomSelection(node);
			}

			const activeElement = getActiveElement(node);
			if (activeElement instanceof HTMLElement && node.contains(activeElement)) {
				activeElement.blur();
			}
		};

		const restoreCachedSelectionAfterKeyboardFocus = (event: FocusEvent) => {
			if (this.readonly || event.target !== node) {
				return;
			}

			if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) {
				return;
			}

			if (getEventTimeStamp(event) - lastPointerDownInsideEditorAt < 250) {
				return;
			}

			const text = this.selection.state.startText;
			if (!text) {
				return;
			}

			const textId = text.id;
			const offset = this.selection.state.yStart;
			const applyMeaningfulDomSelection = () => {
				const selection = getDomSelectionSnapshot(node);
				if (!selection?.anchorNode || !selection.focusNode) {
					return false;
				}

				if (!node.contains(selection.anchorNode) || !node.contains(selection.focusNode)) {
					return false;
				}

				const anchorText = this.selection.getTextOfNode(selection.anchorNode);
				const focusText = this.selection.getTextOfNode(selection.focusNode);
				if (!anchorText || !focusText) {
					return false;
				}

				const isBrowserFocusReset =
					selection.isCollapsed &&
					anchorText === this.root?.firstEditableText &&
					getYIndex(anchorText, selection.anchorNode, selection.anchorOffset) === 0;
				if (isBrowserFocusReset) {
					return false;
				}

				this.selection.applySelectionSnapshot(selection);
				return true;
			};
			const restore = async () => {
				if (getActiveElement(node) !== node) {
					return;
				}

				if (applyMeaningfulDomSelection()) {
					return;
				}

				const s = this.selection.state;
				// A remote delivery or command may have legitimately moved the
				// selection since the focus-time capture — the CURRENT state
				// owns the caret then; writing the cached point would yank it
				// back to a pre-update position. The cache only wins while the
				// state still equals it, or when the browser collapsed the
				// caret to its focus-reset spot (first editable text at 0).
				if (!s.isCollapsed || !s.startText) {
					return;
				}
				const unchanged = s.startText.id === textId && s.yStart === offset;
				const focusReset = s.startText === this.root?.firstEditableText && s.yStart === 0;
				const targetText = unchanged || focusReset ? this.idToText.get(textId) : s.startText;
				const targetOffset = unchanged || focusReset ? offset : s.yStart;
				if (!targetText?.node?.isConnected) {
					return;
				}

				await this.selection.setAtTextOffset(targetText, Math.min(targetOffset, targetText.length));
			};

			queueMicrotask(() => {
				void restore();
			});
		};

		const handlePointerDown = (event: PointerEvent) => {
			lastPointerDownInsideEditorAt = getEventTimeStamp(event);
			this.selection.clearModelSelectionPreservation();
			this.selection.capturePointerDragStart(event);
			this.selection.clearInlineBlockSelection();
			this.selection.collapseSelectedBlocksAtPointer(event);
		};

		const handlePointerUp = (event: PointerEvent) => {
			this.selection.restoreInlineAtomDragRange(event);
		};

		this.node = node;
		this.container = node;
		// The attach destroy path drains `this.off`, which carries the facade
		// change sub's unsubscribe — re-establish it on every (re)attach.
		this.ensureFacadeChangeSub();
		this.selection.init();
		this.doc.on('beforeTransaction', this.projector.before);
		this.doc.on('afterTransaction', this.projector.after);
		this.off.push(() => {
			this.doc.off('beforeTransaction', this.projector.before);
			this.doc.off('afterTransaction', this.projector.after);
		});
		// Keydown serial bumps happen INSIDE onKeyDown, after the
		// composition-phantom swallow — a swallowed trailing Enter/Backspace
		// is a browser artifact, not a gesture, and must not disarm pending
		// composition caret restores.
		const keydown = this.withUserInput(onKeyDown.bind(this), { bumpSerial: false });
		const domMutationObserver = (this.observer = observeDomTextMutations(this, node));
		this.projector.recordsPending = domMutationObserver.pending;
		this.off.push(
			// One handler per keyboard occurrence: keys inside the editor at
			// capture; the document sees only keys whose path misses it (a
			// block selection with focus on the body).
			on(node, 'keydown', keydown, { capture: true }),
			on(node.ownerDocument, 'keydown', (event: KeyboardEvent) => {
				if (!event.composedPath().includes(node)) keydown(event);
			}),
			// Any pointerdown anywhere disarms pending restores — Firefox
			// can move the DOM selection on outside clicks without
			// blurring the editor, so node-local marking is not enough. The
			// target also records where the gesture landed: an outside
			// pointerdown means the current focus/selection is user-owned
			// until an inside gesture or focusin returns it.
			on(
				node.ownerDocument,
				'pointerdown',
				(event: PointerEvent) => {
					this.markUserGesture();
					this.lastUserGestureOutsideEditor = Boolean(
						event.target instanceof Node && !this.node?.contains(event.target)
					);
				},
				{ capture: true }
			),
			on(node, 'pointerdown', (event: PointerEvent) => {
				this.markUserGesture();
				// A pointer gesture abandons a live composition (D-7).
				this.composition.abandon();
				handlePointerDown(event);
			}),
			on(node, 'pointerup', (event: PointerEvent) => {
				this.markUserGesture();
				handlePointerUp(event);
			}),
			// A drag released OUTSIDE the editor never reaches the node-level
			// pointerup — without this `pointerDragStart` stays armed forever
			// and remote-edit restores would stay suppressed.
			on(node.ownerDocument, 'pointerup', () => {
				this.markUserGesture();
				this.selection.clearPointerDragStart();
			}),
			on(node.ownerDocument, 'pointercancel', () => {
				this.selection.clearPointerDragStart();
			}),
			on(node, 'mousedown', this.selection.preventNativeTripleClick),
			on(node, 'click', this.selection.handleTripleClick),
			// Settle queued mutation repairs before the native menu opens —
			// spellcheck suggestions are computed against the DOM at this
			// moment (PM flushes its DOM observer on contextmenu for the
			// same reason).
			on(node, 'contextmenu', () => void domMutationObserver.flushNow()),
			on(node, 'beforeinput', this.withUserInput(this.onBeforeInput)),
			// An `input` records what the browser did; it says nothing new about
			// where the user wants the selection (a display still to land wins).
			on(node, 'input', this.withUserInput(this.onInput, { bumpSerial: false })),
			on(node, 'copy', this.onCopy),
			on(node, 'cut', this.withUserInput(this.onCut)),
			on(node, 'paste', this.withUserInput(this.onPaste)),
			on(node, 'dragover', preventUnsupportedDrop),
			on(
				node,
				'drop',
				this.withUserInput((event: DragEvent) => preventUnsupportedDrop(event, this))
			),
			on(node, 'focusin', (event: FocusEvent) => {
				// Focus arriving back inside the editor re-establishes editor
				// ownership of the selection.
				this.lastUserGestureOutsideEditor = false;
				// The editor's own programmatic `focus()` calls (selection
				// writes refocus the text host) also fire focusin — with a
				// relatedTarget already inside the editor they're internal
				// housekeeping, not user gestures. Click-driven focus returns
				// are already marked by the document-level pointerdown capture.
				if (this.expectInternalFocusArmed) {
					// The projector focused the host for its own display: nothing to restore.
					this.expectInternalFocusArmed = false;
					return;
				}
				if (!(event.relatedTarget instanceof Node && this.node?.contains(event.relatedTarget))) {
					this.markUserGesture();
				}
				restoreCachedSelectionAfterKeyboardFocus(event);
			}),
			on(node, 'focusout', (event: FocusEvent) => {
				// Focus moving to a concrete element outside the editor is the
				// same user evidence as an outside pointerdown — mark the
				// gesture. A blur with NO relatedTarget is different: either
				// the focused node was detached by a render (e.g. the undo's
				// own DOM update replacing the caret's text — programmatic
				// churn that must not disarm a pending restore) or an OS/window
				// blur (restoring a caret in a blurred editor is harmless —
				// the selection holds until focus returns). Outside clicks
				// were already marked by the pointerdown capture listener.
				if (event.relatedTarget instanceof Node && !node.contains(event.relatedTarget)) {
					this.markUserGesture();
					this.lastUserGestureOutsideEditor = true;
				}
				handleFocusOut(event);
			}),
			on(node, 'compositionstart', this.onCompositionStart),
			on(node, 'compositionend', this.onCompositionEnd),
			domMutationObserver.destroy
		);

		this.plugins.forEach((plugin) => {
			const action = plugin.onEdytorAttached?.({ node });
			action && this.off.push(action);
		});

		return {
			destroy: () => {
				clearAttachedNativeState();
				this.selection.destroy();
				this.attempts.clear();
				this.composition.reset();
				// Drain AND clear: `attach` re-runs on every `{#key
				// editorDomRevision}` remount — leaving the spent batch in place
				// would retain ~18 dead closures (+ the detached editor DOM
				// subtree they close over) per remount and re-run them on every
				// later destroy. The facade-change release is in this batch —
				// `ensureFacadeChangeSub` re-establishes it on the next attach.
				this.off.splice(0).forEach((off) => off());
			}
		};
	};

	/**
	 * Edytor-lifetime teardown. `Edytor.svelte` owns the instance and calls
	 * this from its `onMount` cleanup; consumers holding a bare `Edytor`
	 * (test harnesses, custom mounts, dialogs/tabs/multi-editor views) must
	 * call it when the editor is discarded.
	 *
	 * Releases every listener the editor holds on potentially-SHARED objects
	 * — an injected doc/awareness outlives a single editor, so an
	 * undestroyed mount leaks a facade `update` listener and the undo
	 * manager's doc observers forever.
	 *
	 * Idempotent, and safe on an editor that was never attached or synced
	 * (the undo manager exists only after first `sync()`).
	 */
	destroyed = false;
	/** The key of this view's presence entry — minted here, written only by this view (R1). */
	readonly presenceKey = mintPresenceKey();
	destroy = () => {
		if (this.destroyed) {
			return;
		}
		this.destroyed = true;
		// This view's presence entry — its own key, cleared by its own teardown (R1).
		publishPresence(this.awareness, this.presenceKey, null);

		// A pending readiness binding must not resurrect a dead view.
		this._readinessRelease?.();
		this._readinessRelease = undefined;

		// Runs the whole attach-lifetime batch — DOM listeners, the mutation
		// observer, plugin actions, and the facade-change release (which
		// clears `_facadeChangeOff`) — and empties the array.
		this.off.splice(0).forEach((off) => off());
		this.history.unbind();

		// `selectionchange` listener + the published remote caret.
		this.selection.destroy();

		this.attempts.clear();
		this.composition.reset();
		// Pending placeholder-repair passes (microtask/rAF/timers) must
		// never act on a destroyed view — release kills them all.
		this.placeholderRepair.release();

		// Wrapper maps — drop every id/node→wrapper edge a shared doc or a
		// stray mutation could still reach.
		this.idToBlock.clear();
		this.idToInlineBlock.clear();
		this.nodeToInlineBlock.clear();
		this.idToText.clear();
		this.nodeToText.clear();
		this._pendingBlocks.clear();
		this.root = undefined;
		this.node = undefined;
		this.container = undefined;

		// Release this view's local-edit origin from the document's
		// history — the tracked set is consulted live at commit time, so
		// already-captured stack items stay undoable while future commits
		// from this dead view's origin stop capturing (a live sibling
		// document stops holding the dead origin; on a destroyed document
		// the call is a no-op).
		this.document.untrackOrigin(this.transaction);

		// Document-lifetime resources (undo manager, facade/runs lease,
		// awareness, doc) belong to the document — released exactly once,
		// and only when THIS view created it. A borrowed document keeps
		// serving its sibling views and headless consumers.
		if (this.ownsDocument) {
			this.document.destroy();
		}
	};
}

export const useEdytor = () => {
	const hasEdytorContext = hasContext('edytor');

	if (hasEdytorContext) {
		return getContext<Edytor>('edytor');
	}
	throw new Error('No Edytor found');
};
