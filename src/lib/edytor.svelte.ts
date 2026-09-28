import {
	getContext,
	hasContext,
	setContext,
	tick,
	type Snippet,
	onMount,
	mount,
	unmount
} from 'svelte';
import { onBeforeInput } from './events/onBeforeInput.js';
import { onCopy } from './events/onCopy.js';
import { onCut } from './events/onCut.js';
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
import { SurfaceObserver } from './surface/observer.svelte.js';
import {
	createCells,
	placeholderOf,
	segmentDeltas,
	type Cell,
	type Cells,
	type RenderDelta,
	type Segment
} from './surface/cells.js';
import { Pin } from './surface/pin.svelte.js';
import { Overlay } from './surface/overlay.js';
import RemoteSelections from './collaboration/RemoteSelections.svelte';
import type { Block } from './block/block.svelte.js';
import type { Text } from './text/text.svelte.js';
import { Handles } from './session/handles.js';
import { id } from './utils.js';
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
	EditorCommand,
	Placeholder
} from './plugins.js';
import { on } from 'svelte/events';
import { Keymap, type HotKey } from './session/keymap.js';
import { TRANSACTION } from './constants.js';
import type { InlineBlock } from './block/inlineBlock.svelte.js';
import {
	caretOf,
	deleteBlocks,
	deleteContentWithinSelection,
	insertFlow,
	rangeCaret,
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
	placeholder?: Placeholder;
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
	/** The view's handles (R4): one id-only `Block` per live id, texts and atoms by position and id. */
	idToBlock: Handles = new Handles(this);
	nodeToInlineBlock = new SvelteMap<Node, InlineBlock>();
	nodeToText = new SvelteMap<Node, Text>();
	transaction = new TRANSACTION();
	hotKeys: Keymap;
	readonly = $state(false);
	root = $state<Block>();
	/** The view is bound to its decided document (its root is built). */
	get synced(): boolean {
		return this.root !== undefined;
	}
	edytor = this;
	selection: EdytorSelection;
	/** The only writer of the DOM selection (R10, `surface/projector`). */
	readonly projector: Projector = new Projector(this);
	/** The compare-to-truth observer (R12): registry, the render epoch, the passes, the only adopter (R8, L31). */
	readonly surface: SurfaceObserver = new SurfaceObserver(this);
	/** What the components render (R1, R2): one cell per visible block, patched from change reports. */
	cells = $state.raw<Cells>();
	/** The IME host pin (`surface/pin`): the composing cell's segment list and render, frozen. */
	readonly pin = new Pin();
	/** The chrome layer outside the host (R11): handles, menus, remote carets. */
	readonly overlay = new Overlay();
	private off: (() => void)[] = [];
	private onChange?: (value: JSONBlock) => void;
	placeholder?: Placeholder;
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
	readonly attempts = new Attempts(() => this.surface.signal());

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
	 * The document's shared undo manager — assigned at the end of `sync()`,
	 * never in the constructor, so history capture still starts only after
	 * the document decides its content state (the bootstrap-before-capture
	 * invariant: `document.sync()` seeds/asserts first, then attaches the
	 * manager). Only absent before first sync, which is also before the
	 * editor mounts, so all runtime readers see it set.
	 */
	undoManager!: YUndoManager;
	/** The view's command dispatcher (R7): every mutation this view makes goes through it. */
	readonly dispatcher: Dispatcher = new Dispatcher(this);

	/** An outermost `transact` of this view is running. */
	private transacting = false;
	/**
	 * One transaction of this view. The outermost call runs the normalization
	 * its operations requested at its end, inside the same transaction (S1:
	 * one transaction, normalization once per touched parent): normalizers read
	 * handles over the index, so a command is one update and a peer never
	 * sees its un-normalized state.
	 */
	transact = <T>(cb: () => T): T => {
		if (this.transacting) return this.doc.transact(cb, this.transaction);
		this.transacting = true;
		try {
			return this.doc.transact(() => {
				const out = cb();
				this.dispatcher.drain();
				return out;
			}, this.transaction);
		} catch (error) {
			this.dispatcher.drain(false);
			throw error;
		} finally {
			this.transacting = false;
		}
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
		this.cells = createCells(this.facade, this.surface.patched);
		this.root = this.idToBlock.root;
		this.offCommit = this.facade.onChange(this.onCommit);
	};

	/** The commit subscription: editor-lifetime (a remount's `off` drain never releases it). */
	private offCommit?: () => void;

	/**
	 * One commit (local, remote, undo/redo): prune the handles of the removed
	 * blocks, then the selection's seam and the value consumers.
	 */
	private onCommit = (change: DocChange) => {
		this.valueRevision++;
		this.overlay.invalidate();
		// A commit this view did not issue re-renders under the caret: the
		// projector displays the current value after that flush (R10).
		if (change.origin !== this.transaction) this.surface.update();
		// Remote/programmatic commits run under the scroll suppressor —
		// a remote commit landing inside an in-flight `isHandlingUserInput`
		// window must not scroll the page.
		this.suppressCaretScrollDepth++;
		try {
			this.idToBlock.prune(change);
			// Repair a selection that no longer resolves.
			this.selection?.restoreDeadSelectionEndpoints();
			// D-20: a live composition whose block was re-placed commits first.
			this.composition.restructured(change);
		} finally {
			this.suppressCaretScrollDepth--;
		}
		// `this.value` is a full-document export (O(doc) — ~17ms at 5k
		// blocks) — compute it only when a consumer actually exists.
		if (this.onChange || this.plugins.some((plugin) => plugin.onChange)) {
			const value = this.value;
			this.onChange?.(value);
			this.plugins.forEach((plugin) => {
				plugin.onChange?.(value);
			});
		}
	};

	/**
	 * The placeholder block `id` shows (§2.4, D-8): its cell has one empty
	 * text and no live composition in it; a function answers per block.
	 */
	placeholderAt = (id: string): string | null => {
		const cell = this.cells?.get(id);
		const placeholder = this.placeholder;
		if (!placeholder || !cell || !placeholderOf(cell, this.composition.host?.parent.id === id))
			return null;
		if (typeof placeholder === 'string') return placeholder;
		const { type, data = {} } = cell;
		const focused = this.idToBlock.block(id).focused;
		return placeholder({ type, data, focused, empty: true }) || null;
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
	stabilizeCompositionSelection = async (text: Text, offset: number) => {
		if (this.readonly || this.isComposing || !text.isInDocument) return;
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

	deleteContentWithinSelection = batch(
		'deleteContentWithinSelection',
		deleteContentWithinSelection,
		prepareDeleteContent,
		rangeCaret
	);

	insertFlow = batch('insertFlow', insertFlow, prepareFlow, caretOf);

	deleteBlocks = batch('deleteBlocks', deleteBlocks, prepareDeleteBlocks);

	/** The handle of the `ordinal`-th text segment of block `id` (the element a cell segment renders). */
	textAt = (id: string, ordinal: number): Text => this.idToBlock.text(id, ordinal);

	/** The cell segment the element of `text` renders (the frozen list while pinned). */
	segmentOf = (text: Text): { cell: Cell; segment: Segment } | null => {
		const cell = this.cells?.get(text.parent.id);
		const part = cell && this.pin.parts(cell).filter((p) => p.kind === 'text')[text.ordinal];
		return cell && part?.kind === 'text' ? { cell, segment: part } : null;
	};

	/** The render deltas the element of `text` shows. */
	deltasOf = (text: Text): readonly RenderDelta[] => {
		const at = this.segmentOf(text);
		if (!at) return [];
		const { cell, segment } = at;
		const pinned = this.pin.render(cell.id, segment.key);
		const transform = this.getBlockDefinition('block', cell.type).transformText;
		return pinned?.deltas ?? segmentDeltas(cell, segment, transform);
	};

	/** The handle of inline atom `atom`, shown in block `id`. */
	atomAt = (id: string, atom: string): InlineBlock => this.idToBlock.atom(id, atom);

	clear = () => {
		const newBlock = this.transact(() => {
			const root = this.root!;
			root.deleteChildren(0, root.children.length);
			const block = { id: id('b'), type: this.defaultChild(root) };
			root.insertChildren(0, [block]);
			return this.idToBlock.block(block.id);
		});
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
				const unchanged = s.startText === text && s.yStart === offset;
				const focusReset = s.startText === this.root?.firstEditableText && s.yStart === 0;
				const targetText = unchanged || focusReset ? text : s.startText;
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
		this.selection.init();
		this.doc.on('beforeTransaction', this.surface.before);
		this.doc.on('beforeTransaction', this.projector.before);
		this.doc.on('afterTransaction', this.projector.after);
		this.off.push(() => {
			this.doc.off('beforeTransaction', this.surface.before);
			this.doc.off('beforeTransaction', this.projector.before);
			this.doc.off('afterTransaction', this.projector.after);
		});
		// Keydown serial bumps happen INSIDE onKeyDown, after the
		// composition-phantom swallow — a swallowed trailing Enter/Backspace
		// is a browser artifact, not a gesture, and must not disarm pending
		// composition caret restores.
		const keydown = this.withUserInput(onKeyDown.bind(this), { bumpSerial: false });
		const detachSurface = this.surface.attach(node);
		this.projector.recordsPending = this.surface.pending;
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
			on(node, 'contextmenu', () => void this.surface.flush()),
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
			detachSurface
		);

		// Chrome lives in the overlay, outside the host: remote carets, then the plugins'.
		const detachOverlay = this.overlay.attach(node);
		const presence = mount(RemoteSelections, {
			target: this.overlay.layer!,
			props: { edytor: this }
		});
		this.off.push(() => unmount(presence), detachOverlay);
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
				// Drain AND clear: `destroy()` runs the same batch again.
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
		// observer, plugin actions — and empties the array.
		this.off.splice(0).forEach((off) => off());
		this.offCommit?.();
		this.history.unbind();

		// `selectionchange` listener + the published remote caret.
		this.selection.destroy();

		this.attempts.clear();
		this.composition.reset();
		this.cells?.dispose();

		// Wrapper maps — drop every id/node→wrapper edge a shared doc or a
		// stray mutation could still reach.
		this.idToBlock.clear();
		this.nodeToInlineBlock.clear();
		this.nodeToText.clear();
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
