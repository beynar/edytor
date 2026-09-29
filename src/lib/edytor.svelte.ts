import { getContext, hasContext, type Snippet, mount, unmount } from 'svelte';
import { DEV } from 'esm-env';
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
import { attachFocus, selectionIsInside } from './events/onFocus.js';
import { Attempts } from './session/attempt.js';
import { Composition } from './session/composition.svelte.js';
import { type JSONBlock, type JSONDoc } from '$lib/utils/json.js';
import { onKeyDown } from '$lib/events/onKeyDown.js';
import { EdytorSelection } from './selection/selection.svelte.js';
import { Projector } from './surface/projector.svelte.js';
import { SurfaceObserver } from './surface/observer.svelte.js';
import { virtualLens, type ViewDoc } from './session/virtual.js';
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
import { Y } from '$lib/crdt/engine.js';
import {
	attachDocument,
	bindCrdt,
	SemanticConflictError,
	type Awareness,
	type Crdt,
	type DocChange,
	type DocumentActor,
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
import { Keymap, type HotKey, type HotKeyCombination } from './session/keymap.js';
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
import { kindCatalogue, kindCommand, type KindRow } from './kinds.js';
import {
	clearDomSelection,
	getActiveElement,
	getDomSelection,
	getDomSelectionSnapshot
} from './selection/domSelection.js';

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
	hotKeys?: Partial<Record<HotKeyCombination, HotKey>>;
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
	/** The local author of a view-owned document (with `document`, set it there). */
	actor?: DocumentActor;
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

/** The definition of a kind the view does not register: no roles, no snippet (`definitionOf`). */
export const UNKNOWN_KIND: BlockDefinition = Object.freeze({});

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
	/** The view's handles (R4): one id-only `Block` per live id, texts and atoms by position and id. */
	idToBlock: Handles = new Handles(this);
	nodeToInlineBlock = new Map<Node, InlineBlock>();
	nodeToText = new Map<Node, Text>();
	transaction = new TRANSACTION();
	hotKeys: Keymap;
	readonly = $state(false);
	root = $state<Block>();
	/** The view is bound to its decided document (its root is built). */
	get synced(): boolean {
		return this.root !== undefined;
	}
	/** `batch` binds operations onto blocks and the view alike: both answer `.edytor`. */
	readonly edytor = this;
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
	/** The document as this view reads it: its virtual paragraph while it shows no block (`doc.empty.virtual`). */
	private lens?: ViewDoc;
	get facade(): ViewDoc {
		return (this.lens ??= virtualLens(
			this.document.facade,
			() => this.document.ready,
			() => this.document.defaultChild(null)
		));
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
	 * change, as for a remote undo). A readonly view or a read-only document
	 * refuses them, as it refuses every command (`dispatcher.last`).
	 */
	historyUndo = (): void => this.#replay('undo');
	historyRedo = (): void => this.#replay('redo');
	#replay = (command: 'undo' | 'redo') => {
		if (this.dispatcher.permits()) this.history[command]();
		else this.dispatcher.last = { operation: command, status: 'refused' };
	};

	constructor({
		snippets,
		readonly,
		hotKeys,
		plugins,
		document,
		doc,
		awareness,
		actor,
		sync,
		value,
		onSelectionChange,
		placeholder,
		onChange
	}: EdytorOptions) {
		if (document !== undefined) {
			if (doc !== undefined || awareness !== undefined || actor !== undefined) {
				throw new Error(
					'EdytorOptions: `document` cannot be combined with `doc`/`awareness`/`actor` — ' +
						'the document owns them (compose them via attachDocument first).'
				);
			}
			this.document = document;
		} else {
			// Legacy path — the view internally owns a document composed
			// around the injected (or a fresh) doc/awareness.
			this.document = attachDocument(doc ?? new Y.Doc(), { awareness, actor });
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

				// Duplicate definitions: the first extension wins (site docs plugins#plugin-order, D-11).
				define(this.marks, initializedPlugin.marks);
				define(this.blocks, initializedPlugin.blocks);
				define(this.inlineBlocks, initializedPlugin.inlineBlocks);
				for (const command of initializedPlugin.commands ?? [])
					if (!this.commands.has(command.id)) this.commands.set(command.id, command);
				return initializedPlugin;
			});

			// The app's snippets override the plugins' after they register: keys are
			// `{type}{suffix}` over maps keyed by the bare type, suffixes tried in
			// this order (`mentionInlineBlock` also ends in `Block`). Only the
			// snippet is replaced: the definition's roles, `transformText` and hooks survive.
			const overrides = [
				['Mark', this.marks],
				['InlineBlock', this.inlineBlocks],
				['Block', this.blocks]
			] as const;
			for (const [key, snippet] of Object.entries(snippets || {})) {
				const override = overrides.find(([suffix]) => key.endsWith(suffix));
				if (!override) continue;
				const [suffix, into] = override;
				const name = key.slice(0, -suffix.length);
				(into as Map<string, object>).set(name, { ...into.get(name), snippet });
			}

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
					blocks.map(([type, { void: v, island, lines }]) => [type, { void: v, island, lines }])
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

	/** Kinds already reported missing (DEV, once each). */
	private unknownKinds = new Set<string>();

	/**
	 * The definition of block kind `type` — the one lookup (render, surface,
	 * handles). A kind no plugin of this view registers (a rolling deploy, a
	 * peer's plugin) answers {@link UNKNOWN_KIND}: no roles, rendered as a
	 * plain block with its text and children; DEV warns once per kind.
	 */
	definitionOf = (type: string): BlockDefinition => {
		const definition = this.blocks.get(type);
		if (definition) return definition;
		if (DEV && type && type !== 'root' && !this.unknownKinds.has(type)) {
			this.unknownKinds.add(type);
			console.warn(
				`[edytor] block kind "${type}" is not registered by any plugin: it renders as a plain block.`
			);
		}
		return UNKNOWN_KIND;
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
	 * committed update) + the root wrapper identity, so repeated reads
	 * inside one version share the one computed tree.
	 *
	 * `valueRevision` participates in the cache key and is read for
	 * reactivity: `facade.version` is not a tracked source, so without it a
	 * `$derived`/`$effect` consumer of `edytor.value` could freeze on the
	 * first cached export while the model keeps advancing.
	 *
	 * Callers receive the SAME object until the next version bump — code
	 * that needs an owned copy must clone it.
	 */
	get value(): JSONBlock {
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
		if (!command || command.isEnabled?.(this) === false) return false;
		await command.run(this);
		return true;
	};

	/** The adopted default type for a new child of `parent` — its actual parent (R5, O9). */
	defaultChild = (parent: Block): string =>
		this.document.defaultChild(parent.isRoot ? null : parent.type);

	/** Releases the readiness wait of a view bound before its document decided. */
	private _readinessRelease: (() => void) | undefined;

	sync = ({ children = [] }: JSONDoc = { children: [] }) => {
		if (this.synced) return;
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
		// A document that is already empty shows its virtual paragraph with the caret in it.
		this.selection?.restoreDeadSelectionEndpoints();
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
			for (const plugin of this.plugins) plugin.onChange?.(value);
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
	/** A `focusin` consumes the armed flag: `true` when the editor focused itself. */
	consumeInternalFocus = (): boolean => {
		const armed = this.expectInternalFocusArmed;
		this.expectInternalFocusArmed = false;
		return armed;
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
	stabilizeCompositionSelection = (text: Text, offset: number) => {
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
		this.selection.setAtTextOffset(text, Math.min(offset, text.length));
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
		const transform = this.definitionOf(cell.type).transformText;
		return pinned?.deltas ?? segmentDeltas(cell, segment, transform);
	};

	/** The handle of inline atom `atom`, shown in block `id`. */
	atomAt = (id: string, atom: string): InlineBlock => this.idToBlock.atom(id, atom);

	/**
	 * Replace the whole document with one empty block and put the caret in it,
	 * as one undo step. A readonly view or a read-only document refuses it
	 * (`dispatcher.last` reads `refused`). Answers whether it applied.
	 */
	clear = (): boolean => {
		const newBlock = this.dispatcher.run('clear', () =>
			this.transact(() => {
				const root = this.root!;
				root.deleteChildren(0, root.children.length);
				const block = { id: id('b'), type: this.defaultChild(root) };
				root.insertChildren(0, [block]);
				return this.idToBlock.block(block.id);
			})
		);
		if (!newBlock) return false;
		this.dispatcher.last = { operation: 'clear', status: 'applied' };
		this.selection.setAtTextOffset(newBlock.firstText ?? this.root?.children[0]?.firstText, 0);
		this.expectInternalFocus();
		this.node?.focus({ preventScroll: true });
		return true;
	};

	attach = (node: HTMLDivElement) => {
		// A remount must not inherit a stale "user is outside" verdict —
		// ownership is re-derived from live gestures from here on.
		this.lastUserGestureOutsideEditor = false;
		this.node = node;
		this.selection.init();
		this.doc.on('beforeAllTransactions', this.projector.opening);
		this.doc.on('beforeTransaction', this.surface.before);
		this.doc.on('beforeTransaction', this.projector.before);
		this.doc.on('afterTransaction', this.projector.after);
		this.off.push(() => {
			this.doc.off('beforeAllTransactions', this.projector.opening);
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
			// Pointer and focus ownership, and the focus-time caret restore.
			...attachFocus(this, node),
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
			if (typeof action === 'function') this.off.push(action);
		});

		return {
			destroy: () => {
				if (selectionIsInside(node)) clearDomSelection(node);
				const active = getActiveElement(node);
				if (active instanceof HTMLElement && node.contains(active)) active.blur();
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
	 * this from its `onDestroy` (after a server render too); consumers
	 * holding a bare `Edytor` (test harnesses, custom mounts,
	 * dialogs/tabs/multi-editor views) must call it when the editor is
	 * discarded.
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
		if (this.destroyed) return;
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
	if (!hasContext('edytor')) throw new Error('No Edytor found');
	return getContext<Edytor>('edytor');
};
