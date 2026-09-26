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
import { setSuppressedInputRepairSelectionTarget } from './events/beforeInputRepairTarget.js';
import { type JSONBlock, type JSONDoc, type SerializableContent } from '$lib/utils/json.js';
import { onKeyDown } from '$lib/events/onKeyDown.js';
import { EdytorSelection, type TextAnchor } from './selection/selection.svelte.js';
import { Block } from './block/block.svelte.js';
import { Text } from './text/text.svelte.js';
import { SvelteMap } from 'svelte/reactivity';
import { Y } from '$lib/crdt/engine.js';
import {
	attachDocument,
	bindCrdt,
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
import { batch } from './block/block.utils.js';
import {
	canMoveBlocks as canMoveBlocksRelative,
	moveBlocks as moveBlocksRelative,
	type BlockMoveRequest
} from './block/blockMove.js';
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
import { HotKeys, type HotKey } from './hotkeys.js';
import { TRANSACTION } from './constants.js';
import type { InlineBlock } from './block/inlineBlock.svelte.js';
import { deleteContentWithinSelection } from './edytor.utils.js';
import {
	getSelectionReplacementState,
	replaceSelectedBlocksWithEmptyBlockTarget,
	replaceSelectionWithCollapsedTarget,
	type SelectionReplacementState
} from './selection/replaceSelection.js';
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
 * Mirror-shape adapter for the canonical `facade.toJSON()` export (S6):
 * the wrapper mirror's `InlineBlock.value` historically emitted `data`
 * even when empty (`{}`), while the canonical export omits absent `data`.
 * Re-adding `data: {}` to data-less inline atoms keeps `edytor.value` /
 * `onChange` payloads byte-identical to the serialization they replaced.
 */
const withMirrorInlineData = (blocks: JSONBlock[]): JSONBlock[] =>
	blocks.map((block) => {
		const content = block.content?.map((part) =>
			'type' in part && part.data === undefined ? { ...part, data: {} } : part
		);
		const children = block.children ? withMirrorInlineData(block.children) : undefined;
		return {
			...block,
			...(content ? { content } : {}),
			...(children ? { children } : {})
		};
	});

const isAppleWebKitBrowser = () => {
	if (typeof navigator === 'undefined') {
		return false;
	}

	const userAgent = navigator.userAgent;
	return (
		/AppleWebKit/i.test(userAgent) && !/(Chrome|Chromium|Edg|OPR|SamsungBrowser)/i.test(userAgent)
	);
};

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

export class Edytor {
	node?: HTMLElement;
	marks = new Map<string, MarkDefinition>();
	blocks = new Map<string, BlockDefinition>();
	inlineBlocks = new Map<string, InlineBlockDefinition>();
	commands = new Map<string, EditorCommand>();
	plugins: InitializedPlugin[];
	container = $state<HTMLDivElement>();
	idToBlock = new SvelteMap<string, Block>();
	idToInlineBlock = new SvelteMap<string, InlineBlock>();
	nodeToInlineBlock = new SvelteMap<Node, InlineBlock>();
	idToText = new SvelteMap<string, Text>();
	nodeToText = new SvelteMap<Node, Text>();
	transaction = new TRANSACTION();
	hotKeys: HotKeys;
	readonly = $state(false);
	root = $state<Block>();
	editorDomRevision = $state(0);
	synced = $state(false);
	edytor = this;
	selection: EdytorSelection;
	defaultType = 'paragraph';
	private off: (() => void)[] = [];
	private onChange?: (value: JSONBlock) => void;
	placeholder?: string | Snippet<[{ block: Block }]>;
	compositionState: {
		textId: string;
		startOffset: number;
		value: string;
		marks?: Record<string, SerializableContent | null>;
		/**
		 * Model atoms the composition region currently occupies — normally
		 * `value.length`, grown by `_syncCompositionRegion` when a
		 * remote/programmatic edit lands INSIDE the region. Region deletes
		 * use this so absorbed remote text is clobbered at commit instead
		 * of corrupting surrounding content (reads in files that can't take
		 * the anchor surface fall back to `value.length`).
		 */
		regionLength?: number;
		/**
		 * CRDT anchors bounding the composition region — resolved through
		 * remote edits by `resolveCompositionRegion` so commit offsets
		 * track the atoms the preview occupies while the DOM stays pinned.
		 * `start` binds right (inserts at the region edge land outside),
		 * `end` binds left.
		 */
		startAnchor?: TextAnchor | null;
		endAnchor?: TextAnchor | null;
		restoreSelectionAfterCommit?: {
			textId: string;
			offset: number;
		};
	} | null = null;
	compositionStartReplacementState: SelectionReplacementState | null = null;
	isComposing = $state(false);
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
	 * Internal render churn — incremented whenever the engine is about to
	 * mutate DOM that could re-park a live caret (text span remounts,
	 * in-place text-node rewrites, endpoint attach/destroy). Read by the
	 * selection layer, which baselines it per user gesture: a
	 * `selectionchange` echo arriving at an unchanged gesture serial while
	 * churn has advanced past the baseline is browser caret re-parking —
	 * drift to revert — not a user decision to derive.
	 */
	domSelectionChurnSeq = 0;
	markDomSelectionChurn = () => {
		this.domSelectionChurnSeq++;
		(globalThis as { __selDrift?: unknown[] }).__selDrift?.push({
			n: ((globalThis as { __selN?: number }).__selN =
				((globalThis as { __selN?: number }).__selN ?? 0) + 1),
			kind: 'churn',
			seq: this.domSelectionChurnSeq
		});
	};
	/**
	 * The wrapper currently holding the composition render pin — set by
	 * `Text._acquireCompositionPin`, cleared by `_releaseCompositionPin`
	 * (or lazily when the pin drops). Lets commit/cancel paths release the
	 * pinned host even when `compositionState` was already cleared.
	 */
	_compositionHostText: Text | null = null;
	/**
	 * The wrapper whose DOM node currently hosts the live composition — the
	 * element the IME owns. Resolved through `idToText` so pending-wrapper
	 * id aliasing during reconcile keeps tracking the same node; during the
	 * compositionstart→first-beforeinput window (no `compositionState` yet)
	 * it falls back to the DOM-anchored selection text.
	 */
	get compositionText(): Text | null {
		const state = this.compositionState;
		if (state) {
			// Anchor-first: ids go stale when a remote/programmatic split
			// rebinds the wrapper (the DOM-key rename is deferred under the
			// pin), so the tracked region's atoms are the reliable source.
			return this.resolveCompositionRegion()?.text ?? this.getTextById(state.textId) ?? null;
		}
		return this.isComposing ? (this.selection.state.startText ?? null) : null;
	}
	/**
	 * Resolve the live composition region in MODEL space → `{text,
	 * startOffset, length}` — segment-local on the returned wrapper.
	 *
	 * The WRITE TARGET is always the tracked host — the wrapper whose DOM
	 * node the IME owns (`state.textId` follows `_bind` re-aliases, and the
	 * pin defers the DOM-key rename so the id keeps resolving). CRDT
	 * anchors only refine the OFFSETS, and only while they resolve onto
	 * that same wrapper — atoms migrating to another segment (remote
	 * split, insertParagraph interruption) keep the commit on the host the
	 * browser composed into, matching the pre-anchor commit semantics.
	 */
	resolveCompositionRegion = (): {
		text: Text;
		startOffset: number;
		length: number;
	} | null => {
		const state = this.compositionState;
		if (!state) {
			return null;
		}
		const tracked = this.getTextById(state.textId) ?? null;
		if (!tracked) {
			return null;
		}
		// Before the first re-anchor (e.g. a pin held from the
		// compositionstart window), the caret anchor on the pin still gives
		// the region start.
		const startAnchor = state.startAnchor ?? tracked._compositionPin?.caretAnchor ?? null;
		const start = startAnchor ? this.selection.resolveTextAnchor(startAnchor) : null;
		const end = state.endAnchor ? this.selection.resolveTextAnchor(state.endAnchor) : null;
		const startOffset = start && start.text === tracked ? start.offset : state.startOffset;
		const length =
			start && end && start.text === tracked && end.text === tracked
				? Math.max(0, end.offset - start.offset)
				: (state.regionLength ?? state.value.length);
		return { text: tracked, startOffset, length };
	};
	hasHandledCompositionInput = false;
	shouldSuppressNextInputFallback = false;
	shouldSuppressObservedMutationFallback = false;
	shouldRepairSuppressedInputFallback = false;
	shouldFlushSuppressedObservedMutationFallback = false;
	suppressedInputRepairSelectionTarget: { text: Text; offset: number } | null = null;
	browserOwnedInputTarget: {
		text: Text;
		offset: number;
		historyOffset?: number;
		inputType: InputEvent['inputType'];
		valueBeforeInput: string;
	} | null = null;
	private inputFallbackSuppressionTimer: ReturnType<typeof setTimeout> | null = null;
	private observedMutationFallbackSuppressionTimer: ReturnType<typeof setTimeout> | null = null;
	private inputFallbackRepairTimer: ReturnType<typeof setTimeout> | null = null;
	private structuralKeyFallbackTimer: ReturnType<typeof setTimeout> | null = null;
	structuralKeyFallbackInputType: InputEvent['inputType'] | null = null;
	private compositionSelectionRestoreFrame: number | null = null;
	private compositionSelectionRestoreTimers: ReturnType<typeof setTimeout>[] = [];
	/**
	 * Bumped by every real user-input gesture (beforeinput/keydown/paste/
	 * pointer/focus). Deferred composition-caret restores compare serials
	 * to tell the browser's spontaneous post-commit selection jump (which
	 * they exist to repair) apart from a genuine user gesture that must
	 * not be overwritten.
	 */
	private userGestureSerial = 0;
	private danglingCompositionBlurTimer: ReturnType<typeof setTimeout> | null = null;
	private compositionEndedAt = Number.NEGATIVE_INFINITY;

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

	transact = <T>(cb: () => T): T => {
		this.suppressObservedMutationFallback();
		return this.doc.transact(() => {
			const result = cb();
			return result;
		}, this.transaction);
	};

	/** Check whether a relative block move is structurally allowed. */
	canMoveBlocks = (request: BlockMoveRequest): boolean => canMoveBlocksRelative(this, request);

	/** Move blocks before, after, or inside a live target block. */
	moveBlocks = (request: BlockMoveRequest): Block[] => moveBlocksRelative(this, request);

	/**
	 * History commands through THIS view — the only undo/redo entry points
	 * that restore a view caret. The undo manager is document-shared, so
	 * its `stack-item-popped` fires on EVERY view's selection listener;
	 * `expectHistoryRestore` marks this view as the issuer for the
	 * synchronous duration of the command, and only that view consumes its
	 * per-view snapshot. Sibling views treat the pop as an ordinary
	 * document change — the same semantics a REMOTE peer's undo has (their
	 * carets ride normal reconciliation, never a snapshot recorded when
	 * the undone edit committed). `document.history.undo()` invoked
	 * headlessly restores no view's caret by the same rule.
	 */
	historyUndo = (): void => {
		this.runHistoryCommand(() => this.document.history.undo());
	};
	historyRedo = (): void => {
		this.runHistoryCommand(() => this.document.history.redo());
	};
	private runHistoryCommand = (command: () => unknown): void => {
		// The popped handler runs synchronously inside undo()/redo() — the
		// flag only needs to live for this call, never across async work.
		this.selection.expectHistoryRestore = true;
		try {
			command();
		} finally {
			this.selection.expectHistoryRestore = false;
		}
	};

	private deferredEditorDomRefresh: ReturnType<typeof setTimeout> | null = null;
	refreshEditorDom = () => {
		if (this.isComposing) {
			// `{#key editorDomRevision}` remounts the whole subtree — that
			// would destroy the DOM node the IME owns. Defer the remount to
			// the first tick after the composition ends (bounded: every exit
			// path — compositionend, dangling reset, idle-preview cancel —
			// flips `isComposing`).
			if (this.deferredEditorDomRefresh === null) {
				const attempt = () => {
					if (this.isComposing && this.node?.isConnected) {
						this.deferredEditorDomRefresh = setTimeout(attempt, 16);
						return;
					}
					this.deferredEditorDomRefresh = null;
					this.editorDomRevision += 1;
				};
				this.deferredEditorDomRefresh = setTimeout(attempt, 16);
			}
			return;
		}
		this.editorDomRevision += 1;
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
			// The document is the semantic authority — an injected document's
			// defaultType is inherited (a view cannot reshape it).
			this.defaultType = document.semantics.defaultType;
		} else {
			// Legacy path — the view internally owns a document composed
			// around the injected (or a fresh) doc/awareness.
			this.document = attachDocument(doc ?? new Y.Doc(), {
				awareness,
				semantics: { defaultType: this.defaultType }
			});
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
			// Initialize plugins
			this.plugins = (plugins || []).map((plugin) => {
				const initializedPlugin = plugin(this);

				initializedPlugin.marks &&
					Object.entries(initializedPlugin.marks).forEach(([key, snippet]) => {
						if (typeof snippet === 'object') {
							this.marks.set(key, snippet);
						} else {
							this.marks.set(key, { snippet });
						}
					});

				initializedPlugin.blocks &&
					Object.entries(initializedPlugin.blocks).forEach(([key, definition]) => {
						if (typeof definition === 'object') {
							this.blocks.set(key, definition);
						} else {
							this.blocks.set(key, { snippet: definition });
						}
					});
				initializedPlugin.inlineBlocks &&
					Object.entries(initializedPlugin.inlineBlocks).forEach(([key, definition]) => {
						if (typeof definition === 'object') {
							this.inlineBlocks.set(key, definition);
						} else {
							this.inlineBlocks.set(key, { snippet: definition });
						}
					});
				initializedPlugin.commands?.forEach((command) => {
					this.commands.set(command.id, command);
				});
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

			this.placeholder =
				placeholder || this.plugins.find((plugin) => plugin.placeholder)?.placeholder;

			// Contribute this view's plugin-implied structural roles to the
			// document — document-level semantics outlive any single view. The
			// first declaration for a type is adopted; a conflicting one is an
			// error (views cannot silently impose incompatible structural rules
			// on a shared document). Atomic: a conflict validates before ANY
			// role is applied, so a failed view cannot half-seed semantics.
			this.document.adoptSemantics({
				roles: Object.fromEntries(
					Array.from(this.blocks, ([type, definition]) => [
						type,
						{ void: definition.void, island: definition.island }
					])
				),
				defaultType: this.defaultType
			});

			// Enroll this view's local-edit origin in the document's history —
			// AFTER semantic adoption: a conflicting view must not strand a
			// tracked origin for a view that never came up. Identity tracking:
			// this document's undo manager captures THIS view's edits.
			this.document.trackOrigin(this.transaction);

			// Readiness ownership (adversarial P1-1): a `sync` prop on an
			// editable view means a PROVIDER owns the content decision —
			// for owned documents too. The view binds the readiness wait so
			// a terminal provider `failed` still hands the decision back
			// (`syncFailed && !syncPending` wakes `whenDocumentReady`);
			// without it a failed provider latched the view unsynced
			// forever. For an injected document the decision is the
			// document's: an already-decided document binds immediately;
			// a PENDING one defers — a sibling view must never seed
			// content a provider is about to hydrate.
			if (!readonly && sync) {
				this.bindReadiness(true, value);
			} else if (this.ownsDocument || this.document.ready) {
				this.sync(value || { children: [] });
			} else {
				this.bindReadiness(false, value);
			}

			this.selection = new EdytorSelection(this, onSelectionChange);
			this.hotKeys = new HotKeys(this, hotKeys, this.plugins);
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
			// `facade.toJSON()` is the canonical document export — one
			// serializer instead of a second mirror walk that could drift
			// (S6). `withMirrorInlineData` preserves the emitted shape.
			children: root ? withMirrorInlineData(this.facade.toJSON().children) : []
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

	getDefaultBlock = (
		parent: Block | Edytor | undefined = this.selection.state.startText?.parent
	) => {
		// The document is the semantic authority — `defaultType` mirrors
		// `document.semantics.defaultType` (adopted in the constructor) and
		// is the fallback when no parent-sensitive plugin override applies.
		if (!parent || parent instanceof Edytor) {
			return this.defaultType;
		}
		for (const plugin of this.plugins) {
			if (plugin.defaultBlock) {
				const defaultBlock =
					typeof plugin.defaultBlock === 'function'
						? plugin.defaultBlock(parent)
						: plugin.defaultBlock;
				if (defaultBlock) {
					return defaultBlock;
				}
			}
		}
		return this.defaultType;
	};

	/**
	 * Readiness binding for an injected PENDING document — installed in the
	 * constructor so headless views (no component mount) bind identically.
	 * `_readinessRelease` cancels the decision listener;
	 * `_readinessTimer` is the one-task deferral that lets a provider
	 * attached in the same synchronous mount flush win the seed.
	 */
	private _readinessRelease: (() => void) | undefined;
	private _readinessTimer: ReturnType<typeof setTimeout> | undefined;

	private bindReadiness = (wantsSync: boolean, value: JSONDoc | undefined) => {
		// Mirror the document's decision the moment it lands — whichever
		// path makes it (provider `synced`, or an explicit `document.sync`).
		this._readinessRelease = whenDocumentReady(this.document, () => {
			if (!this.destroyed && !this.synced) {
				this.sync(value || { children: [] });
			}
		});
		// An editable view carrying no `sync` prop IS the document's
		// explicit decision — but only while no provider is in flight
		// (`syncPending`: an attached-but-unsynced provider owns the seed).
		// Readonly and sync-carrying views never self-decide.
		if (!this.readonly && !wantsSync) {
			this._readinessTimer = setTimeout(() => {
				this._readinessTimer = undefined;
				if (
					this.destroyed ||
					this.synced ||
					this.document.destroyed ||
					this.document.ready ||
					this.document.syncPending
				) {
					return;
				}
				this.sync(value || { children: [] });
			}, 0);
		}
	};

	sync = ({ children = [] }: JSONDoc = { children: [] }) => {
		if (this.synced) {
			return;
		}

		// The document owns the content decision: `assertSchema` on an
		// already-initialized (hydrated) doc, `init` on a still-fresh one,
		// then history attaches — the same deferral this method enforced
		// when the view owned it.
		this.document.sync({ children });

		this.root = new Block({
			edytor: this,
			blockId: null
		});
		this.root.reconcileChildren(this.projectedChildren(null));
		// The root has no facade content node — give it the same empty-text
		// sentinel mirror shape blocks get so `root.content` invariants hold.
		this.root.reconcileContent([]);

		this.undoManager = this.document.history;
		this.synced = true;
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
			// ANY commit's render can churn the DOM under a live caret — the
			// browser re-parks it and the trailing selectionchange echo
			// re-mints anchors from the drifted spot (Gecko clamps to the
			// shortened node; Blink keeps the offset). Capture the anchored
			// selection now so the post-flush tick can re-assert DOM ← model
			// before the echo lands. Skip while a user-input flow is in
			// flight: there the DOM caret is the user's own write (autocorrect,
			// IME, drop) and the input path owns the final position — a
			// commit under it can legitimately slide the anchors, so a
			// model→DOM re-assert would fight the user's caret.
			const remoteSelectionCapture = this.isHandlingUserInput
				? null
				: (this.selection?.captureSelectionForRemoteApply() ?? null);
			(globalThis as { __selDrift?: unknown[] }).__selDrift?.push({
				n: ((globalThis as { __selN?: number }).__selN =
					((globalThis as { __selN?: number }).__selN ?? 0) + 1),
				kind: 'commit',
				local: change.local,
				captured: remoteSelectionCapture !== null
			});
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
			void tick().then(() => {
				this.queuePlaceholderRepair(change, mirrorWasIncremental);
				if (remoteSelectionCapture) {
					this.selection?.reconcileSelectionAfterRemoteApply(remoteSelectionCapture);
				}
			});
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

	flushMirror = (): boolean => {
		if (!this.root) {
			return true;
		}
		const change = this._mirrorChange;
		if (change && this.applyMirrorChange(change)) {
			// Remote/programmatic kills (`_drop`/`reconcileContent`) never run
			// `_setItems` on the caret's wrapper — re-anchor dead endpoints.
			// (`this.selection` is undefined during the constructor's first
			// sync — nothing is selected yet anyway.)
			this.selection?.restoreDeadSelectionEndpoints();
			return true;
		}
		this.root.reconcileChildren(this.projectedChildren(null));
		this.selection?.restoreDeadSelectionEndpoints();
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
					// `Promise.resolve` normalizes non-native thenables; the
					// chained `.catch` prevents a SECOND unhandled rejection —
					// the original promise still reports its own failure.
					void Promise.resolve(result)
						.finally(clear)
						.catch(() => {});
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
		this.userGestureSerial++;
		// Baseline churn at gesture-start so churn caused by the gesture's
		// own effects stays outstanding for later quiet-serial echoes.
		this.churnBaselineAtGesture = this.domSelectionChurnSeq;
		const driftLog = (globalThis as { __selDrift?: unknown[] }).__selDrift;
		if (driftLog) {
			driftLog.push({
				n: ((globalThis as { __selN?: number }).__selN =
					((globalThis as { __selN?: number }).__selN ?? 0) + 1),
				kind: 'gesture',
				serial: this.userGestureSerial,
				via: new Error().stack
					?.split('\n')
					.slice(2, 7)
					.map((l) => l.trim().split(' ')[1] ?? l.trim())
					.join('<')
			});
		}
	};
	/**
	 * `domSelectionChurnSeq` snapshotted when the last gesture began —
	 * see `restoreDriftedEchoCaret` in the selection layer.
	 */
	churnBaselineAtGesture = 0;
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
	 * Current gesture serial — compared by deferred caret restores
	 * against the serial armed at schedule time. A mismatch means a real
	 * user gesture (pointer, key, focus change) intervened and the
	 * pending restore must be disarmed.
	 */
	get gestureSerial() {
		return this.userGestureSerial;
	}
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
	batch = batch.bind(this);
	suppressNextInputFallback = (durationMs = 0) => {
		this.clearInputFallbackSuppression();
		this.shouldSuppressNextInputFallback = true;
		this.inputFallbackSuppressionTimer = setTimeout(() => {
			this.shouldSuppressNextInputFallback = false;
			this.inputFallbackSuppressionTimer = null;
		}, durationMs);
		this.suppressObservedMutationFallback(durationMs);
	};
	consumeNextInputFallbackSuppression = () => {
		const shouldRepair = this.shouldRepairSuppressedInputFallback;
		const shouldFlushObservedMutations = this.shouldFlushSuppressedObservedMutationFallback;
		this.shouldSuppressNextInputFallback = false;
		this.shouldRepairSuppressedInputFallback = false;
		const repairSelectionTarget = this.suppressedInputRepairSelectionTarget;
		this.suppressedInputRepairSelectionTarget = null;
		if (this.inputFallbackRepairTimer && !(shouldRepair && shouldFlushObservedMutations)) {
			clearTimeout(this.inputFallbackRepairTimer);
			this.inputFallbackRepairTimer = null;
		}
		if (shouldRepair && shouldFlushObservedMutations) {
			return repairSelectionTarget;
		}
		this.shouldFlushSuppressedObservedMutationFallback = false;
		this.suppressObservedMutationFallback();
		return repairSelectionTarget;
	};
	suppressObservedMutationFallback = (durationMs = 0) => {
		if (this.observedMutationFallbackSuppressionTimer) {
			clearTimeout(this.observedMutationFallbackSuppressionTimer);
		}
		this.shouldSuppressObservedMutationFallback = true;
		this.observedMutationFallbackSuppressionTimer = setTimeout(() => {
			this.shouldSuppressObservedMutationFallback = false;
			this.observedMutationFallbackSuppressionTimer = null;
		}, durationMs);
	};
	repairSuppressedInputFallback = (
		durationMs = 0,
		options: { flushObservedMutations?: boolean } = {}
	) => {
		if (this.inputFallbackRepairTimer) {
			clearTimeout(this.inputFallbackRepairTimer);
		}
		this.shouldRepairSuppressedInputFallback = true;
		this.shouldFlushSuppressedObservedMutationFallback = Boolean(options.flushObservedMutations);
		this.inputFallbackRepairTimer = setTimeout(() => {
			this.shouldRepairSuppressedInputFallback = false;
			this.shouldFlushSuppressedObservedMutationFallback = false;
			this.inputFallbackRepairTimer = null;
		}, durationMs);
	};
	clearInputFallbackSuppression = () => {
		if (this.inputFallbackSuppressionTimer) {
			clearTimeout(this.inputFallbackSuppressionTimer);
			this.inputFallbackSuppressionTimer = null;
		}
		if (this.observedMutationFallbackSuppressionTimer) {
			clearTimeout(this.observedMutationFallbackSuppressionTimer);
			this.observedMutationFallbackSuppressionTimer = null;
		}
		if (this.inputFallbackRepairTimer) {
			clearTimeout(this.inputFallbackRepairTimer);
			this.inputFallbackRepairTimer = null;
		}
		this.cancelStructuralKeyFallback();
		this.shouldSuppressNextInputFallback = false;
		this.shouldSuppressObservedMutationFallback = false;
		this.shouldRepairSuppressedInputFallback = false;
		this.shouldFlushSuppressedObservedMutationFallback = false;
		this.suppressedInputRepairSelectionTarget = null;
		this.browserOwnedInputTarget = null;
		this.structuralKeyFallbackInputType = null;
	};
	cancelStructuralKeyFallback = () => {
		if (this.structuralKeyFallbackTimer) {
			clearTimeout(this.structuralKeyFallbackTimer);
		}
		this.structuralKeyFallbackTimer = null;
		this.structuralKeyFallbackInputType = null;
	};
	scheduleStructuralKeyFallback = (inputType: InputEvent['inputType']) => {
		this.cancelStructuralKeyFallback();
		const selectionSnapshot = {
			startText: this.selection.state.startText,
			endText: this.selection.state.endText,
			yStart: this.selection.state.yStart,
			yEnd: this.selection.state.yEnd,
			isCollapsed: this.selection.state.isCollapsed,
			selectedBlocks: Array.from(this.selection.selectedBlocks)
		};
		this.suppressNextInputFallback(50);
		this.structuralKeyFallbackInputType = inputType;
		const fallbackTimer = setTimeout(() => {
			void (async () => {
				try {
					if (selectionSnapshot.selectedBlocks.length > 0) {
						this.selection.selectBlocks(...selectionSnapshot.selectedBlocks);
					} else if (selectionSnapshot.startText && selectionSnapshot.endText) {
						if (selectionSnapshot.isCollapsed) {
							await this.selection.setAtTextOffset(
								selectionSnapshot.startText,
								selectionSnapshot.yStart
							);
						} else {
							await this.selection.setAtRange(
								selectionSnapshot.startText,
								selectionSnapshot.yStart,
								selectionSnapshot.endText,
								selectionSnapshot.yEnd
							);
						}
					}

					// A real beforeinput or a newer structural key may have canceled
					// this fallback while the DOM selection was being restored.
					if (this.structuralKeyFallbackTimer !== fallbackTimer) {
						return;
					}

					const event = new Event('beforeinput', {
						bubbles: true,
						cancelable: false
					}) as InputEvent;
					Object.defineProperties(event, {
						inputType: {
							value: inputType,
							configurable: true
						},
						data: {
							value: null,
							configurable: true
						},
						dataTransfer: {
							value: null,
							configurable: true
						},
						getTargetRanges: {
							value: () => [],
							configurable: true
						}
					});
					// Runs deferred (timer) — outside the keydown's flag
					// window — so the fallback's own writes need the
					// user-input flag for caret scroll. The serial was
					// already bumped by the wrapping keydown.
					await this.withUserInput(this.onBeforeInput, { bumpSerial: false })(event);
				} finally {
					if (this.structuralKeyFallbackTimer === fallbackTimer) {
						this.structuralKeyFallbackTimer = null;
						this.structuralKeyFallbackInputType = null;
					}
				}
			})();
		});
		this.structuralKeyFallbackTimer = fallbackTimer;
	};
	clearCompositionSelectionRestore = () => {
		if (this.compositionSelectionRestoreFrame !== null) {
			cancelAnimationFrame(this.compositionSelectionRestoreFrame);
			this.compositionSelectionRestoreFrame = null;
		}
		this.compositionSelectionRestoreTimers.forEach((timer) => clearTimeout(timer));
		this.compositionSelectionRestoreTimers = [];
	};
	private clearDanglingCompositionBlurTimer = () => {
		if (!this.danglingCompositionBlurTimer) {
			return;
		}

		clearTimeout(this.danglingCompositionBlurTimer);
		this.danglingCompositionBlurTimer = null;
	};
	private resetDanglingComposition = () => {
		this.clearDanglingCompositionBlurTimer();
		if (!this.isComposing) {
			return;
		}

		this.clearCompositionSelectionRestore();
		this.compositionState = null;
		this.compositionStartReplacementState = null;
		this.isComposing = false;
		this.hasHandledCompositionInput = false;
		this.compositionEndedAt = Number.NEGATIVE_INFINITY;
		this._compositionHostText?._releaseCompositionPin();
	};
	private scheduleDanglingCompositionBlurReset = () => {
		if (!this.isComposing) {
			return;
		}

		this.clearDanglingCompositionBlurTimer();
		this.danglingCompositionBlurTimer = setTimeout(() => {
			this.danglingCompositionBlurTimer = null;
			this.resetDanglingComposition();
		}, 50);
	};
	stabilizeCompositionSelection = async (textOrId: Text | string, offset: number) => {
		// Every commit path funnels through here — release the render pin so
		// the DOM converges to the model (covers paths like
		// `finishCompositionFromBeforeInput` that never touch Text directly).
		this._compositionHostText?._releaseCompositionPin();
		const textId = typeof textOrId === 'string' ? textOrId : textOrId.id;
		const armedSerial = this.userGestureSerial;
		const restore = async (disarmedByUserGesture: boolean) => {
			if (this.readonly || this.isComposing) {
				return;
			}

			const text = this.getTextById(textId);
			if (!text) {
				return;
			}
			const targetOffset = Math.min(offset, text.length);

			if (disarmedByUserGesture && this.userGestureSerial !== armedSerial) {
				// A real user gesture (click/key/paste) landed after this
				// restore was armed — the user owns the caret now. The
				// browser's spontaneous post-commit selection jump carries
				// no gesture, so it still gets repaired.
				return;
			}

			const selection = getDomSelection(this.node);
			const hasSelectionInEditor = Boolean(
				this.node && selection?.anchorNode && this.node.contains(selection.anchorNode)
			);
			const hasModelSelectionInEditor = Boolean(
				this.node &&
				this.selection.state.startText?.node &&
				this.node.contains(this.selection.state.startText.node)
			);
			const activeElement = getActiveElement(this.node);
			if (
				this.node &&
				activeElement &&
				!this.node.contains(activeElement) &&
				!hasSelectionInEditor &&
				!hasModelSelectionInEditor
			) {
				return;
			}
			// Focus moved into a nested editable island (e.g. Tab into a
			// plugin-owned field) — the island owns its caret; writing the
			// model selection back would steal focus from it.
			if (activeElement && isNestedForeignEditableTarget(this.node, activeElement)) {
				return;
			}

			await this.selection.setAtTextOffset(text, targetOffset);
		};

		this.clearCompositionSelectionRestore();
		await restore(false);

		if (typeof requestAnimationFrame === 'function') {
			this.compositionSelectionRestoreFrame = requestAnimationFrame(() => {
				this.compositionSelectionRestoreFrame = null;
				void restore(true);
			});
		}

		this.compositionSelectionRestoreTimers = [
			setTimeout(() => {
				void restore(true);
			}, 0),
			setTimeout(() => {
				void restore(true);
			}, 30)
		];
	};
	onCompositionStart = (event?: CompositionEvent) => {
		if (event && isNativeInteractiveEvent(event)) {
			return;
		}
		// A composition inside a nested `contenteditable` island belongs to
		// that island — entering composition mode here would route the
		// island's input through the model-selection pipeline.
		if (event && isNestedForeignEditableTarget(this.node, event.target)) {
			return;
		}

		if (this.isComposing) {
			return;
		}

		this.clearDanglingCompositionBlurTimer();
		this.clearCompositionSelectionRestore();
		this.compositionEndedAt = Number.NEGATIVE_INFINITY;
		this.compositionState = null;
		this.selection.applySelectionSnapshot(getDomSelectionSnapshot(this.node));
		this.compositionStartReplacementState = getSelectionReplacementState(this);
		this.isComposing = true;
		this.hasHandledCompositionInput = false;
		// Pin the host's render immediately — remote/model changes landing
		// before the first composition beforeinput must not rewrite the DOM
		// node the IME anchored to. The caret anchor captured here is what
		// lets the first preview write resolve a model-correct offset even
		// if remote edits already moved the atoms.
		this.selection.state.startText?._acquireCompositionPin();
	};
	onCompositionEnd = async (event?: CompositionEvent) => {
		if (event && isNativeInteractiveEvent(event)) {
			return;
		}
		// Mirror the start guard — a foreign island's compositionend must
		// never commit `event.data` into the model at a stale selection.
		if (event && isNestedForeignEditableTarget(this.node, event.target)) {
			return;
		}

		this.clearDanglingCompositionBlurTimer();
		const state = this.compositionState;
		const startReplacementState = this.compositionStartReplacementState;
		const wasComposing = this.isComposing;
		const hasHandledCompositionInput = this.hasHandledCompositionInput;
		this.compositionState = null;
		this.compositionStartReplacementState = null;
		this.isComposing = false;
		this.hasHandledCompositionInput = false;
		this.compositionEndedAt = getEventTimeStamp(event);
		// The browser relinquished the node — release the render pin so the
		// DOM converges to the model (the commit below rewrites anyway; the
		// `finalValue === state.value` fast path would otherwise leave
		// `isEmpty`/the pinned render frozen).
		this._compositionHostText?._releaseCompositionPin();
		const finalValue = event?.data ?? state?.value ?? '';
		if (!state) {
			if (
				!wasComposing ||
				hasHandledCompositionInput ||
				this.readonly ||
				this.selection.state.isVoidEditableElement ||
				finalValue.length === 0
			) {
				return;
			}

			this.suppressNextInputFallback(50);
			this.repairSuppressedInputFallback(50);
			const target =
				this.selection.selectedBlocks.size > 0
					? await replaceSelectedBlocksWithEmptyBlockTarget(this)
					: await replaceSelectionWithCollapsedTarget(this, startReplacementState ?? undefined);
			if (!target) {
				return;
			}

			target.text.insertText({
				value: finalValue,
				start: target.offset,
				end: target.offset
			});
			const selectionOffset = target.offset + finalValue.length;
			setSuppressedInputRepairSelectionTarget(this, target.text, selectionOffset);
			await this.stabilizeCompositionSelection(target.text, selectionOffset);
			return;
		}

		// Anchor-resolve the region in MODEL space — remote/model edits that
		// landed mid-composition moved the atoms the preview occupies, so the
		// commit clobbers exactly those atoms (including remote text absorbed
		// inside the region) instead of duplicating or corrupting neighbours.
		const region = this.resolveCompositionRegion();
		const text = region?.text ?? this.getTextById(state.textId);
		if (!text) {
			return;
		}
		const startOffset = region ? region.startOffset : state.startOffset;
		const regionLength = region ? region.length : state.value.length;

		const restoreInterruptedSelection = async () => {
			const restore = state.restoreSelectionAfterCommit;
			if (!restore) {
				return false;
			}

			const restoreText = this.getTextById(restore.textId);
			if (!restoreText) {
				return false;
			}

			await this.stabilizeCompositionSelection(restoreText, restore.offset);
			return true;
		};

		const getFinalCompositionMarks = () => {
			if (state.marks !== undefined) {
				return state.marks;
			}
			if (state.value.length === 0) {
				return undefined;
			}

			const previewParts = text
				.getMarksAtRange(startOffset, startOffset + state.value.length)
				.filter((part) => part.text.length > 0);
			if (previewParts.length === 0) {
				return {};
			}

			const marks: Record<string, SerializableContent | null> = {
				...(previewParts[0].marks ?? {})
			};
			for (const part of previewParts.slice(1)) {
				const partMarks = part.marks ?? {};
				for (const mark of Object.keys(marks)) {
					if (JSON.stringify(marks[mark] ?? undefined) !== JSON.stringify(partMarks[mark])) {
						delete marks[mark];
					}
				}
			}
			return marks;
		};

		this.suppressNextInputFallback(50);
		this.repairSuppressedInputFallback(50);
		const interruptedSelection = state.restoreSelectionAfterCommit;
		const repairText = interruptedSelection ? this.getTextById(interruptedSelection.textId) : text;
		if (repairText) {
			setSuppressedInputRepairSelectionTarget(
				this,
				repairText,
				interruptedSelection?.offset ?? startOffset + finalValue.length
			);
		}
		if (finalValue === state.value) {
			if (await restoreInterruptedSelection()) {
				return;
			}
			await this.stabilizeCompositionSelection(text, startOffset + finalValue.length);
			return;
		}

		const finalMarks = getFinalCompositionMarks();
		if (regionLength > 0) {
			text.deleteAt(startOffset, regionLength);
		}

		if (finalValue.length > 0) {
			text.insertText({
				value: finalValue,
				start: startOffset,
				end: startOffset,
				marks: finalMarks
			});
		}

		if (await restoreInterruptedSelection()) {
			return;
		}

		await this.stabilizeCompositionSelection(text, startOffset + finalValue.length);
	};

	shouldIgnoreCompositionKeyDown = (event: KeyboardEvent) => {
		if (this.isComposing && !event.isComposing && !this.compositionState) {
			// A non-composing key while the latch is held but no preview
			// state exists is EITHER a session the browser abandoned
			// without compositionend (synthesized IME input that starts
			// but never ends — Playwright-Firefox `·`/`é`) OR a live
			// composition sitting in its start→first-input window, where
			// pass-through keys must stay inert. Swallow THIS key either
			// way, but arm the deferred reset so a dead session unlatches
			// instead of swallowing every future structural key.
			this.postCompositionGuardSwallows++;
			this.scheduleDanglingCompositionBlurReset();
		}
		if (this.isComposing || event.isComposing) {
			return true;
		}

		const isBackspaceWithExplicitSelection =
			event.key === 'Backspace' &&
			(!this.selection.state.isCollapsed ||
				this.selection.selectedBlocks.size > 0 ||
				this.selection.selectedInlineBlock.size > 0);
		if (isBackspaceWithExplicitSelection) {
			this.compositionEndedAt = Number.NEGATIVE_INFINITY;
			return false;
		}

		const shouldGuardPostCompositionKey =
			event.key === 'Enter' || (event.key === 'Backspace' && isAppleWebKitBrowser());
		if (!shouldGuardPostCompositionKey) {
			// The guard suppresses only the browser's first phantom structural
			// key immediately after composition. Any real intervening command
			// proves that the composition sequence is over.
			this.compositionEndedAt = Number.NEGATIVE_INFINITY;
			return false;
		}

		const elapsed = getEventTimeStamp(event) - this.compositionEndedAt;
		if (elapsed < 0 || elapsed > 500) {
			this.compositionEndedAt = Number.NEGATIVE_INFINITY;
			return false;
		}

		this.compositionEndedAt = Number.NEGATIVE_INFINITY;
		this.postCompositionGuardSwallows++;
		event.preventDefault();
		event.stopPropagation();
		return true;
	};

	/**
	 * Count of composition-adjacent suppressions: structural keys
	 * swallowed by the post-composition phantom guard (first
	 * Enter/Backspace after compositionend) AND pass-through keys
	 * swallowed while a composition latch with no preview state is
	 * armed for deferred reset. Test oracles diff this across an action
	 * window to tell a designed suppression from a broken action.
	 */
	postCompositionGuardSwallows = 0;

	deleteContentWithinSelection = this.batch(
		'deleteContentWithinSelection',
		deleteContentWithinSelection.bind(this)
	);

	getTextById = (id: string) => {
		const isText = id.startsWith('t');
		if (!isText) {
			throw new Error('Invalid id, expected text id');
		}

		return this.idToText.get(id);
	};

	getTextNode = async (idOrText: string | Text): Promise<HTMLElement> => {
		await tick();
		const text = idOrText instanceof Text ? idOrText : this.getTextById(idOrText);
		let node = text?.node;
		let breakCount = 0;
		while (!node) {
			await tick();
			node = text?.node;
			breakCount++;
			if (breakCount > 10) {
				throw new Error('Failed to find text node');
			}
		}
		return node;
	};

	clear = () => {
		let newBlock: Block | null = null;
		this.transact(() => {
			const root = this.root!;
			root.deleteChildren(0, root.children.length);
			newBlock = new Block({
				edytor: this,
				parent: this.root,
				block: {
					type: this.getDefaultBlock(this.root)
				}
			});
			root.insertChildren(root.children.length, [newBlock]);
		});
		this.refreshEditorDom();

		tick().then(async () => {
			this.expectInternalFocus();
			this.node?.focus({ preventScroll: true });
			const targetText = newBlock?.firstText ?? this.root?.children[0]?.firstText;
			await this.selection.setAtTextOffset(targetText, 0);
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
			this.scheduleDanglingCompositionBlurReset();
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

				// A history selection restore owns the caret while it runs.
				// This cached point was captured at focus time — before the
				// undo/redo pop resolved its target — so re-applying it now
				// (or adopting the browser's post-remount collapse via
				// applyMeaningfulDomSelection) stomps the in-flight restore
				// and leaves model=range vs DOM=caret.
				if (this.selection.isRestoringHistorySelection) {
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
		this.hotKeys.init();
		const handleKeyDownCapture = (event: KeyboardEvent) => {
			onKeyDown.call(this, event);
		};
		const domMutationObserver = observeDomTextMutations(this, node);
		this.off.push(
			// Keydown serial bumps happen INSIDE onKeyDown, after the
			// composition-phantom swallow — a swallowed trailing
			// Enter/Backspace is a browser artifact, not a gesture, and
			// must not disarm pending composition caret restores.
			on(node, 'keydown', this.withUserInput(handleKeyDownCapture, { bumpSerial: false }), {
				capture: true
			}),
			on(
				node.ownerDocument,
				'keydown',
				this.withUserInput(onKeyDown.bind(this), { bumpSerial: false })
			),
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
			on(node, 'click', this.selection.handleTripleClick),
			// Settle queued mutation repairs before the native menu opens —
			// spellcheck suggestions are computed against the DOM at this
			// moment (PM flushes its DOM observer on contextmenu for the
			// same reason).
			on(node, 'contextmenu', () => domMutationObserver.flushNow()),
			on(node, 'beforeinput', this.withUserInput(this.onBeforeInput)),
			on(node, 'input', this.withUserInput(this.onInput)),
			on(node, 'copy', this.onCopy),
			on(node, 'cut', this.withUserInput(this.onCut)),
			on(node, 'paste', this.withUserInput(this.onPaste)),
			on(node, 'dragover', preventUnsupportedDrop),
			on(node, 'drop', preventUnsupportedDrop),
			on(node, 'focusin', (event: FocusEvent) => {
				// Focus arriving back inside the editor re-establishes editor
				// ownership of the selection.
				this.lastUserGestureOutsideEditor = false;
				// The editor's own programmatic `focus()` calls (selection
				// writes refocus the text host) also fire focusin — with a
				// relatedTarget already inside the editor they're internal
				// housekeeping, not user gestures. During a history-restore
				// window the restore's OWN focus() calls can arrive with an
				// external relatedTarget (the undo's render detached the
				// previously focused node → focus fell to body) — counting
				// them would bump the gesture serial and self-abort the
				// restore. Click-driven focus returns are already marked by
				// the document-level pointerdown capture.
				if (this.expectInternalFocusArmed) {
					this.expectInternalFocusArmed = false;
				} else if (
					!(event.relatedTarget instanceof Node && this.node?.contains(event.relatedTarget)) &&
					!this.selection.isRestoringHistorySelection
				) {
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
				this.clearInputFallbackSuppression();
				this.clearCompositionSelectionRestore();
				this.clearDanglingCompositionBlurTimer();
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
	destroy = () => {
		if (this.destroyed) {
			return;
		}
		this.destroyed = true;

		// A pending readiness binding must not resurrect a dead view —
		// release the decision listener and cancel the deferred decision.
		this._readinessRelease?.();
		this._readinessRelease = undefined;
		if (this._readinessTimer !== undefined) {
			clearTimeout(this._readinessTimer);
			this._readinessTimer = undefined;
		}

		// Runs the whole attach-lifetime batch — DOM listeners, the mutation
		// observer, plugin actions, and the facade-change release (which
		// clears `_facadeChangeOff`) — and empties the array.
		this.off.splice(0).forEach((off) => off());

		// `selectionchange` listener + the published remote caret.
		this.selection.destroy();

		this.clearInputFallbackSuppression();
		this.clearCompositionSelectionRestore();
		this.clearDanglingCompositionBlurTimer();
		this.cancelStructuralKeyFallback();
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
