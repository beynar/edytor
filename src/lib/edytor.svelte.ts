import { getContext, hasContext, setContext, tick, type Snippet, onMount } from 'svelte';
import { onBeforeInput } from './events/onBeforeInput.js';
import { onCopy } from './events/onCopy.js';
import { onCut } from './events/onCut.js';
import { observeDomTextMutations } from './events/domTextMutationObserver.js';
import { isNativeInteractiveEvent } from './events/nativeInteractiveControl.js';
import { onInput } from './events/onInput.js';
import { onPaste } from './events/onPaste.js';
import { preventUnsupportedDrop } from './events/onDrop.js';
import { type JSONBlock, type JSONDoc, type SerializableContent } from '$lib/utils/json.js';
import { onKeyDown } from '$lib/events/onKeyDown.js';
import { EdytorSelection } from './selection/selection.svelte.js';
import { Block, jsonBlockToSpec } from './block/block.svelte.js';
import { Text } from './text/text.svelte.js';
import { SvelteMap } from 'svelte/reactivity';
import { Y } from '$lib/crdt/engine.js';
import {
	Awareness,
	bindCrdt,
	type DocChange,
	type EdytorDoc,
	type EngineDoc,
	type ProjectedBlock,
	type ProjectedDoc,
	type YDoc,
	type YUndoManager
} from '$lib/crdt/index.js';
import type { YBlockLike } from '$lib/crdt/compat.js';
import { batch } from './block/block.utils.js';
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
import { REMOTE_ONLY_TRANSACTION, TRANSACTION } from './constants.js';
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
	removeStalePlaceholdersIn,
	removeStalePlaceholders,
	scheduleRemoveStalePlaceholdersIn,
	scheduleRemoveStalePlaceholders
} from './text/removeStalePlaceholders.js';

export type Snippets = {
	[K in `${string}Block` | `${string}Mark`]: K extends `${string}Block`
		? Snippet<
				[
					{
						block: Block;
						children: Snippet | null;
						content: Snippet;
					}
				]
			>
		: Snippet<
				[
					{
						mark: SerializableContent;
						text: Text;
						content: Snippet;
					}
				]
			>;
};

export type EdytorOptions = {
	readonly?: boolean;
	snippets?: Snippets;
	hotKeys?: Record<string, HotKey>;
	plugins?: Plugin[];
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
 * Facade methods that mutate the document — the `Edytor.facade` proxy bumps
 * `_docVersion` after each so the memoized live projection stays coherent.
 */
const FACADE_MUTATORS = new Set([
	'init',
	'insertBlock',
	'moveBlock',
	'moveBlocks',
	'nestBlock',
	'unNestBlock',
	'splitBlock',
	'mergeBlocks',
	'mergeBackward',
	'mergeForward',
	'deleteBlock',
	'setBlock',
	'setBlockType',
	'setBlockData',
	'duplicateBlock',
	'insertText',
	'deleteText',
	'setMark',
	'unsetMark',
	'formatRange',
	'clearMarks',
	'insertInline',
	'removeInline',
	'setInlineData',
	'transact'
]);

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
	remoteOnlyTransaction = new REMOTE_ONLY_TRANSACTION();
	hotKeys: HotKeys;
	initialized = $state(false);
	readonly = $state(false);
	yRootBlock: YBlockLike;
	root = $state<Block>();
	editorDomRevision = $state(0);
	remotePresenceRevision = $state(0);
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
		restoreSelectionAfterCommit?: {
			textId: string;
			offset: number;
		};
	} | null = null;
	compositionStartReplacementState: SelectionReplacementState | null = null;
	isComposing = $state(false);
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
	private danglingCompositionBlurTimer: ReturnType<typeof setTimeout> | null = null;
	private compositionEndedAt = Number.NEGATIVE_INFINITY;

	// CRDT (v14) — exactly one engine doc per editor; the facade is the only
	// structural read/write surface.
	crdt = bindCrdt(Y);
	doc: YDoc = this.crdt.createDoc();
	facade: EdytorDoc;
	/**
	 * Bumped on every mutating facade call and every committed change —
	 * invalidates the memoized live projection (`_projectedTree`). Needed
	 * because the maintained runs view (`facade.runs`) only refreshes at
	 * commit, while op code must observe writes made earlier in the same
	 * uncommitted transaction (v13 `Y.Text` semantics).
	 */
	_docVersion = 0;
	/**
	 * Counts committed document transactions (local, remote, undo/redo) —
	 * bumped only inside the facade `onChange` listener. Selection-restore
	 * code reads this to detect real edits landing in an async restore
	 * window; `_docVersion` also bumps on non-commit cache invalidation.
	 */
	_docCommitVersion = 0;
	private _treeCache: {
		version: number;
		doc: ProjectedDoc;
		index: Map<string, ProjectedBlock>;
	} | null = null;
	/**
	 * Created at the end of `sync()` — never in the constructor — so the
	 * facade's bootstrap-before-capture init stays a no-op on provider paths
	 * (see {@link createUndoManager}). Only absent before first sync, which is
	 * also before the editor mounts, so all runtime readers see it set.
	 */
	undoManager!: YUndoManager;
	awareness: Awareness;
	/**
	 * The DocChange currently being applied to the mirror (set while the
	 * facade onChange dispatch runs) — lets wrappers distinguish
	 * remote/programmatic updates from local ops.
	 */
	_mirrorChange: DocChange | null = null;
	/** Detached block wrappers awaiting adoption onto a fresh facade id. */
	_pendingBlocks = new Map<string, Block>();

	transact = <T>(cb: () => T): T => {
		this.suppressObservedMutationFallback();
		return this.doc.transact(() => {
			const result = cb();
			return result;
		}, this.transaction);
	};

	refreshEditorDom = () => {
		this.editorDomRevision += 1;
	};

	refreshRemotePresence = () => {
		this.remotePresenceRevision += 1;
	};

	constructor({
		snippets,
		readonly,
		hotKeys,
		plugins,
		doc = this.doc,
		awareness = new Awareness(doc),
		sync,
		value,
		onSelectionChange,
		placeholder,
		onChange
	}: EdytorOptions) {
		this.readonly = readonly || false;
		this.doc = doc;
		const rawFacade = this.crdt.doc.create(this.doc as unknown as EngineDoc, {
			roleOf: (type) => this.blocks.get(type),
			defaultType: this.defaultType
		});
		// Bump `_docVersion` after every mutating facade call so the memoized
		// live projection is invalidated before any subsequent read — including
		// reads inside the same uncommitted transaction.
		this.facade = new Proxy(rawFacade, {
			get: (target, key, receiver) => {
				const value = Reflect.get(target, key, receiver);
				if (typeof value === 'function' && FACADE_MUTATORS.has(key as string)) {
					return (...args: unknown[]) => {
						const result = value.apply(target, args);
						this._docVersion++;
						return result;
					};
				}
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		this.yRootBlock = {
			get: () => undefined,
			set: () => {},
			_item: null,
			doc: this.doc
		};
		this.awareness = awareness;
		this.awareness.on('change', this.refreshRemotePresence);
		this.awareness.on('update', this.refreshRemotePresence);
		this.onChange = onChange;

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

		// We set the custom snippets after plugins are initialized in order to be able to override the plugins snippets
		Object.entries(snippets || {}).forEach(([key, snippet]) => {
			const isMark = key.endsWith('Mark');
			const isInlineBlock = key.endsWith('InlineBlock');
			const isBlock = key.endsWith('Block');
			if (isMark) {
				this.marks.set(key, { snippet: snippet as Snippet<[MarkSnippetPayload]> });
			} else if (isInlineBlock) {
				// this.inlineBlocks.set(key, { snippet: snippet as Snippet<[InlineBlockSnippetPayload]> });
			} else if (isBlock) {
				this.blocks.set(key, { snippet: snippet as Snippet<[BlockSnippetPayload]> });
			}
		});

		this.placeholder =
			placeholder || this.plugins.find((plugin) => plugin.placeholder)?.placeholder;

		if (readonly || !sync) {
			this.sync(value || { children: [] });
		}

		this.selection = new EdytorSelection(this, onSelectionChange);
		this.hotKeys = new HotKeys(this, hotKeys, this.plugins);
	}

	/**
	 * `createUndoManager` auto-`init`s an uninitialized doc so the bootstrap
	 * predates undo capture. On the provider-sync path the manager must NOT be
	 * created eagerly in the constructor: doing so stamps `meta.v` + inserts a
	 * bootstrap block before `sync()` runs, making the deferred `sync()` see an
	 * "initialized" doc and skip the initial value — and broadcasting a stray
	 * bootstrap block to the room. Creating it at the end of `sync()` keeps the
	 * bootstrap-before-capture invariant on every path: after seeding (fresh
	 * doc) or after binding (already-initialized doc), `init` inside
	 * `createUndoManager` is a no-op and the seed itself is never captured as
	 * an undo step.
	 */
	private createUndoManager = () => {
		this.undoManager ??= this.facade.createUndoManager({
			trackedOrigins: new Set([this.transaction, null])
		});
	};

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

	get value(): JSONBlock {
		return {
			type: 'root',
			children: this.root?.value.children || []
		};
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
		if (!parent || parent instanceof Edytor) {
			return 'paragraph';
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
		return 'paragraph';
	};
	sync = ({ children = [] }: JSONDoc = { children: [] }) => {
		if (this.synced) {
			return;
		}

		this.initialized = this.facade.isInitialized();
		if (this.initialized) {
			// Synced doc — gate on the schema before trusting it (U07).
			this.facade.assertSchema();
		} else {
			// Fresh doc — stamp the schema and insert the initial children (or
			// the bootstrap block when `children` is empty).
			this.facade.init({
				content: children.map((child) => jsonBlockToSpec(child)),
				defaultType: this.defaultType
			});
		}

		this.root = new Block({
			edytor: this,
			blockId: null
		});
		this.root.reconcileChildren(this.projectedChildren(null));
		// The root has no facade content node — give it the same empty-text
		// sentinel mirror shape blocks get so `root.content` invariants hold.
		this.root.reconcileContent([]);

		this.createUndoManager();
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
			// Committed changes that bypassed the facade proxy (undo, remote
			// updates) still invalidate the memoized projection.
			this._docVersion++;
			// Pure committed-transaction counter — unlike `_docVersion` it is
			// NOT bumped by mutating facade calls or change-sub reattachment,
			// so pending history selection restores can use it to tell "the
			// user typed into the restore window" from an invalidation bump.
			this._docCommitVersion++;
			this._mirrorChange = change;
			try {
				this.flushMirror();
			} finally {
				this._mirrorChange = null;
			}
			this.refreshRemotePresence();
			const value = this.value;
			this.onChange?.(value);
			this.plugins.forEach((plugin) => {
				plugin.onChange?.(value);
			});
			const removeRenderedStalePlaceholders = () => {
				removeStalePlaceholdersIn(this.node);
				for (const text of this.idToText.values()) {
					removeStalePlaceholders(text);
				}
			};
			void tick().then(() => {
				removeRenderedStalePlaceholders();
				scheduleRemoveStalePlaceholdersIn(this.node);
				for (const text of this.idToText.values()) {
					scheduleRemoveStalePlaceholders(text);
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
			// mirror now rather than trusting the (possibly stale) memoized tree.
			this._docVersion++;
			this.flushMirror();
		}
	};

	/**
	 * The live projected tree — `facade.project()` reads current node state,
	 * so unlike the maintained runs view it reflects writes made earlier in
	 * the SAME uncommitted transaction (v13 `Y.*` read semantics). Memoized
	 * on `_docVersion`, which every mutating facade call and every committed
	 * change bumps.
	 */
	private _projectedTree = (): {
		doc: ProjectedDoc;
		index: Map<string, ProjectedBlock>;
	} => {
		if (this._treeCache?.version === this._docVersion) {
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
		this._treeCache = { version: this._docVersion, doc, index };
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

	/** True while `blockId` is visible in the projected tree. */
	isVisibleBlockId = (blockId: string): boolean => this._projectedTree().index.has(blockId);

	/**
	 * Reconcile the wrapper tree with the projected tree. Called by the facade
	 * onChange dispatch on every commit, and directly by compat adapters after
	 * an op so intra-transaction mirror reads (`parent.children`, `content`)
	 * stay fresh.
	 */
	flushMirror = () => {
		if (!this.root) {
			return;
		}
		this.root.reconcileChildren(this.projectedChildren(null));
	};

	onBeforeInput = onBeforeInput.bind(this);
	onCopy = onCopy.bind(this);
	onCut = onCut.bind(this);
	onInput = onInput.bind(this);
	onPaste = onPaste.bind(this);
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
		if (!this.structuralKeyFallbackTimer) {
			return;
		}

		clearTimeout(this.structuralKeyFallbackTimer);
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
		this.structuralKeyFallbackTimer = setTimeout(() => {
			this.structuralKeyFallbackTimer = null;
			this.structuralKeyFallbackInputType = null;
			void (async () => {
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
				void this.onBeforeInput(event);
			})();
		});
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
		const textId = typeof textOrId === 'string' ? textOrId : textOrId.id;
		const restore = async () => {
			if (this.readonly || this.isComposing) {
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

			const text = this.getTextById(textId);
			if (!text) {
				return;
			}

			await this.selection.setAtTextOffset(text, Math.min(offset, text.length));
		};

		this.clearCompositionSelectionRestore();
		await restore();

		if (typeof requestAnimationFrame === 'function') {
			this.compositionSelectionRestoreFrame = requestAnimationFrame(() => {
				this.compositionSelectionRestoreFrame = null;
				void restore();
			});
		}

		this.compositionSelectionRestoreTimers = [
			setTimeout(() => {
				void restore();
			}, 0),
			setTimeout(() => {
				void restore();
			}, 30)
		];
	};
	onCompositionStart = (event?: CompositionEvent) => {
		if (event && isNativeInteractiveEvent(event)) {
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
	};
	onCompositionEnd = async (event?: CompositionEvent) => {
		if (event && isNativeInteractiveEvent(event)) {
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
			await this.stabilizeCompositionSelection(target.text, target.offset + finalValue.length);
			return;
		}

		const text = this.getTextById(state.textId);
		if (!text) {
			return;
		}

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
				.getMarksAtRange(state.startOffset, state.startOffset + state.value.length)
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
		if (finalValue === state.value) {
			if (await restoreInterruptedSelection()) {
				return;
			}
			await this.stabilizeCompositionSelection(text, state.startOffset + finalValue.length);
			return;
		}

		const finalMarks = getFinalCompositionMarks();
		if (state.value.length > 0) {
			text.yText.delete(state.startOffset, state.value.length);
		}

		if (finalValue.length > 0) {
			text.insertText({
				value: finalValue,
				start: state.startOffset,
				end: state.startOffset,
				marks: finalMarks
			});
		}

		if (await restoreInterruptedSelection()) {
			return;
		}

		await this.stabilizeCompositionSelection(text, state.startOffset + finalValue.length);
	};

	shouldIgnoreCompositionKeyDown = (event: KeyboardEvent) => {
		if (this.isComposing || event.isComposing) {
			return true;
		}

		const isBackspaceWithExplicitSelection =
			event.key === 'Backspace' &&
			(!this.selection.state.isCollapsed ||
				this.selection.selectedBlocks.size > 0 ||
				this.selection.selectedInlineBlock.size > 0);
		if (isBackspaceWithExplicitSelection) {
			return false;
		}

		const shouldGuardPostCompositionKey =
			event.key === 'Enter' || (event.key === 'Backspace' && isAppleWebKitBrowser());
		if (!shouldGuardPostCompositionKey) {
			return false;
		}

		const elapsed = getEventTimeStamp(event) - this.compositionEndedAt;
		if (elapsed < 0 || elapsed > 500) {
			return false;
		}

		this.compositionEndedAt = Number.NEGATIVE_INFINITY;
		event.preventDefault();
		event.stopPropagation();
		return true;
	};

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

	getBlockByIdOrContent = (idOrContent: string | Text): Block | undefined => {
		if (typeof idOrContent === 'string') {
			const isText = idOrContent.startsWith('t');
			const isBlock = idOrContent.startsWith('b');
			if (isBlock) {
				return this.idToBlock.get(idOrContent);
			} else if (isText) {
				const text = this.idToText.get(idOrContent);
				return text?.parent;
			}
		} else if (idOrContent instanceof Text) {
			return idOrContent.parent || undefined;
		}
		return undefined;
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
			root.yChildren.delete(0, root.yChildren.length);
			newBlock = new Block({
				edytor: this,
				parent: this.root,
				block: {
					type: 'paragraph'
				}
			});
			root.yChildren.push([newBlock.yBlock]);
		});
		this.refreshEditorDom();

		tick().then(async () => {
			this.node?.focus({ preventScroll: true });
			const targetText = newBlock?.firstText ?? this.root?.children[0]?.firstText;
			await this.selection.setAtTextOffset(targetText, 0);
		});
	};

	attach = (node: HTMLDivElement) => {
		let lastPointerDownInsideEditorAt = Number.NEGATIVE_INFINITY;

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

				if (applyMeaningfulDomSelection()) {
					return;
				}

				const liveText = this.idToText.get(textId);
				if (!liveText?.node?.isConnected) {
					return;
				}

				await this.selection.setAtTextOffset(liveText, Math.min(offset, liveText.length));
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
		this.off.push(
			on(node, 'keydown', handleKeyDownCapture, { capture: true }),
			on(node.ownerDocument, 'keydown', onKeyDown.bind(this)),
			on(node, 'pointerdown', handlePointerDown),
			on(node, 'pointerup', handlePointerUp),
			on(node, 'click', this.selection.handleTripleClick),
			on(node, 'beforeinput', this.onBeforeInput),
			on(node, 'input', this.onInput),
			on(node, 'copy', this.onCopy),
			on(node, 'cut', this.onCut),
			on(node, 'paste', this.onPaste),
			on(node, 'dragover', preventUnsupportedDrop),
			on(node, 'drop', preventUnsupportedDrop),
			on(node, 'focusin', restoreCachedSelectionAfterKeyboardFocus),
			on(node, 'focusout', handleFocusOut),
			on(node, 'compositionstart', this.onCompositionStart),
			on(node, 'compositionend', this.onCompositionEnd),
			observeDomTextMutations(this, node)
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
	 * undestroyed mount leaks a facade `update` listener, two awareness
	 * listeners and the undo manager's doc observers forever, and every dead
	 * editor still runs `refreshRemotePresence` on each presence tick.
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

		// Awareness subscriptions bound in the constructor.
		this.awareness.off('change', this.refreshRemotePresence);
		this.awareness.off('update', this.refreshRemotePresence);

		// Doc observers held by the undo manager (absent before first sync).
		this.undoManager?.destroy();

		// Runs the whole attach-lifetime batch — DOM listeners, the mutation
		// observer, plugin actions, and the facade-change release (which
		// clears `_facadeChangeOff`) — and empties the array.
		this.off.splice(0).forEach((off) => off());

		// The facade's doc `update` subscription + its lease on the shared
		// run view (no-op if never subscribed).
		this.facade.dispose();

		// `selectionchange` listener + the published remote caret.
		this.selection.destroy();

		this.clearInputFallbackSuppression();
		this.clearCompositionSelectionRestore();
		this.clearDanglingCompositionBlurTimer();
		this.cancelStructuralKeyFallback();

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
	};
}

export const useEdytor = () => {
	const hasEdytorContext = hasContext('edytor');

	if (hasEdytorContext) {
		return getContext<Edytor>('edytor');
	}
	throw new Error('No Edytor found');
};
