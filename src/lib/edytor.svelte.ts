import { getContext, hasContext, mount, unmount, type Component } from 'svelte';
import { DEV } from 'esm-env';
import { onBeforeInput } from './events/onBeforeInput.js';
import { onCopy } from './events/onCopy.js';
import { onCut } from './events/onCut.js';
import { isControlEvent, isKindControl } from './events/nativeInteractiveControl.js';
import { onInput } from './events/onInput.js';
import { onPaste } from './events/onPaste.js';
import { onTextDragEnd, onTextDragStart, preventUnsupportedDrop } from './events/onDrop.js';
import { attachFocus, selectionIsInside, takeKeys } from './events/onFocus.js';
import { attachPageHide } from './events/onPageHide.js';
import { insertLineBreak, runIntent } from './events/beforeInputCommands.js';
import { textPointAt } from './selection/selection.utils.js';
import type { SessionPorts } from './session/ports.js';
import { Attempts } from './session/attempt.js';
import { Composition } from './session/composition.svelte.js';
import { Suggestions, type SuggestionRange } from './session/suggestions.svelte.js';
import { type JSONDoc } from '$lib/utils/json.js';
import { onKeyDown } from '$lib/events/onKeyDown.js';
import { EdytorSelection } from './selection/selection.svelte.js';
import { Projector } from './surface/projector.svelte.js';
import { SurfaceObserver } from './surface/observer.svelte.js';
import { virtualLens, type ViewDoc } from './session/virtual.js';
import {
	createCells,
	placeholderOf,
	type Cell,
	type Cells,
	type RenderDelta,
	type Segment
} from './surface/cells.js';
import { Pin } from './surface/pin.svelte.js';
import { Overlay } from './surface/overlay.js';
import { Popups } from './surface/popups.svelte.js';
import { onOneLine } from './surface/lines.js';
import { Announcer as AnnouncerState } from './session/announcer.svelte.js';
import type { PartialLabels } from './labels.js';
import Announcer from './components/Announcer.svelte';
import RemoteSelections from './collaboration/RemoteSelections.svelte';
import Ranges from './components/Ranges.svelte';
import type { Block } from './block/block.svelte.js';
import type { Text } from './text/text.svelte.js';
import { Handles } from './session/handles.js';
import { cleanups, id } from './utils.js';
import { Y } from '$lib/crdt/engine.js';
import { markName } from '$lib/crdt/text/marks.js';
import { callEach } from '$lib/crdt/protocols/observable.js';
import {
	attachDocument,
	SemanticConflictError,
	type Awareness,
	type DocChange,
	type DocumentActor,
	type EdytorDocument,
	type OrderPolicy,
	type YDoc,
	type YUndoManager
} from '$lib/crdt/index.js';
import { whenDocumentReady } from '$lib/collaboration/documentSync.js';
import {
	mintPresenceKey,
	PresenceWriter,
	type PresenceOptions
} from '$lib/collaboration/awarenessSelection.js';
import { canMove, move, type BlockMoveRequest } from './session/moves.js';
import type { DocumentWrites } from './crdt/operations.js';
import { SUGGEST_ROOT } from './crdt/schema.js';
import { asEngineDoc } from './crdt/structs.js';
import type {
	Plugin,
	InitializedPlugin,
	BlockDefinition,
	MarkDefinition,
	InlineBlockDefinition,
	EditorCommand,
	Placeholder
} from './plugins.js';
import { on } from 'svelte/events';
import { Keymap, type HotKey, type HotKeyCombination } from './session/keymap.js';
import { TRANSACTION } from './constants.js';
import type { InlineBlock } from './block/inlineBlock.svelte.js';
import { Dispatcher } from './session/commands.js';
import { History } from './session/history.js';
import { DataWrites } from './session/props.js';
import { kindCatalogue, kindCommand, UNKNOWN_KIND, type KindRow } from './kinds.js';
import {
	clearDomSelection,
	focusIn,
	getActiveElement,
	getDomSelection,
	getDomSelectionSnapshot
} from './selection/domSelection.js';

/** A consumer that is set (a prop or a plugin hook left out is `undefined`). */
const isListener = <F>(listener: F | undefined): listener is F => listener !== undefined;

export type EdytorOptions = {
	readonly?: boolean;
	/**
	 * Let users nest blocks under other blocks (default `false`): Tab and
	 * Shift+Tab nest and unnest, a drop or a handle's Alt+→ may place a block
	 * inside another. Off, those gestures nest nothing and Tab is left to the
	 * browser (the focus moves on); containers (lists, toggles, callouts,
	 * columns) keep their bodies, and nested blocks already in the document
	 * still render and edit.
	 */
	allowNesting?: boolean;
	/** Chords (`mod+s`, `shift+alt+enter`) the view binds before plugins and built-ins. */
	hotkeys?: Partial<Record<HotKeyCombination, HotKey>>;
	plugins?: Plugin[];
	/**
	 * The assembled document this view renders — shared facade, history,
	 * awareness and semantics live on it (see `crdt/document.ts`). When
	 * injected the view borrows it: `destroy()` releases only view-owned
	 * resources. When absent the view owns a fresh one.
	 */
	document?: EdytorDocument;
	/** The local author of a view-owned document (with `document`, set it there). */
	actor?: DocumentActor;
	/** A view-owned document's `requireHydration` (with `document`, set it there). */
	requireHydration?: boolean;
	/** What this view shares of its selection with peers, and how often (`edytor.presence`). */
	presence?: PresenceOptions;
	sync?: boolean;
	value?: JSONDoc;
	/**
	 * After every commit that changed the visible document: the value, in
	 * the shape `value` takes (a whole-document export per commit).
	 */
	onChange?: (value: JSONDoc) => void;
	/**
	 * After every commit that changed the visible document: what it changed
	 * (blocks added, removed, moved, retyped, edited), with no export. Read
	 * `edytor.value` when you need the document (it is memoized per version).
	 */
	onDocChange?: (change: DocChange) => void;
	onSelectionChange?: (selection: EdytorSelection) => void;
	/**
	 * The words the package shows and says in this view, over the English
	 * ones: any entry of any section (`richText`, `table`, `editor`…), and
	 * the commands' slash `keywords` by id.
	 */
	labels?: PartialLabels;
};

/**
 * The document's properties (`edytor.data`). Augment it to type yours:
 * `declare module 'edytor' { interface EdytorDocData { title?: string } }`.
 */
export interface EdytorDocData extends Record<string, any> {}

export type RootBlock = Block & {
	readonly type: 'root';
	readonly id: 'root';
	readonly depth: 0;
};

/**
 * Register definitions, the first extension's fields winning: a field it
 * leaves out is the next one's (an app's `{ snippet }` listed first restyles
 * a bundled kind and keeps its roles and presets). A bare snippet is `{ snippet }`.
 */
const define = <T extends object>(into: Map<string, T>, definitions: object = {}) => {
	for (const [key, value] of Object.entries(definitions))
		into.set(key, {
			...(typeof value === 'object' ? value : { snippet: value }),
			...into.get(key)
		});
};

/**
 * The mark records: a key `name:<id>` — a comment's, one mark per
 * comment so two never clip each other — reads the `name` record.
 */
class MarkRecords extends Map<string, MarkDefinition> {
	override get(key: string): MarkDefinition | undefined {
		return super.get(key) ?? (key.includes(':') ? super.get(markName(key)) : undefined);
	}
	override has(key: string): boolean {
		return super.has(key) || (key.includes(':') && super.has(markName(key)));
	}
}

/**
 * The view writes with the document's operations (`DocumentWrites`), under
 * the same names and arguments as a bare `EdytorDocument`, dispatched:
 * readonly and `document.writable` admit them, every extension hook sees
 * them and their planned steps first, each is one transaction and the undo
 * policy's step, the blocks it touched are normalized, and the caret it
 * decides (a range deletion, a placed flow) is selected. Each answers its
 * `OpResult` (`refused` when the view, a hook or the document refused it);
 * `dispatcher.last` records it.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface Edytor extends DocumentWrites {}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export class Edytor {
	node?: HTMLElement;
	marks: Map<string, MarkDefinition> = new MarkRecords();
	blocks = new Map<string, BlockDefinition>();
	inlineBlocks = new Map<string, InlineBlockDefinition>();
	commands = new Map<string, EditorCommand>();
	/** The kind catalogue: one row per preset of each kind record (slash, markdown, block menus). */
	kinds: KindRow[] = [];
	/** @internal */
	plugins: InitializedPlugin[];
	/** The view's handles: one id-only `Block` per live id, texts and atoms by position and id. */
	idToBlock: Handles = new Handles(this);
	/** @internal */
	transaction = new TRANSACTION();
	/** @internal The view's keymap: consumer bindings, then the extensions', then the built-in rows. */
	keymap: Keymap;
	readonly = $state(false);
	root = $state<Block>();
	/** The view is bound to its decided document (its root is built). */
	get synced(): boolean {
		return this.root !== undefined;
	}
	selection: EdytorSelection;
	/** @internal The only writer of the DOM selection (`surface/projector`). */
	readonly projector: Projector = new Projector(this);
	/** @internal The compare-to-truth observer: registry, the render epoch, the passes, the only adopter. */
	readonly surface: SurfaceObserver = new SurfaceObserver(this);
	/**
	 * @internal What the session asks of the surface and the input commands
	 * (`session/ports.ts`): the session never imports them, the root wires them here.
	 */
	readonly ports: SessionPorts = {
		surface: {
			park: (text, offset) => this.projector.park(text, offset),
			flush: () => void this.surface.flush(),
			placed: this.projector.placed,
			parked: this.projector.parked,
			clear: () => clearDomSelection(this.node),
			pointAt: (node, offset) => textPointAt.call(this.selection, node, offset),
			sameLine: (a, b) => onOneLine(this.selection.textAt(a), this.selection.textAt(b))
		},
		input: {
			runIntent: (inputType) => runIntent(this, inputType),
			insertLineBreak: (snapshot, caret) => insertLineBreak(this, snapshot, caret)
		}
	};
	/** What the components render: one cell per visible block, patched from change reports. */
	cells = $state.raw<Cells>();
	/** Bumped by each commit that changed the document's data: what `docData()` readers track. */
	#dataRevision = $state(0);
	/** @internal The document's data, read-your-writes and reactive (`{}` when none). */
	docData = (): Record<string, unknown> => {
		void this.#dataRevision;
		return this.facade.docData();
	};
	/** @internal The view's property writes (`session/props`): the data proxies' one queue. */
	readonly dataWrites: DataWrites = new DataWrites(this);
	#dataProxy?: EdytorDocData;
	/**
	 * The document's properties, as plain state: reactive at any depth, and
	 * writable (`edytor.data.title = 'Notes'`, `edytor.data.tags.push('x')`,
	 * `delete edytor.data.draft`). Each write is the `patchData` operation,
	 * dispatched; the writes of one task are one undo step. Type them by
	 * augmenting {@link EdytorDocData}.
	 */
	get data(): EdytorDocData {
		return (this.#dataProxy ??= this.dataWrites.proxy<EdytorDocData>(null, this.docData));
	}
	/** @internal The IME host pin (`surface/pin`): the composing cell's segment list and render, frozen. */
	readonly pin = new Pin();
	/** The chrome layer outside the host: handles, menus, remote carets. */
	readonly overlay = new Overlay();
	/** The chrome popups open on this view (`surface/popups`): what the root's ARIA names. */
	readonly popups = new Popups();
	/** What this view announces to assistive technology (`session/announcer`): its block moves and deletes. */
	readonly announcer: AnnouncerState = new AnnouncerState(this);
	/** The words the view was given (`<Edytor labels>`); its plugins read their section through `labelsOf`. */
	readonly labels: PartialLabels = {};
	/** Whether users may nest blocks (`allowNesting`, read once; the rule is `session/moves.ts` `nestsInto`). */
	readonly allowNesting: boolean = false;
	private off: (() => void)[] = [];
	private onChange?: (value: JSONDoc) => void;
	private onDocChange?: (change: DocChange) => void;
	placeholder?: Placeholder;
	/** @internal The view's composition session: at most one, live then tail. */
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
	 * @internal
	 */
	get isHandlingUserInput(): boolean {
		return this.#userInputHandlingDepth > 0;
	}
	/**
	 * Depth counter suppressing caret scroll during programmatic DOM
	 * writes — remote mirror flushes and mutation-observer repairs can
	 * land inside an `isHandlingUserInput` window; their selection writes
	 * are maintenance, not typing, and must not move the page.
	 * @internal
	 */
	suppressCaretScrollDepth = 0;
	/** The view's suggestions (`session/suggestions`): proposed content, shown here until accepted. */
	readonly suggestions: Suggestions = new Suggestions(this);
	/** @internal The view's input attempts: one per user occurrence. */
	readonly attempts = new Attempts(() => this.surface.signal());

	// CRDT (v14) — the document is the composition owner: it holds the ONE
	// engine doc, the shared facade (only structural read/write surface),
	// the default local history and the shared awareness. Injected
	// documents are borrowed; a view with no `document` option owns a fresh one.
	document: EdytorDocument;
	/** `true` when this view created its document — `destroy()` then releases it. */
	#owned = false;
	get doc(): YDoc {
		return this.document.doc;
	}
	/** The document as this view reads it: its virtual paragraph while it shows no block (`doc.empty.virtual`). */
	private lens?: ViewDoc;
	/**
	 * The document as this view reads and writes it (the virtual paragraph's
	 * lens). The public raw path is the document's own operations (`edytor.document.insertBlocks(…)`): its writes skip
	 * the dispatcher (no hooks, no readonly admission, no undo policy).
	 * @internal
	 */
	get facade(): ViewDoc {
		return (this.lens ??= virtualLens(
			this.document.facade,
			() => this.document.ready,
			() => this.document.defaultChild(null),
			(kind) => ({
				childless: this.definitionOf(kind).void === true,
				rendersContent: this.document.rendersContent(kind)
			})
		));
	}

	// Document order: the view's walkers and block-selection keys read
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
	 * The document's shared undo manager — assigned at the end of `sync()`,
	 * never in the constructor, so history capture still starts only after
	 * the document decides its content state (the bootstrap-before-capture
	 * invariant: `document.sync()` seeds/asserts first, then attaches the
	 * manager). Only absent before first sync, which is also before the
	 * editor mounts, so all runtime readers see it set.
	 * @internal
	 */
	undoManager!: YUndoManager;
	/** The view's command dispatcher: every mutation this view makes goes through it. */
	readonly dispatcher: Dispatcher = new Dispatcher(this);

	/** An outermost `transact` of this view is running. */
	#transacting = false;
	/**
	 * One transaction of this view. The outermost call runs the normalization
	 * its operations requested at its end, inside the same transaction (one transaction, normalization once per touched parent): normalizers read
	 * handles over the index, so a command is one update and a peer never
	 * sees its un-normalized state. A throw from `cb` keeps the writes before
	 * it (a transaction is no rollback), so they are normalized too.
	 * `cb`'s error stays the one thrown: a normalizer that then throws is
	 * logged.
	 */
	transact = <T>(cb: () => T): T => {
		if (this.#transacting) return this.doc.transact(cb, this.transaction);
		this.#transacting = true;
		try {
			return this.doc.transact(() => {
				let out: T;
				try {
					out = cb();
				} catch (error) {
					try {
						this.dispatcher.drain();
					} catch (drained) {
						console.error('[edytor] normalization failed after a throw; continuing', drained);
					}
					throw error;
				}
				this.dispatcher.drain();
				return out;
			}, this.transaction);
		} finally {
			this.#transacting = false;
		}
	};

	/** Whether a block move (relative step or beside/inside a target) is structurally allowed. */
	canMove = (request: BlockMoveRequest): boolean => canMove(this, request);

	/**
	 * Move blocks one relative step, or before, after, inside or beside a live
	 * target block: resolved to the document's move (`moveBlocks`, an outdent's
	 * `unNestBlocks`, `placeBeside`) and announced. Answers the moved blocks.
	 */
	move = (request: BlockMoveRequest): Block[] => move(this, request);

	/** @internal This view's history (the named exception to commands through the dispatcher): bare engine undo/redo, one restorer. */
	readonly history = new History(this);

	/**
	 * Undo/redo through THIS view: the only history entry points that restore
	 * a view's selection (its recorded `before`/`after`); sibling views and a
	 * headless `document.history.undo()` restore none (their carets ride the
	 * change, as for a remote undo). A readonly view or a read-only document
	 * refuses them, as it refuses every command. Each call sets
	 * `dispatcher.last`: `refused`, `noop` (an empty stack) or `applied`.
	 */
	historyUndo = (): void => this.#replay('undo');
	historyRedo = (): void => this.#replay('redo');
	#replay = (command: 'undo' | 'redo') => {
		this.dispatcher.record({ operation: command, status: this.history.replay(command) });
	};

	constructor(options: EdytorOptions) {
		const {
			readonly,
			hotkeys,
			plugins,
			document,
			actor,
			requireHydration,
			presence,
			sync,
			value,
			onSelectionChange,
			labels,
			onChange,
			onDocChange,
			allowNesting
		} = options;
		if (labels) this.labels = labels;
		this.allowNesting = allowNesting === true;
		if (document !== undefined) {
			if (DEV && (actor !== undefined || requireHydration !== undefined)) {
				throw new Error(
					'EdytorOptions: `document` cannot be combined with `actor`/`requireHydration`: set them on the document.'
				);
			}
			this.document = document;
		} else {
			this.document = attachDocument(new Y.Doc(), { actor, requireHydration });
			this.#owned = true;
		}
		// The writes (`DocumentWrites`): every op the document prepares, dispatched.
		for (const name in this.document.facade.prepare)
			Object.defineProperty(this, name, {
				value: (...args: never) => this.dispatcher.operate(name as keyof DocumentWrites, args)
			});
		this.readonly = readonly || false;
		this.onChange = onChange;
		this.onDocChange = onDocChange;
		this.presence = new PresenceWriter(this.awareness, this.presenceKey, presence);

		// From here on a throw must unwind what this view already claimed
		// on the shared document: the enrolled history origin and the
		// awareness listeners — and, only when the view OWNS the document,
		// the document's attach reference itself. A borrowed/injected
		// document is never destroyed by a failed view.
		try {
			// Initialize plugins. Default children are merged across extensions
			// before definition precedence applies: two extensions declaring
			// different default children for one parent type is an error.
			const defaultChild: Record<string, string> = {};
			this.plugins = (plugins || []).map((plugin) => {
				const initializedPlugin = plugin(this);
				for (const [type, definition] of Object.entries(initializedPlugin.blocks ?? {})) {
					const child = typeof definition === 'object' ? definition.defaultChild : undefined;
					if (child !== undefined && (defaultChild[type] ??= child) !== child) {
						throw new SemanticConflictError(`defaultChild "${type}"`, defaultChild[type], child);
					}
				}

				// Duplicate definitions: the first extension wins (site docs plugins#plugin-order).
				define(this.marks, initializedPlugin.marks);
				define(this.blocks, initializedPlugin.blocks);
				define(this.inlineBlocks, initializedPlugin.inlineBlocks);
				for (const command of initializedPlugin.commands ?? [])
					if (!this.commands.has(command.id)) this.commands.set(command.id, command);
				return initializedPlugin;
			});

			// Kind records generate their commands; an extension's own command id wins.
			this.kinds = kindCatalogue(this.blocks);
			for (const row of this.kinds)
				if (!this.commands.has(row.id)) this.commands.set(row.id, kindCommand(this, row));

			this.placeholder = this.plugins.find((plugin) => plugin.placeholder)?.placeholder;

			// Contribute this view's capability to the document — roles,
			// `rendersContent` and default children outlive any single view.
			// The first declaration for a type is adopted; a conflicting one is
			// an error (views cannot silently impose incompatible structural
			// rules on a shared document). Atomic: a conflict validates before
			// ANYTHING is applied, so a failed view cannot half-seed semantics.
			const blocks = Array.from(this.blocks);
			this.document.adoptSemantics({
				roles: Object.fromEntries(
					blocks.map(([type, { void: v, island, lines, layout, table, atomic }]) => [
						type,
						{ void: v, island, lines, layout, table, atomic }
					])
				),
				rendersContent: Object.fromEntries(
					blocks.map(([type, definition]) => [type, definition.rendersContent !== false])
				),
				defaultChild,
				// A mark's edge decides where a concurrent insert at its ends lands.
				marks: Object.fromEntries(
					Array.from(this.marks)
						.filter(([, definition]) => definition.edge !== undefined)
						.map(([mark, { edge }]) => [mark, { edge }])
				)
			});

			// Enroll this view's local-edit origin in the document's history —
			// AFTER semantic adoption: a conflicting view must not strand a
			// tracked origin for a view that never came up. Identity tracking:
			// this document's undo manager captures THIS view's edits.
			this.document.trackOrigin(this.transaction);

			// Readiness: the document decides. A view seeds only the
			// document it owns, unless its own provider (`sync`) owns the
			// decision; every other view binds on the one readiness event
			// (`<Edytor>` decides an injected document at mount, once the
			// providers of its sibling views attached).
			if (this.#owned && !sync) {
				this.sync(value || { children: [] });
			} else {
				this.#readinessRelease = whenDocumentReady(this.document, () => {
					if (!this.destroyed) this.sync(value || { children: [] });
				});
			}

			this.selection = new EdytorSelection(this, onSelectionChange);
			this.keymap = new Keymap(this, hotkeys, this.plugins);
		} catch (error) {
			// Constructor failure — release what the partial view claimed:
			// the history origin (untracked live — already-captured commits
			// stay undoable) and the document attach reference when this
			// view owns it. Semantic
			// contributions already adopted stay — they are
			// document-lifetime additive declarations, and an injected
			// document's are left for the views that legitimately share it.
			this.document.untrackOrigin(this.transaction);
			if (this.#owned) {
				this.document.destroy();
			}
			throw error;
		}
	}

	/** Kinds already reported missing (DEV, once each). */
	#unknownKinds = new Set<string>();

	/**
	 * The definition of block kind `type` — the one lookup (render, surface,
	 * handles). A kind no plugin of this view registers (a rolling deploy, a
	 * peer's plugin) answers {@link UNKNOWN_KIND}: no roles, rendered as a
	 * plain block with its text and children; DEV warns once per kind.
	 */
	definitionOf = (type: string): BlockDefinition => {
		const definition = this.blocks.get(type);
		if (definition) return definition;
		if (DEV && type && type !== 'root' && !this.#unknownKinds.has(type)) {
			this.#unknownKinds.add(type);
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
		json: JSONDoc;
	} | null = null;

	/**
	 * Committed-change revision counter — the reactive subscription point
	 * for {@link value}. Bumped inside the facade `onChange` dispatch
	 * (before consumers are invoked) so every commit re-triggers tracked
	 * reads of the export.
	 * @internal
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
	get value(): JSONDoc {
		const revision = this.valueRevision;
		const version = this.facade.version;
		const root = this.root;
		const cache = this._valueCache;
		if (cache && cache.version === version && cache.revision === revision && cache.root === root) {
			return cache.json;
		}
		// `facade.toJSON()` is the canonical document export — the one
		// serializer; the root carries the document's data.
		const { data, children } = root ? this.facade.toJSON() : { children: [] };
		const json: JSONDoc = { type: 'root', ...(data && { data }), children };
		this._valueCache = { version, revision, root, json };
		return json;
	}

	runCommand = async (id: string) => {
		const command = this.commands.get(id);
		if (!command || command.isEnabled?.(this) === false) return false;
		await command.run(this);
		return true;
	};

	/** The adopted default type for a new child of `parent` — its actual parent. */
	defaultChild = (parent: Block): string =>
		this.document.defaultChild(parent.isRoot ? null : parent.type);

	/** Releases the readiness wait of a view bound before its document decided. */
	#readinessRelease: (() => void) | undefined;

	/** @internal */
	sync = ({ children = [], data }: JSONDoc = { children: [] }) => {
		if (this.synced) return;
		// The document owns the content decision: `assertSchema` on an
		// already-initialized (hydrated) doc, `init` on a still-fresh one,
		// then history attaches — the same deferral this method enforced
		// when the view owned it.
		this.document.sync({ children, data });

		this.undoManager = this.document.history;
		this.history.bind();
		this.cells = createCells(this.facade, this.surface.patched);
		this.root = this.idToBlock.root;
		this.#offCommit = this.facade.onChange(this.#onCommit);
		// Without its plugin, a view reads a document's shared suggestions as plain content.
		if (DEV && !this.suggestions.shared) {
			const warn = () => {
				if (asEngineDoc(this.document.doc).get(SUGGEST_ROOT).attrKeys().next().done) return;
				console.warn(
					'[edytor] this document holds shared suggestions: without createSharedSuggestionsPlugin() the view shows their text as plain content and exports it'
				);
			};
			if (this.document.ready) warn();
			else this.document.onReady(warn);
		}
		// A document that is already empty shows its virtual paragraph with the caret in it.
		this.selection?.restoreDeadSelectionEndpoints();
	};

	/** The commit subscription: editor-lifetime (a remount's `off` drain never releases it). */
	#offCommit?: () => void;

	/**
	 * One commit (local, remote, undo/redo): prune the handles of the removed
	 * blocks, then the selection's seam and the value consumers.
	 */
	#onCommit = (change: DocChange) => {
		this.valueRevision++;
		if (change.data) this.#dataRevision++;
		this.overlay.invalidate();
		// A commit this view did not issue re-renders under the caret: the
		// projector displays the current value after that flush.
		if (change.origin !== this.transaction) this.surface.update();
		// Remote/programmatic commits run under the scroll suppressor —
		// a remote commit landing inside an in-flight `isHandlingUserInput`
		// window must not scroll the page.
		this.suppressCaretScrollDepth++;
		try {
			this.idToBlock.prune(change);
			// Repair a selection that no longer resolves.
			this.selection?.restoreDeadSelectionEndpoints();
			// A live composition whose block was re-placed commits first.
			this.composition.restructured(change);
			// A suggestion whose block died is dropped.
			this.suggestions.prune();
		} finally {
			this.suppressCaretScrollDepth--;
		}
		// The report itself: no export. Each consumer is isolated (logged,
		// never rethrown), as the facade isolates its subscribers.
		const reports = [this.onDocChange, ...this.plugins.map((plugin) => plugin.onDocChange)];
		callEach('[edytor] onDocChange', reports.filter(isListener), change);
		// `this.value` is a full-document export (O(doc) — ~17ms at 5k
		// blocks) — compute it only when a consumer actually exists.
		const values = [this.onChange, ...this.plugins.map((plugin) => plugin.onChange)].filter(
			isListener
		);
		if (values.length > 0) callEach('[edytor] onChange', values, this.value);
	};

	/** The text each range `replace` suggestion removes when accepted (`Ranges`); a shared one's are its runs. */
	#replaced = () => {
		void this.suggestions.revision;
		return this.suggestions.list.flatMap(({ at, shared }) => {
			if (shared || !('replace' in at) || Array.isArray(at.replace)) return [];
			const { anchor, focus } = at.replace as SuggestionRange;
			const [start, end] = [anchor, focus].map(this.selection.resolveTextAnchor);
			return start && end ? [{ start, end }] : [];
		});
	};

	/**
	 * The placeholder block `id` shows: its cell has one empty
	 * text and no live composition in it; a function answers per block.
	 * A table's cell (by its role, `table.*`) shows none, as in Notion.
	 * @internal
	 */
	placeholderAt = (id: string): string | null => {
		const cell = this.cells?.get(id);
		const placeholder = this.placeholder;
		if (!placeholder || !cell || !placeholderOf(cell, this.composition.host?.parent.id === id))
			return null;
		if (this.facade.isTableCell(id)) return null;
		if (typeof placeholder === 'string') return placeholder;
		const { type, data = {} } = cell;
		const focused = this.idToBlock.block(id).focused;
		return placeholder({ type, data, focused, empty: true }, this) || null;
	};

	/** @internal */
	onBeforeInput = onBeforeInput.bind(this);
	/** @internal */
	onCopy = onCopy.bind(this);
	/** @internal */
	onCut = onCut.bind(this);
	/** @internal */
	onInput = onInput.bind(this);
	/** @internal */
	onPaste = onPaste.bind(this);
	/**
	 * Mark the synchronous extent of a real user-input event — see
	 * `isHandlingUserInput`. Deferred (rAF/timeout) work intentionally
	 * runs with the flag cleared so async restores can't trigger typing
	 * affordances long after the gesture ended.
	 */
	#userInputHandlingDepth = 0;
	#withUserInput = <A extends unknown[]>(handler: (...args: A) => unknown, bumpSerial = true) => {
		return (...args: A): unknown => {
			// Depth-counted: a synchronous wrapped listener landing inside an
			// awaited handler's hold window must not end the window the outer
			// handler still needs.
			this.#userInputHandlingDepth++;
			if (bumpSerial) this.markUserGesture();
			const clear = () => {
				// A display the window held back gets its pass now.
				if (--this.#userInputHandlingDepth === 0) this.projector.inputHandled();
			};
			try {
				const result = handler(...args);
				// Async handlers keep the flag until they settle — the
				// awaited model ops + selection writes are still "the
				// user's input". Timer/rAF-deferred restores run after
				// settlement and stay unflagged.
				if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
					// A failed async handler (a command's hook or write) surfaces
					// through the platform's error reporting; the DOM ignores
					// the listener's promise.
					void Promise.resolve(result).finally(clear).catch(reportError);
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
	 * @internal
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
	#expectInternalFocusArmed = false;
	/** @internal Armed, and `element` (the host, an editing host in it) focused without scrolling. */
	expectInternalFocus = (element?: HTMLElement | null) => {
		this.#expectInternalFocusArmed = true;
		queueMicrotask(() => {
			this.#expectInternalFocusArmed = false;
		});
		element?.focus({ preventScroll: true });
	};
	/** @internal A `focusin` consumes the armed flag: `true` when the editor focused itself. */
	consumeInternalFocus = (): boolean => {
		const armed = this.#expectInternalFocusArmed;
		this.#expectInternalFocusArmed = false;
		return armed;
	};
	/**
	 * The one gesture serial (Surface bookkeeping): pointer, focus, key,
	 * `beforeinput`, cut, paste and drop bump it; an `input` does not (it
	 * records what the browser did, not where the user wants the selection).
	 * Attempts are per occurrence (`attempts`), not counted here.
	 * @internal
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
	 * @internal
	 */
	lastUserGestureOutsideEditor = false;
	/** @internal Run `body` as part of the user's input (deferred work of an occurrence). */
	userInput = <T>(body: () => T) => this.#withUserInput(body, false)();
	/**
	 * A commit's caret: select it (the projector displays it once the pin's
	 * render lands) and arm the IME post-commit jump rule — a move right after
	 * the commit with no gesture since is displayed back (`surface/projector`).
	 * @internal
	 */
	stabilizeCompositionSelection = (text: Text, offset: number) => {
		if (this.readonly || this.isComposing || !text.isInDocument) return;
		const active = getActiveElement(this.node);
		const ours = (node?: Node | null) => Boolean(node && this.node?.contains(node));
		// Focus left for a foreign element with no selection of ours, or moved
		// into a nested editable island (its own caret): the user owns it.
		if (
			(active &&
				!focusIn(this.node) &&
				!ours(getDomSelection(this.node)?.anchorNode) &&
				!ours(this.selection.textRange().startText?.node)) ||
			isKindControl(this.node, active)
		)
			return;
		this.projector.committed();
		this.selection.selectText(text, Math.min(offset, text.length));
	};
	/** An event of this view's own composition (not a native control's, not a nested island's). */
	#ownComposition = (event?: Event) => !event || !isControlEvent(this.node, event);

	/** @internal */
	onCompositionStart = (event?: CompositionEvent) => {
		if (!this.#ownComposition(event)) return;
		this.composition.start(() => getDomSelectionSnapshot(this.node));
	};

	/** @internal `compositionend`: the live session's commit, or its explicit cancel; the tail swallows a late one. */
	onCompositionEnd = (event?: CompositionEvent) => {
		if (!this.#ownComposition(event) || this.readonly) return;
		const value = event?.data ?? this.composition.preview;
		if (value) this.composition.commit(value);
		else this.composition.cancel();
	};

	/** @internal The handle of the `ordinal`-th text segment of block `id` (the element a cell segment renders). */
	textAt = (id: string, ordinal: number): Text => this.idToBlock.text(id, ordinal);

	/** @internal The cell segment the element of `text` renders (the frozen list while pinned). */
	segmentOf = (text: Text): { cell: Cell; segment: Segment } | null => {
		const cell = this.cells?.get(text.parent.id);
		const part = cell && this.pin.parts(cell).filter((p) => p.kind === 'text')[text.ordinal];
		return cell && part?.kind === 'text' ? { cell, segment: part } : null;
	};

	/** @internal The render deltas the element of `text` shows. */
	deltasOf = (text: Text): readonly RenderDelta[] => {
		const at = this.segmentOf(text);
		if (!at) return [];
		const { cell, segment } = at;
		return this.pin.shown(cell, segment, this.definitionOf(cell.type).transformText);
	};

	/** @internal The handle of inline atom `atom`, shown in block `id`. */
	atomAt = (id: string, atom: string): InlineBlock => this.idToBlock.atom(id, atom);

	/**
	 * Focus the editor, as a click in it would, without scrolling: the
	 * selection it has stays, and with none the caret goes to the start of
	 * the first text. For a menu button or a shortcut outside the editor.
	 */
	focus = (): void => {
		if (this.selection.value.kind === 'none') {
			const text = this.root?.firstText;
			if (text) this.selection.selectText(text, 0);
		}
		takeKeys(this);
	};

	/**
	 * Replace the whole document with one empty block and put the caret in it,
	 * as one undo step. A readonly view or a read-only document refuses it
	 * (`dispatcher.last` reads `refused`). Answers whether it applied.
	 */
	clear = (): boolean => {
		const newBlock = this.dispatcher.run('clear', () =>
			this.transact(() => {
				for (const child of this.facade.childrenIds(null).reverse())
					this.deleteBlock(child, { keepChildren: false });
				const block = { id: id('b'), type: this.defaultChild(this.root!) };
				this.insertBlocks({ parent: null, index: 0 }, [block]);
				return this.idToBlock.block(block.id);
			})
		);
		if (!newBlock) return false;
		this.dispatcher.record({ operation: 'clear', status: 'applied' });
		this.selection.selectText(newBlock.firstText ?? this.root?.children[0]?.firstText, 0);
		this.focus();
		return true;
	};

	/** @internal */
	attach = (node: HTMLDivElement) => {
		// A remount must not inherit a stale "user is outside" verdict —
		// ownership is re-derived from live gestures from here on.
		this.lastUserGestureOutsideEditor = false;
		this.node = node;
		this.selection.init();
		// The engine's transaction events the projector and the observer read.
		const engine = [
			['beforeAllTransactions', this.projector.opening],
			['beforeTransaction', this.surface.pending],
			['beforeTransaction', this.projector.before],
			['afterTransaction', this.projector.after]
		] as const;
		for (const [name, listener] of engine) this.doc.on(name, listener as never);
		this.off.push(() => {
			for (const [name, listener] of engine) this.doc.off(name, listener as never);
		});
		// Keydown serial bumps happen INSIDE onKeyDown, after the
		// composition-phantom swallow — a swallowed trailing Enter/Backspace
		// is a browser artifact, not a gesture, and must not disarm pending
		// composition caret restores.
		const user = this.#withUserInput;
		const keydown = user(onKeyDown.bind(this), false);
		const { pointer } = this.selection;
		const drop = (event: DragEvent) => preventUnsupportedDrop(event, this);
		/** The host's listeners; the user-input ones run inside its window (`isHandlingUserInput`). */
		const host: [string, (event: never) => unknown][] = [
			['mousedown', pointer.preventTripleClick],
			['click', pointer.tripleClick],
			// Settle queued mutation repairs before the native menu opens —
			// spellcheck suggestions are computed against the DOM at this
			// moment (PM flushes its DOM observer on contextmenu for the
			// same reason).
			['contextmenu', () => void this.surface.flush()],
			['beforeinput', user(this.onBeforeInput)],
			// An `input` records what the browser did; it says nothing new about
			// where the user wants the selection (a display still to land wins).
			['input', user(this.onInput, false)],
			['copy', this.onCopy],
			['cut', user(this.onCut)],
			['paste', user(this.onPaste)],
			['dragstart', (event: DragEvent) => onTextDragStart(this, event)],
			['dragend', () => onTextDragEnd(this)],
			['dragover', drop],
			['drop', user(drop)],
			['compositionstart', this.onCompositionStart],
			['compositionend', this.onCompositionEnd]
		];
		const detachSurface = this.surface.attach(node);
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
			// The page leaving for good ends the session's history.
			attachPageHide(this),
			...host.map(([type, listener]) => on(node, type, listener as EventListener)),
			detachSurface
		);

		// Chrome lives in the overlay, outside the host: remote carets, the
		// text a `replace` suggestion removes, marked beside the host, the
		// polite live region (what this view's block moves and deletes did);
		// the plugins' after them.
		const detachOverlay = this.overlay.attach(node);
		const target = this.overlay.layer!;
		const mounted = (
			[
				[RemoteSelections, { edytor: this }],
				[Ranges, { edytor: this, name: 'suggestion-range', z: 19, ranges: this.#replaced }],
				[Announcer, { announcer: this.announcer }]
			] as [Component<never>, object][]
		).map(([component, props]) => mount(component, { target, props: props as never }));
		this.off.push(() => mounted.forEach((instance) => void unmount(instance)), detachOverlay);
		this.off.push(...cleanups(this.plugins, (plugin) => plugin.onEdytorAttached?.({ node })));

		return {
			destroy: () => {
				if (selectionIsInside(node)) clearDomSelection(node);
				const active = focusIn(node);
				if (active instanceof HTMLElement) active.blur();
				this.#detach();
			}
		};
	};

	/**
	 * Release what an attach holds: the selection's listeners, the attempts,
	 * the composition, then the attach-lifetime batch (DOM listeners, the
	 * mutation observer, plugin actions), drained AND cleared (`destroy()`
	 * runs it again).
	 */
	#detach = () => {
		this.selection.destroy();
		this.attempts.clear();
		this.composition.reset();
		this.off.splice(0).forEach((off) => off());
	};

	/** @internal */
	destroyed = false;
	/** @internal The key of this view's presence entry — minted here, written only by this view. */
	readonly presenceKey = mintPresenceKey();
	/** This view's presence writer: what it shares (`share`) and how often (`throttle`, ms); both settable. */
	presence!: PresenceWriter;
	/**
	 * Edytor-lifetime teardown. `Edytor.svelte` owns the instance and calls
	 * this from its `onDestroy` (after a server render too); consumers
	 * holding a bare `Edytor` (test harnesses, custom mounts,
	 * dialogs/tabs/multi-editor views) must call it when the editor is
	 * discarded.
	 *
	 * Releases every listener the editor holds on potentially-SHARED objects
	 * — an injected document outlives a single editor, so an
	 * undestroyed mount leaks a facade `update` listener and the undo
	 * manager's doc observers forever.
	 *
	 * Idempotent, and safe on an editor that was never attached or synced
	 * (the undo manager exists only after first `sync()`).
	 */
	destroy = () => {
		if (this.destroyed) return;
		this.destroyed = true;
		// This view's presence entry — its own key, cleared by its own teardown.
		this.presence.clear();

		// A pending readiness binding must not resurrect a dead view.
		this.#readinessRelease?.();
		this.#readinessRelease = undefined;

		this.#detach();
		this.#offCommit?.();
		this.history.unbind();
		this.cells?.dispose();

		// Wrapper maps — drop every id/node→wrapper edge a shared doc or a
		// stray mutation could still reach.
		this.idToBlock.clear();
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
		if (this.#owned) {
			this.document.destroy();
		}
	};
}

export const useEdytor = () => {
	if (!hasContext('edytor')) throw new Error('No Edytor found');
	return getContext<Edytor>('edytor');
};
