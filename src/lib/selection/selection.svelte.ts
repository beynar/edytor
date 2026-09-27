import type { Edytor } from '../edytor.svelte.js';
import { Text } from '../text/text.svelte.js';
import {
	climbDom,
	getInlineBlockOfNode,
	getInlineBlockInSelectedRange,
	getRangesFromSelection,
	getTextOfNode,
	getTextsInSelection,
	getVerticalLineDestination,
	getYIndex,
	getMarkEdgeSide,
	isTextBoundSelectionPoint,
	normalizeUtf16Boundary
} from './selection.utils.js';
import {
	clearDomSelection,
	createDomSelectionSnapshotFromRange,
	createDomRange,
	domSelectionCoversRange,
	domSelectionIsCollapsedAt,
	getActiveElement,
	getDomSelection,
	getDomSelectionSnapshot,
	scrollCaretIntoView,
	type DomSelectionSnapshot
} from './domSelection.js';
import { Block } from '../block/block.svelte.js';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { tick } from 'svelte';
import { InlineBlock } from '../block/inlineBlock.svelte.js';
import type { EdgeSide } from '$lib/session/editing/text.js';
import type { JSONInlineBlock, JSONText } from '$lib/utils/json.js';
import {
	clearAwarenessSelection,
	publishAwarenessSelection
} from '$lib/collaboration/awarenessSelection.js';
import {
	isNativeFormControl,
	isNativeInteractiveEvent,
	isNestedForeignEditableTarget
} from '$lib/events/nativeInteractiveControl.js';
import type { Anchor } from '$lib/crdt/text/model.js';
import {
	atomSelection,
	blockSelection,
	noSelection,
	project,
	sameValue,
	segmentsOf,
	textSelection,
	anchorsInOrder,
	type SelectCause,
	type SelectionProjection,
	type SelectionSegment,
	type SelectionValue
} from '$lib/session/selection.js';
import { seam } from '$lib/crdt/anchors.js';
import { getTextPath, isAndroidChromeBrowser } from '$lib/events/events.utils.js';

/**
 * CRDT-stable anchor for a text position — `{b}` is the home block id of
 * the BACKING text the bound atom lives in (not necessarily the block that
 * displays it — merges/splits reroute display while the anchor stays on
 * the same atoms), `a` the engine anchor carrying the endpoint affinity in
 * its `a` field (`a < 0` = left, `a >= 0` = right). JSON-serializable;
 * replaces the v13 `RelativePosition`. Same wire shape as `DocAnchor` on
 * the facade (`facade.anchorAt`/`facade.resolveAnchor`).
 */
export type TextAnchor = { b: string; a: Anchor; o?: string };

type SelectionState = {
	yStart: number;
	yEnd: number;
	length: number;
	content: string;
	isCollapsed: boolean;
	isReversed: boolean;
	// If the selection is at the start of the block
	isAtStartOfBlock?: boolean;
	// If the selection is at the end of the block
	isAtEndOfBlock?: boolean;
	// If the selection is at the start of the text
	isAtStartOfText?: boolean;
	// If the selection is at the end of the text
	isAtEndOfText?: boolean;
	startText: Text | null;
	endText: Text | null;
	startBlock: Block | null;
	endBlock: Block | null;
	texts: Text[];
	contentParts: (Text | InlineBlock)[];
	blocks: Block[];
	startNode: Node | null;
	endNode: Node | null;
	isTextSpanning: boolean;
	isBlockSpanning: boolean;
	isVoid: boolean;
	voidRoot: Block | null;
	isVoidEditableElement: boolean;
	isIsland: boolean;
	islandRoot: Block | null;
	relativePosition: TextAnchor | null;
	/**
	 * The range END's backing-text anchor — the `relativePosition` twin.
	 * `null` for collapsed carets (the end IS the start) and for states
	 * with no text endpoint; populated on non-collapsed derives so remote
	 * edits landing inside the end text re-map the end instead of leaving
	 * `yEnd` stale. Bound 'left' — concurrent inserts at the end boundary
	 * stay outside the range (the awareness `end` convention).
	 */
	endPosition: TextAnchor | null;
	currentMarks: JSONText['marks'];
	/** R4 admission: the mark-edge side of a DOM-derived caret (`marksForInsertion`). */
	edge?: EdgeSide;
};

/** An inline suggestion (L12): content parts shown after a block's text until cleared. */
export type SuggestionParts = (JSONText[] | JSONInlineBlock)[];

/** The compatibility state of no (or an unresolvable) selection. */
const EMPTY_STATE: SelectionState = Object.freeze({
	yStart: 0,
	yEnd: 0,
	length: 0,
	content: '',
	isCollapsed: true,
	isReversed: false,
	texts: [],
	blocks: [],
	contentParts: [],
	isAtStartOfBlock: false,
	isAtEndOfBlock: false,
	isAtStartOfText: false,
	isAtEndOfText: false,
	startNode: null,
	endNode: null,
	startText: null,
	endText: null,
	startBlock: null,
	endBlock: null,
	isTextSpanning: false,
	isBlockSpanning: false,
	isVoid: false,
	isIsland: false,
	islandRoot: null,
	isVoidEditableElement: false,
	voidRoot: null,
	relativePosition: null,
	endPosition: null,
	currentMarks: {}
}) as SelectionState;

/** Whether a DOM selection runs backward (focus before anchor in document order). */
export const isBackward = (selection: {
	anchorNode: Node | null;
	anchorOffset: number;
	focusNode: Node | null;
	focusOffset: number;
}) =>
	selection.focusNode === selection.anchorNode
		? selection.focusOffset < selection.anchorOffset
		: Boolean(
				selection.anchorNode &&
				selection.focusNode &&
				selection.anchorNode.compareDocumentPosition(selection.focusNode) &
					Node.DOCUMENT_POSITION_PRECEDING
			);

const SYNTHETIC_TEXT_OVERLAY_SELECTOR =
	'[data-edytor-text-placeholder], [data-edytor-text-suggestion]';
const TEXT_PLACEHOLDER_SELECTOR = '[data-edytor-text-placeholder]';
/** Content hidden by view state: a collapsed toggle's body, a `hidden` subtree. */
const HIDDEN = '[hidden], details:not([open]) > :not(summary)';

const getElementFromNode = (node: Node | null) => {
	if (!node || typeof Element === 'undefined') {
		return null;
	}

	if (node instanceof Element) {
		return node;
	}

	return node.nodeType === Node.TEXT_NODE ? node.parentElement : null;
};

const getSyntheticTextOverlayElement = (node: Node | null, offset: number) => {
	let syntheticOverlay: HTMLElement | null = null;

	climbDom(node, (currentNode) => {
		if (
			currentNode instanceof HTMLElement &&
			currentNode.matches(SYNTHETIC_TEXT_OVERLAY_SELECTOR)
		) {
			syntheticOverlay = currentNode;
			return true;
		}
	});

	if (syntheticOverlay || !(node instanceof Element)) {
		return syntheticOverlay;
	}

	for (const boundaryNode of [node.childNodes[offset], node.childNodes[offset - 1]]) {
		if (!(boundaryNode instanceof HTMLElement)) {
			continue;
		}

		if (boundaryNode.matches(SYNTHETIC_TEXT_OVERLAY_SELECTOR)) {
			return boundaryNode;
		}

		const descendant = boundaryNode.querySelector<HTMLElement>(SYNTHETIC_TEXT_OVERLAY_SELECTOR);
		if (descendant) {
			return descendant;
		}
	}

	return null;
};

const getTextPlaceholderInRange = (range: Range | undefined) => {
	if (!range) {
		return null;
	}

	const root =
		range.commonAncestorContainer instanceof Element
			? range.commonAncestorContainer
			: range.commonAncestorContainer.parentElement;
	if (!root) {
		return null;
	}

	const placeholders = [
		...(root.matches(TEXT_PLACEHOLDER_SELECTOR) ? [root] : []),
		...Array.from(root.querySelectorAll(TEXT_PLACEHOLDER_SELECTOR))
	];
	return (
		placeholders.find((placeholder) => {
			try {
				return range.intersectsNode(placeholder);
			} catch {
				return false;
			}
		}) ?? null
	);
};

const getInlineBlockBetweenBoundaryTexts = (
	startText: Text,
	endText: Text | null,
	yStart: number,
	yEnd: number
) => {
	if (!endText || startText.parent !== endText.parent) {
		return null;
	}

	if (yStart !== startText.length || yEnd !== 0) {
		return null;
	}

	const content = startText.parent.content;
	const startIndex = content.indexOf(startText);
	const endIndex = content.indexOf(endText);
	if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
		return null;
	}

	const selectedParts = content.slice(startIndex + 1, endIndex);
	return selectedParts.length === 1 && selectedParts[0] instanceof InlineBlock
		? selectedParts[0]
		: null;
};

type UndoSelectionSnapshot = {
	isCollapsed: boolean;
	isReversed: boolean;
	startTextId: string | null;
	endTextId: string | null;
	startTextPath: number[] | null;
	endTextPath: number[] | null;
	yStart: number;
	yEnd: number;
	/**
	 * U09 — backing-text anchors for both endpoints (authoritative when
	 * present). The START endpoint binds 'right' (the first atom inside
	 * the range) and END binds 'left' (the last atom inside the range) so
	 * boundary inserts stay outside the restored range; collapsed
	 * snapshots carry a 'left' caret anchor in both fields. The numeric
	 * `yStart`/`yEnd` + id/path fields remain as the compatibility
	 * fallback for anchors that can no longer resolve (deleted backing).
	 */
	startAnchor: TextAnchor | null;
	endAnchor: TextAnchor | null;
	selectedBlockIds: string[];
	selectedBlockPaths: number[][];
};

type PointerTextPoint = {
	text: Text;
	offset: number;
	clientX: number;
	clientY: number;
};

type DocumentWithCaretPoint = Document & {
	caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
	caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

const CURSOR_LOCATION_META = 'cursor-location';
const RESTORE_CURSOR_LOCATION_META = 'restore-cursor-location';

/**
 * Android Chrome mutates the DOM anyway after a canceled
 * `deleteContentBackward`/`deleteContentForward` and then reports a
 * `selectionchange` whose caret sits one position right of the
 * model-computed merge point (Lexical's `postDeleteSelectionToRestore`
 * equivalent). The restore window only needs to cover the post-delete
 * echo, which lands in the same task or the next frame.
 */
const ANDROID_POST_DELETE_RESTORE_WINDOW_MS = 250;

/**
 * Window for the post-write caret verification in `setAtTextOffset`.
 * Gecko re-anchors the DOM selection at the same absolute offset when a
 * rendered text node is swapped instead of shifting it back past a
 * deletion — a caret write can therefore land on a node that is
 * replaced a tick later and silently revert to the pre-write offset via
 * the resulting selectionchange echo. The verification only has to
 * cover that post-render echo, which lands within the next frames.
 */
const SELECTION_WRITE_VERIFY_DELAY_MS = 150;

const restoreBackwardDomRange = (
	selection: Selection,
	range: Range,
	endTextNode: Node,
	endNodeOffset: number,
	startTextNode: Node,
	startNodeOffset: number
) => {
	try {
		if (typeof selection.setBaseAndExtent === 'function') {
			selection.setBaseAndExtent(endTextNode, endNodeOffset, startTextNode, startNodeOffset);
			return true;
		}
	} catch {
		selection.removeAllRanges();
	}

	try {
		if (typeof selection.extend === 'function') {
			selection.collapse(endTextNode, endNodeOffset);
			selection.extend(startTextNode, startNodeOffset);
			return true;
		}
	} catch {
		selection.removeAllRanges();
	}

	selection.addRange(range);
	return false;
};

/**
 * A block's text endpoint for block-level selection state. A kind that
 * displays no text (a divider) has none; its own content slot stands in as
 * the model endpoint of the block selection (selection state holds texts
 * until block sets are stored by id).
 */
const edgeText = (block: Block, edge: 'first' | 'last'): Text =>
	(edge === 'first' ? block.firstText : block.lastText) ?? (block.content[0] as Text);

export class EdytorSelection {
	edytor: Edytor;
	focusedBlocks = new SvelteSet<Block>();
	selectedBlocks = new SvelteSet<Block>();
	selectedInlineBlock = new SvelteSet<InlineBlock>();
	inlineBlockDeletionTarget: InlineBlock | null = null;
	nextUndoSelectionSnapshot = $state<Partial<UndoSelectionSnapshot> | null>(null);
	isRestoringHistorySelection = $state(false);
	/**
	 * Gesture serial captured when the current history restore armed —
	 * compared against `edytor.gestureSerial` in `onSelectionChange` and
	 * `isCurrentRestore`: a real user gesture (pointer/key/focus) inside
	 * the restore window means the USER owns the selection now, so the
	 * restore's delayed writes must disarm (P1-3).
	 */
	private historyRestoreGestureSerial = 0;
	/**
	 * Set only for the synchronous window of THIS view's own history
	 * command (`edytor.historyUndo()`/`historyRedo()`). The undo manager is
	 * document-shared, so `stack-item-popped` reaches EVERY view's listener
	 * when any one view (or a headless `document.history.undo()`) runs a
	 * history command — this flag marks the issuer. Only the issuing view
	 * consumes its per-view snapshot and restores its caret; every other
	 * view treats the pop as an ordinary document change — identical to a
	 * REMOTE peer's undo, which never restores local carets either (the
	 * caret rides normal reconciliation instead of being regressed to a
	 * snapshot recorded when the undone edit committed).
	 */
	expectHistoryRestore = false;
	ignoreNextSelectionChange = $state(false);
	ignoreNextSelectedBlockSelectionChange = $state(false);
	/**
	 * The collapsed caret target written by a cross-text jump — the
	 * write a backward merge/delete ends with. An Android-shifted
	 * `selectionchange` reporting `offset + 1` on that same text gets
	 * snapped back to this target.
	 */
	/**
	 * Deferred caret re-assert ownership. The mechanisms below all answer
	 * "who owns the caret right now" but over DIFFERENT windows and with
	 * different staleness evidence — merging them onto one epoch would
	 * couple aborts that are currently independent (a `selectBlocks`
	 * superseding a block-range write must not cancel an in-flight
	 * history restore, and vice versa):
	 * - `historySelectionRestoreVersion` + `historyRestoreGestureSerial`
	 *   own the undo/redo restore loop — aborted by a foreign write, a
	 *   doc commit, or a real user gesture inside the window;
	 * - `pendingBlockRangeRequest` owns an in-flight `setAtBlockRange` —
	 *   superseded by the next block-range request or `selectBlocks`;
	 * - `postDeleteCaretTarget` owns the Android post-delete echo window
	 *   (timestamp-bounded, ANDROID_POST_DELETE_RESTORE_WINDOW_MS);
	 * - `scheduleCaretWriteVerification` owns the Gecko re-anchor echo
	 *   (bounded re-arm, gesture-serial checked).
	 * What they share — "is live state still at position X" — is the
	 * single `stateMatchesSelectionTarget` predicate; multi-pass
	 * re-asserts schedule through `scheduleReassert`.
	 */
	private postDeleteCaretTarget: { text: Text; offset: number; at: number } | null = null;
	private pointerDragStart: PointerTextPoint | null = null;
	private selectionDocument: Document | null = null;
	private shouldKeepModelSelectionForNextTextInsertion = false;
	private modelSelectionPreservationBlock: Block | null = null;
	private pendingBlockRangeRequest: symbol | null = null;
	private historySelectionRestoreVersion = 0;

	/**
	 * The selection (R9, L4): a value — none, a text range of two anchors,
	 * one inline atom, or a set of block ids. Only `select()` replaces it.
	 */
	value = $state.raw<SelectionValue>(noSelection);
	/** Advanced by every `select()`. */
	epoch = 0;
	/** Why the last `select()` ran. */
	cause: SelectCause = 'model';
	/**
	 * Inline text suggestions (L12), keyed by block id: set by the host or an
	 * extension, cleared by accept, dismiss, and by `select()` when the
	 * selection leaves their block.
	 */
	suggestions = new SvelteMap<string, SuggestionParts>();
	/** DOM fields (Surface) observed with the value they describe. */
	#surface: {
		value: SelectionValue;
		startNode: Node | null;
		endNode: Node | null;
		edge?: EdgeSide;
	} | null = null;
	/** Blocks holding the last selection's endpoints: a suggestion there is cleared when they are left. */
	#edges: string[] = [];
	#compat = new WeakMap<
		SelectionProjection,
		{ surface: unknown; mirror: number; state: SelectionState }
	>();
	/** The state as the last `select()` wrote it. */
	#written: SelectionState = EMPTY_STATE;

	constructor(
		edytor: Edytor,
		private edytorOnSelectionChange?: (selection: EdytorSelection) => void
	) {
		this.edytor = edytor;
	}

	/** The projection of the current value at the current document version. */
	get projection(): SelectionProjection {
		void this.edytor.valueRevision;
		return project(this.value, this.edytor.facade);
	}

	/**
	 * Compatibility view of the projection in today's wrapper vocabulary
	 * (`startText`/`yStart`/… offsets inside text segments). Every field is a
	 * projection of (value, document version); the DOM fields come from the
	 * Surface for the value they were observed with.
	 */
	get state(): SelectionState {
		const projection = this.projection;
		const surface = this.#surface?.value === this.value ? this.#surface : null;
		const mirror = this.edytor.mirrorRevision;
		const hit = this.#compat.get(projection);
		if (hit && hit.surface === surface && hit.mirror === mirror) return hit.state;
		const state = this.#compatState(this.value, projection, surface);
		this.#compat.set(projection, { surface, mirror, state });
		return state;
	}

	#textOf = (block: Block, segment: SelectionSegment | undefined): Text | null => {
		if (segment?.kind !== 'text') return null;
		const texts = block.content.filter((part): part is Text => part instanceof Text);
		return texts.find((text) => text._segOrd === segment.segOrd) ?? texts[segment.segOrd] ?? null;
	};

	#compatState = (
		value: SelectionValue,
		projection: SelectionProjection,
		surface: { startNode: Node | null; endNode: Node | null; edge?: EdgeSide } | null
	): SelectionState => {
		const { start, end } = projection;
		const blockOf = (id: string) => this.edytor.idToBlock.get(id) ?? null;
		const startBlock = start && blockOf(start.block);
		const endBlock = end && blockOf(end.block);
		if (!start || !end || !startBlock || !endBlock) return EMPTY_STATE;
		let parts = projection.segments;
		if (value.kind === 'atom') {
			const all = segmentsOf(this.edytor.facade, start.block);
			const index = all.findIndex((part) => part.kind === 'inline' && part.id === value.atomId);
			parts = all.slice(index - 1, index + 2);
		}
		const texts = parts.filter((part) => part.kind === 'text');
		const startSegment = texts[0];
		const endSegment = texts[texts.length - 1];
		const startText = this.#textOf(startBlock, startSegment);
		const endText = this.#textOf(endBlock, endSegment);
		if (!startText || !endText || !startSegment || !endSegment) return EMPTY_STATE;
		const contentParts = parts.flatMap((part): (Text | InlineBlock)[] => {
			const block = blockOf(part.block);
			if (!block) return [];
			if (part.kind === 'text') return [this.#textOf(block, part) ?? []].flat();
			const atom = block.content.find((c) => c instanceof InlineBlock && c.id === part.id);
			return atom instanceof InlineBlock ? [atom] : [];
		});
		const blocks =
			value.kind === 'blocks'
				? value.ids
						.filter((id) => this.edytor.facade.isVisibleBlock(id))
						.sort((a, b) => this.edytor.facade.compare(a, b))
						.flatMap((id) => blockOf(id) ?? [])
				: projection.blocks.flatMap((id) => blockOf(id) ?? []);
		const [anchorStart, anchorEnd] =
			value.kind === 'text' ? anchorsInOrder(value, projection) : [null, null];
		const voidRoot = projection.voidRoot ? blockOf(projection.voidRoot) : null;
		const edytor = this.edytor;
		return Object.defineProperties(
			{
				yStart: start.offset - startSegment.start,
				yEnd: end.offset - endSegment.start,
				isCollapsed: projection.isCollapsed,
				isReversed: projection.isReversed,
				texts: contentParts.filter((part): part is Text => part instanceof Text),
				contentParts,
				blocks,
				isAtStartOfBlock: projection.isAtStartOfBlock,
				isAtEndOfBlock: projection.isAtEndOfBlock,
				isAtStartOfText: projection.isAtStartOfText,
				isAtEndOfText: projection.isAtEndOfText,
				startNode: surface?.startNode ?? null,
				endNode: surface?.endNode ?? null,
				edge: surface?.edge,
				startText,
				endText,
				startBlock,
				endBlock,
				isTextSpanning: projection.isTextSpanning,
				isBlockSpanning: projection.isBlockSpanning,
				isVoid: voidRoot !== null,
				voidRoot,
				isIsland: projection.islandRoot !== null,
				islandRoot: projection.islandRoot ? blockOf(projection.islandRoot) : null,
				relativePosition: anchorStart,
				endPosition: projection.isCollapsed ? null : anchorEnd
			},
			{
				content: { enumerable: true, get: () => projection.content },
				length: { enumerable: true, get: () => projection.content.length },
				currentMarks: { enumerable: true, get: () => projection.marks },
				isVoidEditableElement: {
					enumerable: true,
					get: () =>
						voidRoot !== null &&
						['INPUT', 'TEXTAREA'].includes(
							getActiveElement(edytor.node)?.tagName.toUpperCase() ?? ''
						)
				}
			}
		) as SelectionState;
	};

	/**
	 * The one commit point (R9): replaces the value, advances the epoch and
	 * applies every side effect once — the selected, atom and focused sets
	 * (hooks and attributes), clearing suggestions whose block the selection
	 * left, and, when the value changed, presence and `onSelectionChange`.
	 * `surface` carries the DOM nodes the value was observed from.
	 */
	select = (
		next: SelectionValue,
		cause: SelectCause = 'model',
		surface?: { startNode: Node | null; endNode: Node | null; edge?: EdgeSide }
	) => {
		const changed = !sameValue(this.value, next);
		if (changed) this.value = next;
		const value = this.value;
		this.epoch++;
		this.cause = cause;
		if (surface) this.#surface = { value, ...surface };
		const projection = project(value, this.edytor.facade);
		const blockOf = (id: string) => this.edytor.idToBlock.get(id);
		const selected =
			value.kind === 'blocks'
				? value.ids
						.filter((id) => this.edytor.facade.isVisibleBlock(id))
						.flatMap((id) => blockOf(id) ?? [])
				: [];
		const atom =
			value.kind === 'atom'
				? blockOf(value.blockId)?.content.find(
						(part): part is InlineBlock => part instanceof InlineBlock && part.id === value.atomId
					)
				: undefined;
		const focused =
			value.kind === 'text'
				? projection.blocks.flatMap((id) => blockOf(id) ?? [])
				: value.kind === 'atom'
					? [blockOf(value.blockId) ?? []].flat()
					: [];
		this.#sync(this.selectedBlocks, selected, 'selected');
		this.#sync(this.focusedBlocks, focused, 'focused');
		if (atom !== this.inlineBlockDeletionTarget || (!atom && this.selectedInlineBlock.size)) {
			this.selectedInlineBlock.clear();
			if (atom) this.selectedInlineBlock.add(atom);
			this.inlineBlockDeletionTarget = atom ?? null;
		}
		const edges = [projection.start?.block, projection.end?.block].filter(
			(id): id is string => id !== undefined
		);
		for (const id of this.#edges) if (!edges.includes(id)) this.suggestions.delete(id);
		this.#edges = edges;
		const state = this.state;
		this.#written = state;
		if (state.startText) {
			this.#lastText = state.startText;
			this.#lastBlock = state.startBlock?.id ?? null;
		}
		if (!changed) return;
		publishAwarenessSelection(this);
		this.edytorOnSelectionChange?.(this);
		this.edytor.plugins.forEach((plugin) => {
			plugin.onSelectionChange?.(this);
		});
	};

	/** Diff one block set against its new members: hooks and attributes only for changes. */
	#sync = (set: SvelteSet<Block>, blocks: Block[], kind: 'selected' | 'focused') => {
		const next = new Set(blocks);
		const attribute = `data-edytor-${kind}`;
		for (const block of set) {
			if (next.has(block)) continue;
			set.delete(block);
			// `onDeselect` pairs with `onSelect`; `onBlur` keeps firing on both
			// (it has historically doubled as the selection-loss hook).
			if (kind === 'selected') block.definition.onDeselect?.({ block });
			block.definition.onBlur?.({ block });
			block.node?.removeAttribute(attribute);
		}
		for (const block of next) {
			if (set.has(block)) continue;
			set.add(block);
			if (kind === 'selected') block.definition.onSelect?.({ block });
			else block.definition.onFocus?.({ block });
			block.node?.setAttribute(attribute, 'true');
		}
	};

	/**
	 * A text value from wrapper endpoints (offsets inside text segments):
	 * the start binds right (boundary inserts stay outside), the end and a
	 * caret bind left; `none` when the start text is not bound to the document.
	 */
	textValue = (
		startText: Text,
		yStart: number,
		endText: Text = startText,
		yEnd: number = yStart,
		isReversed = false,
		startAffinity?: 'left' | 'right'
	): SelectionValue => {
		const collapsed = startText === endText && yStart === yEnd;
		const start = this.createTextAnchor(
			startText,
			yStart,
			startAffinity ?? (collapsed ? 'left' : 'right')
		);
		if (!start) return noSelection;
		if (collapsed) return textSelection(start);
		const end = this.createTextAnchor(endText, yEnd, 'left') ?? start;
		return isReversed ? textSelection(end, start) : textSelection(start, end);
	};

	/**
	 * A dead-endpoint recovery pass that found no mounted editable
	 * destination — e.g. a remote whole-document delete whose
	 * normalization-created replacement paragraph exists in the model but
	 * has not mounted a DOM node yet. `Text.attach` replays the recovery
	 * when a real text element mounts; phantom content slots (container
	 * blocks whose snippet never renders `content`) never attach, so the
	 * retry can never land on one. The flag carries no position of its
	 * own — the retried `restoreDeadSelectionEndpoints` re-derives the
	 * destination from the live state, so a newer gesture that already
	 * fixed the endpoints makes the replay a no-op.
	 */
	private deadEndpointRecoveryPending = false;
	/**
	 * "Is `state` still at this caret position?" — the one comparison
	 * every staleness/echo/foreign-write check shares (previously four
	 * ad-hoc field lists that each re-derived the same rule). Direction
	 * only distinguishes two states on a non-collapsed range — a
	 * collapsed caret's `isReversed` is a don't-care derived false, so
	 * comparing it would flag caret equivalents as foreign (P2-6).
	 */
	private stateMatchesSelectionTarget = (
		state: SelectionState,
		target: {
			startText: Text | null;
			endText: Text | null;
			yStart: number;
			yEnd: number;
			isCollapsed: boolean;
			isReversed: boolean;
		}
	) =>
		state.startText === target.startText &&
		state.endText === target.endText &&
		state.yStart === target.yStart &&
		state.yEnd === target.yEnd &&
		state.isCollapsed === target.isCollapsed &&
		(target.isCollapsed || state.isReversed === target.isReversed);

	/**
	 * The pre-write caret snapshot `recordPostDeleteCaretTarget` compares
	 * against: the caret as the last `select()` wrote it (a projection
	 * already follows the edit that moved it).
	 */
	private caretSignature = () => {
		const { startText, yStart, isCollapsed } = this.#written;
		return { startText, yStart, isCollapsed };
	};

	/**
	 * The deferred re-assert channel: caret writes and restores re-run
	 * their assertion across the post-commit render window because a
	 * synchronous write can be reverted by a later selectionchange echo.
	 * Mechanisms differ in their guard evidence (see the ownership-token
	 * note on `postDeleteCaretTarget` et al.) but share scheduling.
	 */
	private scheduleReassert = (reassert: () => void, delays: number[]) => {
		for (const delay of delays) {
			setTimeout(reassert, delay);
		}
	};

	private getTextByPath = (path: number[] | null) => {
		if (!path || path.length < 2) {
			return null;
		}

		let block: Block | undefined = this.edytor.root;
		for (const index of path.slice(0, -1)) {
			block = block?.children[index];
		}

		const part = block?.content[path.at(-1)!];
		return part instanceof Text ? part : null;
	};
	private getBlockByPath = (path: number[] | null) => {
		if (!path?.length) {
			return null;
		}

		let block: Block | undefined = this.edytor.root;
		for (const index of path) {
			block = block?.children[index];
		}
		return block ?? null;
	};
	private isCurrentText = (text: Text | null | undefined) =>
		Boolean(text && this.getTextByPath(getTextPath(text)) === text);
	private getRestorableText = (id: string | null, path: number[] | null) => {
		// `getTextById` throws on malformed ids — a stale/corrupt snapshot
		// id must degrade to the path fallback, never crash a restore.
		let textById: Text | null;
		try {
			textById = (id ? this.edytor.getTextById(id) : null) ?? null;
		} catch {
			textById = null;
		}
		if (this.isCurrentText(textById)) {
			return textById ?? null;
		}

		return this.getTextByPath(path);
	};

	/**
	 * Resolve one stored undo-snapshot endpoint → `{text, offset}`.
	 * Anchors are authoritative (they follow moved/merged atoms and land
	 * on the documented deleted-backing fallback); the id/path + numeric
	 * offset pair is the compatibility fallback when the anchor no longer
	 * resolves (deleted target) or is absent (pre-U09 snapshots).
	 */
	private resolveSnapshotEndpoint = (
		anchor: TextAnchor | null | undefined,
		textId: string | null,
		textPath: number[] | null,
		fallbackOffset: number
	): { text: Text; offset: number } | null => {
		if (anchor) {
			const resolved = this.resolveTextAnchor(anchor);
			if (resolved) {
				return resolved;
			}
		}
		const text = this.getRestorableText(textId, textPath);
		if (!text) {
			return null;
		}
		return { text, offset: Math.min(Math.max(fallbackOffset, 0), text.length) };
	};
	private createUndoSelectionSnapshot = (
		override?: Partial<UndoSelectionSnapshot> | null
	): UndoSelectionSnapshot => ({
		isCollapsed: this.#written.isCollapsed,
		isReversed: this.#written.isReversed,
		startTextId: this.#written.startText?.id ?? null,
		endTextId: this.#written.endText?.id ?? null,
		startTextPath: this.#written.startText && getTextPath(this.#written.startText),
		endTextPath: this.#written.endText && getTextPath(this.#written.endText),
		yStart: this.#written.yStart,
		yEnd: this.#written.yEnd,
		startAnchor: this.#written.startText
			? this.createTextAnchor(
					this.#written.startText,
					this.#written.yStart,
					this.#written.isCollapsed ? 'left' : 'right'
				)
			: null,
		endAnchor: this.#written.endText
			? this.createTextAnchor(this.#written.endText, this.#written.yEnd, 'left')
			: null,
		selectedBlockIds: Array.from(this.selectedBlocks).map((block) => block.id),
		selectedBlockPaths: Array.from(this.selectedBlocks).map((block) => [...block.path]),
		...override
	});
	queueNextUndoSelectionSnapshot = (override?: Partial<UndoSelectionSnapshot> | null) => {
		this.nextUndoSelectionSnapshot = this.createUndoSelectionSnapshot(override);
	};
	destroy = () => {
		// Document-shared undo manager — drop our listeners so the dead
		// view no longer writes/pops per-view snapshots on it.
		this._unbindHistoryListeners();
		if (this.selectionDocument) {
			this.selectionDocument.removeEventListener('selectionchange', this.onSelectionChange);
			this.selectionDocument = null;
		}
		// U09 lifecycle — drop our published caret so remote peers remove
		// it when this editor detaches (awareness state itself is owned by
		// the provider, not the component).
		clearAwarenessSelection(this.edytor.awareness);
	};
	/**
	 * `selectedInlineBlock` and `inlineBlockDeletionTarget` are one
	 * selection — every mutation must go through these two helpers so the
	 * armed Backspace/delete target can never outlive the cleared set
	 * (a stale target feeds `deleteSelectedInlineBlock` and makes
	 * `restoreSelectionAfterRepair` bail forever).
	 */
	clearInlineBlockSelection = () => {
		const value = this.value;
		if (value.kind !== 'atom') return;
		// Leaving the atom: a caret at its start (the end of the text before it).
		const atom = this.edytor.idToBlock
			.get(value.blockId)
			?.content.find((part) => part instanceof InlineBlock && part.id === value.atomId);
		const before = atom?.parent.content[atom.parent.content.indexOf(atom) - 1];
		this.select(before instanceof Text ? this.textValue(before, before.length) : noSelection);
	};
	selectInlineBlock = (inlineBlock: InlineBlock) => {
		this.select(atomSelection(inlineBlock.parent.id, inlineBlock.id));
	};
	clearModelSelectionPreservation = () => {
		this.shouldKeepModelSelectionForNextTextInsertion = false;
		this.modelSelectionPreservationBlock = null;
	};
	private isStateBlockContentRange = (block: Block) =>
		Boolean(
			!this.state.isCollapsed &&
			this.state.startBlock === block &&
			this.state.endBlock === block &&
			this.state.startText === block.firstText &&
			this.state.endText === block.lastText &&
			this.state.yStart === 0 &&
			this.state.yEnd === block.lastText.length
		);
	consumeModelSelectionPreservationForTextInsertion = () => {
		const preservedBlock = this.modelSelectionPreservationBlock;
		const shouldKeepPreservedBlock =
			this.shouldKeepModelSelectionForNextTextInsertion &&
			preservedBlock instanceof Block &&
			this.getBlockByPath(preservedBlock.path) === preservedBlock;
		const shouldKeepSelection =
			shouldKeepPreservedBlock ||
			(this.shouldKeepModelSelectionForNextTextInsertion &&
				this.state.startBlock instanceof Block &&
				this.isStateBlockContentRange(this.state.startBlock));

		if (shouldKeepPreservedBlock) {
			this.setStateFromBlockContentRange(preservedBlock);
		}

		this.shouldKeepModelSelectionForNextTextInsertion = false;
		this.modelSelectionPreservationBlock = null;
		return shouldKeepSelection;
	};
	getTextOfNode = getTextOfNode.bind(this);
	getTextsInSelection = getTextsInSelection.bind(this);
	getInlineBlockOfNode = getInlineBlockOfNode.bind(this);
	getInlineBlockInSelectedRange = getInlineBlockInSelectedRange.bind(this);

	private getBlockOfNode = (node: Node | null) => {
		const element = getElementFromNode(node);
		const blockElement = element?.closest('[data-edytor-block]');
		if (!(blockElement instanceof HTMLElement) || !this.edytor.node?.contains(blockElement)) {
			return null;
		}

		const id = blockElement.dataset.edytorId;
		return id ? (this.edytor.idToBlock.get(id) ?? null) : null;
	};

	private isInsideEditableText = (node: Node | null) => {
		const element = getElementFromNode(node);
		return Boolean(element?.closest('[data-edytor-text]'));
	};

	private getNonNativeEditableIslandBlock = (node: Node | null) => {
		const element = getElementFromNode(node);
		const island = element?.closest('[contenteditable="false"]');
		if (!(island instanceof HTMLElement) || !this.edytor.node?.contains(island)) {
			return null;
		}
		if (island.closest('input, textarea, select, button, a[href]')) {
			return null;
		}

		return this.getBlockOfNode(island);
	};

	private getNonNativeEditableBlockChromeBlock = (node: Node | null) => {
		const element = getElementFromNode(node);
		const nonEditableElement = element?.closest('[contenteditable="false"]');
		if (
			!(nonEditableElement instanceof HTMLElement) ||
			!this.edytor.node?.contains(nonEditableElement)
		) {
			return null;
		}
		if (nonEditableElement.closest('input, textarea, select, button, a[href]')) {
			return null;
		}
		const block = this.getBlockOfNode(nonEditableElement);
		if (nonEditableElement.closest('[data-edytor-text], [data-edytor-inline-block]') || !block) {
			return null;
		}

		return block;
	};

	handleNonNativeEditableBlockChromePointerDown = (event: PointerEvent) => {
		const targetNode = event.target instanceof Node ? event.target : null;
		const targetBlock = this.getNonNativeEditableBlockChromeBlock(targetNode);
		const targetText = targetBlock?.firstText;
		if (!targetText) {
			return;
		}

		this.setCollapsedStateAtTextOffset(targetText, 0);
		void this.setAtTextOffset(targetText, 0);
		this.ignoreNextSelectionChange = true;
	};

	private normalizeTextRangePoints = (
		startText: Text,
		startOffset: number,
		endText: Text,
		endOffset: number,
		isReversed: boolean
	) => {
		const clampedStart = Math.min(Math.max(startOffset, 0), startText.length);
		const clampedEnd = Math.min(Math.max(endOffset, 0), endText.length);
		const order =
			startText === endText
				? clampedStart - clampedEnd
				: startText.parent === endText.parent
					? startText.index - endText.index
					: this.edytor.compareBlocks(startText.parent, endText.parent);

		if (order <= 0) {
			return {
				startText,
				startOffset: clampedStart,
				endText,
				endOffset: clampedEnd,
				isReversed: order === 0 ? false : isReversed
			};
		}

		return {
			startText: endText,
			startOffset: clampedEnd,
			endText: startText,
			endOffset: clampedStart,
			// Text atoms never reorder inside one text. Undo can nevertheless
			// resolve the two deleted-boundary anchors on opposite sides of
			// their restored atoms. Sort those offsets without changing the
			// selection direction stored independently in the snapshot.
			isReversed: startText === endText ? isReversed : !isReversed
		};
	};

	private restoreRangeSelectionSnapshot = async (
		cursorLocation: UndoSelectionSnapshot,
		shouldContinue: () => boolean = () => true
	) => {
		// State this restore last wrote — a foreign selection write inside
		// the window (a programmatic move carrying no gesture evidence)
		// replaces `state`; the delayed re-writes must not overwrite it.
		let ownedState: SelectionState | null = null;
		const abortOnForeignWrite = () => {
			this.historySelectionRestoreVersion++;
			this.isRestoringHistorySelection = false;
		};
		for (let attempt = 0; attempt < 10; attempt++) {
			if (!shouldContinue()) {
				return;
			}
			await tick();
			if (!shouldContinue()) {
				return;
			}

			// Anchors are re-resolved every attempt — a bound item that was
			// not yet integrated converges as remote updates land.
			const startPoint = this.resolveSnapshotEndpoint(
				cursorLocation.startAnchor,
				cursorLocation.startTextId,
				cursorLocation.startTextPath,
				cursorLocation.yStart
			);
			const endPoint = this.resolveSnapshotEndpoint(
				cursorLocation.endAnchor,
				cursorLocation.endTextId,
				cursorLocation.endTextPath,
				cursorLocation.yEnd
			);

			if (!startPoint || !endPoint) {
				continue;
			}
			const normalizedRange = this.normalizeTextRangePoints(
				startPoint.text,
				startPoint.offset,
				endPoint.text,
				endPoint.offset,
				cursorLocation.isReversed
			);
			const { startText, startOffset, endText, endOffset, isReversed } = normalizedRange;
			const isCollapsed = startText === endText && startOffset === endOffset;

			const restoreModelRange = () => {
				if (!shouldContinue()) {
					return;
				}
				if (ownedState !== null && this.#written !== ownedState) {
					// `state` is replaced on EVERY derive — including derives
					// that re-write this same range (a selectionchange echo, a
					// reconcile adopting the restored point). Object identity
					// alone can't tell "foreign caret move" from "equivalent
					// re-derive" — compare fields: only a DIFFERENT target is
					// a foreign write whose owner keeps the caret.
					const sameTarget = this.stateMatchesSelectionTarget(this.#written, {
						startText,
						endText,
						yStart: startOffset,
						yEnd: endOffset,
						isCollapsed,
						isReversed
					});
					if (!sameTarget) {
						abortOnForeignWrite();
						return;
					}
					ownedState = this.#written;
				}

				this.setRangeStateAtTextOffsets(startText, startOffset, endText, endOffset, {
					isReversed
				});
				ownedState = this.#written;
				this.ignoreNextSelectionChange = true;
			};

			restoreModelRange();
			await this.setAtRange(startText, startOffset, endText, endOffset, {
				isReversed
			});
			// The DOM-write's own derive also counts as this restore's
			// landing — adopt it before the delayed re-writes check ownership.
			ownedState = this.#written;
			restoreModelRange();
			this.scheduleReassert(restoreModelRange, [0, 30]);

			if (!shouldContinue()) {
				return;
			}
			await tick();
			restoreModelRange();

			if (
				this.stateMatchesSelectionTarget(this.#written, {
					startText,
					endText,
					yStart: startOffset,
					yEnd: endOffset,
					isCollapsed,
					isReversed
				})
			) {
				return;
			}
		}
	};

	init = () => {
		// Re-attach safe: the undo listeners are document-lifetime (the
		// manager is shared across every view of the document) — rebind
		// without duplicating after a `{#key}` remount, and release them on
		// `destroy()` so dead views stop writing/popping snapshots on the
		// shared manager.
		this._unbindHistoryListeners();
		const offs: (() => void)[] = [];
		const undoManager = this.edytor.undoManager;
		const on = (
			name: 'stack-item-added' | 'stack-item-updated' | 'stack-item-popped',
			handler: (event: any) => void
		) => {
			undoManager.on(name, handler);
			// Off targets the SAME manager instance that received the
			// handler — never re-dereferences `edytor.undoManager` later.
			offs.push(() => undoManager.off(name, handler));
		};
		// Selection snapshots live in stack-item `meta` keyed PER VIEW —
		// `Map<view transaction origin, snapshot>` under each meta key.
		// Every view of a shared document keeps INDEPENDENT selection state,
		// so each one writes only its own entry (previously all views raced
		// one shared snapshot — first writer won, every view restored it).
		//
		// POP POLICY (deliberate): the shared manager's `stack-item-popped`
		// reaches every live view, but only the view that ISSUED the history
		// command restores — `expectHistoryRestore` marks that issuer. A
		// sibling's caret is NOT yanked to the snapshot it recorded when the
		// undone edit committed: for the sibling, a local undo is
		// indistinguishable from a REMOTE undo, which never restores local
		// carets either. Its snapshot still rides in the popped item — the
		// redo path restores it correctly when the sibling itself invokes
		// the command.
		const viewKey = this.edytor.transaction;
		const snapshotMapOf = (stackItem: any, key: string): Map<unknown, UndoSelectionSnapshot> => {
			let map = stackItem.meta.get(key) as Map<unknown, UndoSelectionSnapshot> | undefined;
			if (!(map instanceof Map)) {
				map = new Map();
				stackItem.meta.set(key, map);
			}
			return map;
		};
		const persistUndoSelectionSnapshot = (event: any) => {
			const override = this.nextUndoSelectionSnapshot;
			const snapshots = snapshotMapOf(event.stackItem, CURSOR_LOCATION_META);
			const restores = snapshotMapOf(event.stackItem, RESTORE_CURSOR_LOCATION_META);
			const currentSnapshot = snapshots.get(viewKey);
			if (override && currentSnapshot) {
				restores.set(viewKey, currentSnapshot);
			}
			if (override || !snapshots.has(viewKey)) {
				snapshots.set(viewKey, this.createUndoSelectionSnapshot(override));
			}
			this.nextUndoSelectionSnapshot = null;
		};
		on('stack-item-added', persistUndoSelectionSnapshot);
		on('stack-item-updated', persistUndoSelectionSnapshot);
		on('stack-item-popped', (event: any) => {
			// Issuing-view-only restore: this view did not run the history
			// command — leave its caret alone (and do not touch the popped
			// item: a sibling's snapshots ride through to the redo side).
			if (!this.expectHistoryRestore) {
				return;
			}
			this.expectHistoryRestore = false;

			const snapshots = event.stackItem.meta.get(CURSOR_LOCATION_META) as
				| Map<unknown, UndoSelectionSnapshot>
				| undefined;
			const restores = event.stackItem.meta.get(RESTORE_CURSOR_LOCATION_META) as
				| Map<unknown, UndoSelectionSnapshot>
				| undefined;
			const cursorLocation = (restores?.get(viewKey) ?? snapshots?.get(viewKey)) as
				| UndoSelectionSnapshot
				| undefined;
			restores?.delete(viewKey);

			if (!cursorLocation) {
				return;
			}

			const restoreVersion = ++this.historySelectionRestoreVersion;
			// `stack-item-popped` fires after the undo/redo commit, so the
			// document version here already includes the history change
			// itself. Any LATER commit — a keystroke landing inside this
			// restore's async window, a remote update — makes the stored
			// offsets stale; the delayed restores below must not regress
			// the caret over newer input. The gesture serial gets the same
			// treatment: a real user gesture (pointer/key/focus) means the
			// user owns the caret even without a doc commit (P1-3).
			const docVersion = this.edytor._docCommitVersion;
			const gestureSerial = (this.historyRestoreGestureSerial = this.edytor.gestureSerial);
			const isCurrentRestore = () =>
				this.historySelectionRestoreVersion === restoreVersion &&
				this.edytor._docCommitVersion === docVersion &&
				this.edytor.gestureSerial === gestureSerial;
			this.isRestoringHistorySelection = true;
			const clearHistoryRestoration = () => {
				// The latch must release even when this restore was aborted —
				// a commit landing inside the async window makes
				// `isCurrentRestore()` permanently false, which would leave
				// `isRestoringHistorySelection` stuck true and silence every
				// future selection derive. Only a NEWER restore (version
				// bump) should keep the flag alive.
				if (this.historySelectionRestoreVersion === restoreVersion) {
					this.isRestoringHistorySelection = false;
				}
			};

			if (cursorLocation.selectedBlockIds.length) {
				const restoreDeletedSelectionFallback = () => {
					const firstPath = cursorLocation.selectedBlockPaths[0];
					const previousPath =
						firstPath && firstPath.at(-1)! > 0
							? [...firstPath.slice(0, -1), firstPath.at(-1)! - 1]
							: null;
					const fallbackBlock = this.getBlockByPath(previousPath) ?? this.getBlockByPath(firstPath);
					const fallbackText = fallbackBlock?.firstEditableText;
					if (!fallbackText) {
						return false;
					}

					this.setCollapsedStateAtTextOffset(fallbackText, fallbackText.length);
					void this.setAtTextOffset(fallbackText, fallbackText.length);
					return true;
				};

				if ((event as { type?: string }).type === 'redo' && restoreDeletedSelectionFallback()) {
					clearHistoryRestoration();
					return;
				}

				void (async () => {
					try {
						for (let attempt = 0; attempt < 10; attempt++) {
							if (!isCurrentRestore()) {
								return;
							}
							await tick();
							if (!isCurrentRestore()) {
								return;
							}

							const blocksById = cursorLocation.selectedBlockIds
								.map((id) => this.edytor.idToBlock.get(id))
								.filter((block): block is Block => block instanceof Block);

							if (blocksById.length) {
								if (typeof window !== 'undefined') {
									clearDomSelection(this.edytor.node);
								}
								this.selectBlocks(...blocksById);
								return;
							}

							if (attempt < 9) {
								continue;
							}

							if (restoreDeletedSelectionFallback()) {
								return;
							}
						}
					} finally {
						clearHistoryRestoration();
					}
				})();
				return;
			}

			if (!cursorLocation.isCollapsed && cursorLocation.endTextPath) {
				const startPoint = this.resolveSnapshotEndpoint(
					cursorLocation.startAnchor,
					cursorLocation.startTextId,
					cursorLocation.startTextPath,
					cursorLocation.yStart
				);
				const endPoint = this.resolveSnapshotEndpoint(
					cursorLocation.endAnchor,
					cursorLocation.endTextId,
					cursorLocation.endTextPath,
					cursorLocation.yEnd
				);
				if (startPoint && endPoint) {
					this.setRangeStateAtTextOffsets(
						startPoint.text,
						startPoint.offset,
						endPoint.text,
						endPoint.offset,
						{
							isReversed: cursorLocation.isReversed
						}
					);
				}
				void this.restoreRangeSelectionSnapshot(cursorLocation, isCurrentRestore).finally(
					clearHistoryRestoration
				);
				return;
			}

			void (async () => {
				await tick();
				if (!isCurrentRestore()) {
					return;
				}

				const startPoint = this.resolveSnapshotEndpoint(
					cursorLocation.startAnchor ?? cursorLocation.endAnchor,
					cursorLocation.startTextId,
					cursorLocation.startTextPath,
					cursorLocation.yEnd
				);

				if (!startPoint || !isCurrentRestore()) {
					return;
				}

				this.ignoreNextSelectionChange = true;
				await this.setAtTextOffset(startPoint.text, startPoint.offset);
			})().finally(clearHistoryRestoration);
		});

		this._historyOffs = offs;

		if (typeof document !== 'undefined') {
			this.selectionDocument = this.edytor.node?.ownerDocument ?? document;
			this.selectionDocument.addEventListener('selectionchange', this.onSelectionChange);
		}
	};

	/**
	 * Undo-manager listeners are bound in {@link init} — the manager is
	 * document-owned and outlives this view, so they must be released on
	 * destroy (and before a re-init) or dead views keep writing and
	 * restoring snapshots on the shared stack items.
	 */
	private _historyOffs: (() => void)[] | null = null;
	private _unbindHistoryListeners = () => {
		const offs = this._historyOffs;
		this._historyOffs = null;
		offs?.forEach((off) => off());
	};

	handleTripleClick = async (e: MouseEvent) => {
		if (e.detail < 3) return;
		const targetNode = e.target instanceof Node ? e.target : null;
		const clickedBlock = this.getBlockOfNode(targetNode);
		if (clickedBlock?.definition.void && !this.isInsideEditableText(targetNode)) {
			e.preventDefault();
			window.requestAnimationFrame(() => {
				window.setTimeout(() => {
					clearDomSelection(this.edytor.node);
					this.selectBlocks(clickedBlock);
					this.ignoreNextSelectionChange = true;
				});
			});
			return;
		}

		const targetBlock =
			targetNode instanceof Node
				? (this.getTextOfNode(targetNode)?.parent ?? this.getBlockOfNode(targetNode))
				: this.state.startText?.parent;
		if (targetBlock) {
			this.setStateFromBlockContentRange(targetBlock);
			this.shouldKeepModelSelectionForNextTextInsertion = true;
			this.modelSelectionPreservationBlock = targetBlock;
			this.ignoreNextSelectionChange = true;
		}
		window.requestAnimationFrame(() => {
			window.setTimeout(() => {
				if (!targetBlock) {
					return;
				}
				if (!this.isStateBlockContentRange(targetBlock)) {
					return;
				}

				void (async () => {
					await this.setAtBlockRange(targetBlock, undefined, undefined, {
						syncModelState: false
					});
					this.ignoreNextSelectionChange = true;
				})();
			});
		});
	};

	private getTextPointFromClientPoint = (clientX: number, clientY: number) => {
		const ownerDocument = (this.edytor.node?.ownerDocument ?? document) as DocumentWithCaretPoint;
		const caretPosition = ownerDocument.caretPositionFromPoint?.(clientX, clientY);
		const caretRange = caretPosition ? null : ownerDocument.caretRangeFromPoint?.(clientX, clientY);
		const node = caretPosition?.offsetNode ?? caretRange?.startContainer ?? null;
		const domOffset = caretPosition?.offset ?? caretRange?.startOffset ?? null;
		const text = this.getTextOfNode(node, domOffset ?? undefined);

		if (!text || typeof domOffset !== 'number') {
			return null;
		}

		return {
			text,
			offset: Math.min(Math.max(getYIndex(text, node, domOffset), 0), text.length),
			clientX,
			clientY
		};
	};
	private getTextOffsetFromClientPoint = (text: Text, clientX: number, clientY: number) => {
		const ownerDocument = text.node?.ownerDocument;
		if (!text.node || !ownerDocument) {
			return 0;
		}

		const caretPoint = this.getTextPointFromClientPoint(clientX, clientY);
		if (caretPoint?.text === text) {
			return caretPoint.offset;
		}

		let closestOffset = 0;
		let closestDistance = Number.POSITIVE_INFINITY;
		for (let offset = 0; offset <= text.length; offset++) {
			const [textNode, nodeOffset] = this.findTextNode(text.node, offset);
			if (!textNode) {
				continue;
			}

			const range = ownerDocument.createRange();
			range.setStart(textNode, nodeOffset);
			range.collapse(true);
			const rect = range.getBoundingClientRect();
			const fallbackRect = text.node.getBoundingClientRect();
			const x = rect.width || rect.height ? rect.left : fallbackRect.left;
			const y = rect.width || rect.height ? rect.top + rect.height / 2 : fallbackRect.top;
			const distance = Math.hypot(clientX - x, clientY - y);
			if (distance < closestDistance) {
				closestDistance = distance;
				closestOffset = offset;
			}
		}

		return closestOffset;
	};
	setTextSelectionFromPointer = (text: Text, clientX: number, clientY: number) => {
		const offset = this.getTextOffsetFromClientPoint(text, clientX, clientY);
		this.setCollapsedStateAtTextOffset(text, offset);
		if (text.node) {
			const [textNode, nodeOffset] = this.findTextNode(text.node, offset);
			if (textNode) {
				this.setAtNodeOffset(textNode, nodeOffset);
			}
		}
	};

	capturePointerDragStart = (event: PointerEvent) => {
		if (event.button !== 0) {
			this.pointerDragStart = null;
			return;
		}

		this.pointerDragStart = this.getTextPointFromClientPoint(event.clientX, event.clientY);
	};
	clearPointerDragStart = () => {
		this.pointerDragStart = null;
	};
	collapseSelectedBlocksAtPointer = (event: PointerEvent) => {
		if (event.button !== 0 || this.selectedBlocks.size === 0) {
			return;
		}

		const point = this.getTextPointFromClientPoint(event.clientX, event.clientY);
		if (!point) {
			return;
		}

		this.setCollapsedStateAtTextOffset(point.text, point.offset);
		void this.setAtTextOffset(point.text, point.offset);
	};

	restoreInlineAtomDragRange = (event: PointerEvent) => {
		const dragStart = this.pointerDragStart;
		this.pointerDragStart = null;

		if (!dragStart || event.button !== 0) {
			return;
		}

		const dragEnd = this.getTextPointFromClientPoint(event.clientX, event.clientY);
		if (!dragEnd) {
			return;
		}

		const movement = Math.hypot(
			event.clientX - dragStart.clientX,
			event.clientY - dragStart.clientY
		);
		if (movement < 4) {
			return;
		}

		window.setTimeout(() => {
			if (dragStart.text.parent !== dragEnd.text.parent) {
				return;
			}

			const content = dragStart.text.parent.content;
			const startIndex = content.indexOf(dragStart.text);
			const endIndex = content.indexOf(dragEnd.text);
			const firstTextIndex = Math.min(startIndex, endIndex);
			const lastTextIndex = Math.max(startIndex, endIndex);
			const hasInlineAtomBetweenTextPoints = content.some(
				(part, index) =>
					part instanceof InlineBlock && index > firstTextIndex && index < lastTextIndex
			);
			if (startIndex === -1 || endIndex === -1 || !hasInlineAtomBetweenTextPoints) {
				return;
			}

			const isReversed = startIndex > endIndex;
			const rangeStart = isReversed ? dragEnd : dragStart;
			const rangeEnd = isReversed ? dragStart : dragEnd;
			void (async () => {
				this.clearInlineBlockSelection();
				await this.setAtRange(rangeStart.text, rangeStart.offset, rangeEnd.text, rangeEnd.offset, {
					isReversed
				});
				this.clearInlineBlockSelection();
			})();
		});
	};

	/**
	 * `selectstart` is the only event fired before a drag-selection begins.
	 * A drag starting on `contenteditable=false` chrome (void/island
	 * chrome, inline atoms, placeholders, block handles, the render
	 * anchor) would anchor the DOM selection on nodes the model cannot
	 * represent — block-level selection owns that surface instead.
	 *
	 * The NEAREST `[contenteditable]` boundary decides: `false` means
	 * non-editable chrome, while a nested `true` (void-block captions
	 * re-enable editing on their text spans) keeps native selection.
	 * The root itself is excluded so readonly mode stays selectable.
	 */
	onSelectStart = (event: Event) => {
		// Native controls (todo checkboxes, plugin inputs…) keep their own
		// selection behavior.
		if (isNativeInteractiveEvent(event)) {
			return;
		}
		const element = getElementFromNode(event.target instanceof Node ? event.target : null);
		if (!element || !this.edytor.node?.contains(element)) {
			return;
		}
		// Walk ancestors to the nearest contenteditable boundary. Both the
		// attribute and the `contentEditable` property are checked — the
		// attach hooks of inline/void blocks set the property, which jsdom
		// does not reflect onto the attribute.
		let boundary: HTMLElement | null = element instanceof HTMLElement ? element : null;
		while (boundary && boundary !== this.edytor.node) {
			const state = boundary.getAttribute('contenteditable') ?? boundary.contentEditable;
			if (state === 'false') {
				event.preventDefault();
				return;
			}
			if (state === 'true' || state === 'plaintext-only' || state === '') {
				// Nested editable region (e.g. void-block captions re-enabling
				// editing on their text spans) keeps native selection.
				return;
			}
			boundary = boundary.parentElement;
		}
	};
	private nativeSelectionMatchesCurrentBlockSeam = (selection: DomSelectionSnapshot | null) => {
		const { startText, endText, yStart, yEnd, isBlockSpanning, isCollapsed, isReversed } =
			this.state;
		if (
			!selection?.anchorNode ||
			!selection.focusNode ||
			selection.isCollapsed ||
			isCollapsed ||
			!isBlockSpanning ||
			!startText ||
			!endText ||
			yStart !== startText.length ||
			yEnd !== 0
		) {
			return false;
		}

		const nativeIsReversed = isBackward(selection);
		const nativeStartNode = nativeIsReversed ? selection.focusNode : selection.anchorNode;
		const nativeStartOffset = nativeIsReversed ? selection.focusOffset : selection.anchorOffset;
		const nativeEndNode = nativeIsReversed ? selection.anchorNode : selection.focusNode;
		const nativeEndOffset = nativeIsReversed ? selection.anchorOffset : selection.focusOffset;

		return (
			nativeIsReversed === isReversed &&
			this.getTextOfNode(nativeStartNode) === startText &&
			this.getTextOfNode(nativeEndNode) === endText &&
			getYIndex(startText, nativeStartNode, nativeStartOffset) === yStart &&
			getYIndex(endText, nativeEndNode, nativeEndOffset) === yEnd
		);
	};

	onSelectionChange = () => {
		const selection = getDomSelectionSnapshot(this.edytor.node);
		if (this.isRestoringHistorySelection) {
			if (this.edytor.gestureSerial === this.historyRestoreGestureSerial) {
				// Latched echoes are consumed by the latch itself — leave
				// `ignoreNextSelectionChange` armed so the skip applies to the
				// first real selectionchange after the restore lands.
				return;
			}
			// A real user gesture landed inside the restore window — the
			// user owns the selection now (P1-3). Abort the pending restore
			// (version bump disarms `isCurrentRestore`), release the latch
			// so THIS change derives normally, and drop the armed echo-skip
			// that would have swallowed the user's caret move.
			this.historySelectionRestoreVersion++;
			this.isRestoringHistorySelection = false;
			this.ignoreNextSelectionChange = false;
		}
		if (this.ignoreNextSelectedBlockSelectionChange) {
			this.ignoreNextSelectedBlockSelectionChange = false;
			this.ignoreNextSelectionChange = false;
			return;
		}
		if (this.selectedBlocks.size > 0) {
			this.ignoreNextSelectionChange = false;
			return;
		}
		if (this.nativeSelectionMatchesCurrentBlockSeam(selection)) {
			return;
		}
		if (this.ignoreNextSelectionChange) {
			this.ignoreNextSelectionChange = false;

			if (this.selectedInlineBlock.size > 0) {
				return;
			}
		}

		if (this.restorePostDeleteShiftedCaret(selection)) {
			return;
		}

		if (this.restoreDriftedEchoCaret(selection)) {
			return;
		}

		this.lastEchoGestureSerial = this.edytor.gestureSerial;
		this.applySelectionSnapshot(selection);
	};

	/**
	 * The gesture serial observed when the last selectionchange echo was
	 * admitted — `restoreDriftedEchoCaret`'s user-decision discriminator.
	 * A serial change between echoes means a real gesture (pointer, key,
	 * focus) owns the new DOM position; an unchanged serial means the DOM
	 * caret moved without one — internal render churn re-parked it.
	 */
	private lastEchoGestureSerial = -1;
	/**
	 * Monotonic epoch bumped by every `setAtTextOffset` — a pending
	 * caret-write verification armed under an older epoch was superseded
	 * by a newer write and must not re-assert its stale target.
	 */
	private caretWriteEpoch = 0;

	/**
	 * Gecko caret-drift guard. When a render mutates the DOM under a live
	 * caret (a delta re-split shortening the text node, a keyed span
	 * remount), Firefox re-parks the caret at the surviving boundary —
	 * one position off — and the echo would re-mint anchors from the
	 * drifted spot. Detection is deliberately structural: every real user
	 * caret move is preceded by a gesture event (pointerdown/focusin/
	 * keydown/beforeinput → `markUserGesture` bumps `gestureSerial` and
	 * baselines `domSelectionChurnSeq`), so an echo at an unchanged serial
	 * while churn is still outstanding for the gesture window is drift —
	 * revert DOM to the resolved anchors. A matching echo derives as
	 * before; a quiet-serial echo with no outstanding churn is an
	 * ordinary foreign/programmatic write and derives too.
	 */
	private restoreDriftedEchoCaret = (selection: DomSelectionSnapshot | null): boolean => {
		const state = this.state;
		if (this.edytor.gestureSerial !== this.lastEchoGestureSerial) {
			return false;
		}
		if (this.edytor.domSelectionChurnSeq === this.edytor.churnBaselineAtGesture) {
			return false;
		}
		if (
			this.edytor.isComposing ||
			this.edytor.isHandlingUserInput ||
			this.pointerDragStart !== null ||
			this.expectHistoryRestore ||
			this.isRestoringHistorySelection ||
			this.selectedBlocks.size > 0 ||
			this.selectedInlineBlock.size > 0 ||
			!state.relativePosition ||
			!state.startText ||
			state.isBlockSpanning ||
			state.isVoid
		) {
			return false;
		}
		// The state is the projection of the anchors at this version.
		const resolved = { text: state.startText, offset: state.yStart };
		const resolvedEnd = { text: state.endText ?? state.startText, offset: state.yEnd };
		const container = this.edytor.node;
		if (!container || !selection?.anchorNode || !selection.focusNode) {
			return false;
		}
		if (!container.contains(selection.anchorNode)) {
			return false;
		}
		const nativeIsReversed = isBackward(selection);
		const domStartNode = nativeIsReversed ? selection.focusNode : selection.anchorNode;
		const domStartOffset = nativeIsReversed ? selection.focusOffset : selection.anchorOffset;
		const domEndNode = nativeIsReversed ? selection.anchorNode : selection.focusNode;
		const domEndOffset = nativeIsReversed ? selection.anchorOffset : selection.focusOffset;
		const domStartText = this.getTextOfNode(domStartNode);
		const domEndText = this.getTextOfNode(domEndNode);
		if (
			selection.isCollapsed === state.isCollapsed &&
			domStartText === resolved.text &&
			domEndText === resolvedEnd.text &&
			getYIndex(resolved.text, domStartNode, domStartOffset) === resolved.offset &&
			getYIndex(resolvedEnd.text, domEndNode, domEndOffset) === resolvedEnd.offset
		) {
			return false;
		}
		if (resolved.text === resolvedEnd.text && resolved.offset === resolvedEnd.offset) {
			void this.setAtTextOffset(resolved.text, resolved.offset);
			return true;
		}
		void this.setAtRange(resolved.text, resolved.offset, resolvedEnd.text, resolvedEnd.offset, {
			isReversed: state.isReversed
		});
		return true;
	};

	/**
	 * Android Chrome post-delete caret repair (Lexical
	 * `postDeleteSelectionToRestore` analogue). After a canceled backward
	 * delete Chrome mutates the DOM regardless and emits a
	 * `selectionchange` whose collapsed caret lands exactly one position
	 * right of the merge point the model just wrote. When the incoming
	 * snapshot is that tell-tale — same text, `target + 1`, while the
	 * model still sits at `target` — restore the model caret instead of
	 * deriving from the shifted DOM position.
	 *
	 * The `state` equality guard is what makes this safe against real
	 * caret moves: any legitimate move (hotkey, programmatic write, or an
	 * earlier real selectionchange) re-derives `state` off the recorded
	 * target first, so the check can only fire for the immediate
	 * post-delete echo.
	 */
	private restorePostDeleteShiftedCaret = (selection: DomSelectionSnapshot | null) => {
		const target = this.postDeleteCaretTarget;
		if (!target || !isAndroidChromeBrowser()) {
			return false;
		}
		const now = Date.now();
		if (now - target.at > ANDROID_POST_DELETE_RESTORE_WINDOW_MS) {
			this.postDeleteCaretTarget = null;
			return false;
		}
		if (!selection?.isCollapsed || !selection.anchorNode) {
			return false;
		}
		const { startText, yStart, isCollapsed } = this.#written;
		if (!isCollapsed || startText !== target.text || yStart !== target.offset) {
			return false;
		}
		if (this.getTextOfNode(selection.anchorNode) !== target.text) {
			return false;
		}
		if (
			getYIndex(target.text, selection.anchorNode, selection.anchorOffset) !==
			target.offset + 1
		) {
			return false;
		}

		this.postDeleteCaretTarget = null;
		void this.setAtTextOffset(target.text, target.offset);
		return true;
	};

	/**
	 * Records the collapsed caret just written to the DOM as the target
	 * Android's post-delete shift gets compared against. Armed by the
	 * cross-paragraph backward-delete signature: the caret was collapsed
	 * at the START of one text (where `deleteContentBackward` merges
	 * into the previous block) and the write lands inside a DIFFERENT
	 * text — the merge point — AND a delete command ran inside the
	 * snap-back window (`lastDeleteCommandAt`). Navigational writes with
	 * the same position signature (ArrowLeft at a text start, placeholder
	 * focus) never arm, so a real caret move can't be snapped back.
	 */
	lastDeleteCommandAt = 0;
	private recordPostDeleteCaretTarget = (previous: {
		startText: Text | null;
		yStart: number;
		isCollapsed: boolean;
	}) => {
		if (
			!previous.isCollapsed ||
			!previous.startText ||
			previous.yStart !== 0 ||
			!this.#written.isCollapsed ||
			!this.#written.startText ||
			this.#written.startText === previous.startText ||
			Date.now() - this.lastDeleteCommandAt > ANDROID_POST_DELETE_RESTORE_WINDOW_MS
		) {
			return;
		}

		this.postDeleteCaretTarget = {
			text: this.#written.startText,
			offset: this.#written.yStart,
			at: Date.now()
		};
	};

	applySelectionSnapshot = (
		selection: DomSelectionSnapshot | null,
		options: { restoreNormalizedDomRange?: boolean } = {}
	) => {
		if (this.ignoreNextSelectedBlockSelectionChange || this.selectedBlocks.size > 0) {
			this.ignoreNextSelectedBlockSelectionChange = false;
			return;
		}

		const container = this.edytor.container;
		if (
			!selection?.anchorNode ||
			!selection.focusNode ||
			!container?.contains(selection.anchorNode as Node) ||
			!container.contains(selection.focusNode as Node)
		) {
			return;
		}

		const activeElement = getActiveElement(this.edytor.node);
		if (
			activeElement instanceof Element &&
			this.edytor.node?.contains(activeElement) &&
			isNativeFormControl(activeElement)
		) {
			return;
		}

		// A selection inside a nested foreign editable belongs to the
		// island, not the model — deriving it would map the caret into the
		// island's host text and corrupt the next model-routed write. Both
		// endpoints are checked: a range anchored in host text but focused
		// inside an island must not resolve either.
		if (
			isNestedForeignEditableTarget(this.edytor.node, selection.anchorNode) ||
			isNestedForeignEditableTarget(this.edytor.node, selection.focusNode)
		) {
			return;
		}

		const { anchorNode, focusNode, anchorOffset, focusOffset } = selection;
		const isCollapsed = selection.isCollapsed;
		const ranges = getRangesFromSelection(selection);
		const isReversed = isBackward(selection);
		const startNode = isReversed ? focusNode : anchorNode;
		const endNode = isReversed ? anchorNode : focusNode;
		const start = isReversed ? focusOffset : anchorOffset;
		const end = isReversed ? anchorOffset : focusOffset;

		const selectedInlineBlock = this.getInlineBlockInSelectedRange(ranges[0]);
		const selectionParts = selectedInlineBlock
			? { startText: null, endText: null, inlineBlock: selectedInlineBlock }
			: this.getTextsInSelection(startNode, endNode, start, end);
		let { startText, endText, inlineBlock } = selectionParts;

		const placeholderInRange = getTextPlaceholderInRange(ranges[0]);
		if (placeholderInRange) {
			const overlayBlock = this.getBlockOfNode(placeholderInRange);
			const targetText = overlayBlock?.lastText ?? startText;
			const blockNode = overlayBlock?.node;
			const range = ranges[0];
			const isBoundaryInsideBlock = (node: Node) =>
				Boolean(blockNode && (blockNode === node || blockNode.contains(node)));
			const isRangeContainedByEmptyBlock = Boolean(
				range &&
				isBoundaryInsideBlock(range.startContainer) &&
				isBoundaryInsideBlock(range.endContainer)
			);
			if (targetText?.parent.isEmpty && (isCollapsed || isRangeContainedByEmptyBlock)) {
				this.setCollapsedStateAtTextOffset(targetText, 0);
				void this.setAtTextOffset(targetText, 0);
				return;
			}
		}

		if (!startText) {
			const islandBlock = this.getNonNativeEditableIslandBlock(startNode);
			if (islandBlock?.firstText) {
				return this.setAtTextOffset(islandBlock.firstText, 0);
			}

			// If the user is focusind on a white space node.
			if (this.state.startText && !inlineBlock) {
				const [textNode, nodeOffset] = this.state.startText.node
					? this.findTextNode(this.state.startText.node, this.state.yStart)
					: [null, 0];
				if (textNode) {
					this.setAtNodeOffset(textNode, nodeOffset);
				} else {
					this.setAtTextOffset(this.state.startText, this.state.yStart);
				}
				return;
			} else {
				clearDomSelection(this.edytor.node);
				if (inlineBlock) {
					this.selectInlineBlock(inlineBlock);
				} else {
					this.clearInlineBlockSelection();
				}
				return;
			}
		}

		const syntheticOverlay = isCollapsed ? getSyntheticTextOverlayElement(startNode, start) : null;
		if (syntheticOverlay) {
			const overlayBlock = this.getBlockOfNode(syntheticOverlay);
			const targetText = overlayBlock?.lastText ?? startText;
			this.setCollapsedStateAtTextOffset(targetText, targetText.length);
			return this.setAtTextOffset(targetText, targetText.length);
		}

		const rawYStart = getYIndex(startText, startNode, start);
		const rawYEnd = isCollapsed ? rawYStart : getYIndex(endText, endNode, end);
		let yStart = normalizeUtf16Boundary(
			startText.stringContent,
			rawYStart,
			isCollapsed ? 'forward' : 'backward'
		);
		let yEnd = isCollapsed
			? yStart
			: endText
				? normalizeUtf16Boundary(endText.stringContent, rawYEnd, 'forward')
				: rawYEnd;
		let shouldRestoreNormalizedDomRange = yStart !== rawYStart || yEnd !== rawYEnd;

		if (
			!isCollapsed &&
			endText &&
			startText.parent !== endText.parent &&
			endText === endText.parent.firstText &&
			yEnd === 0
		) {
			const previousEndText = endText.parent.closestPreviousBlock?.lastText ?? null;
			if (previousEndText?.node?.isConnected) {
				endText = previousEndText;
				yEnd = previousEndText.length;
				shouldRestoreNormalizedDomRange = true;
			}
		}
		if (!isCollapsed && startText === endText && yStart === yEnd) {
			// An empty native range reads as a caret; the DOM is normalized to one.
			shouldRestoreNormalizedDomRange = true;
		}

		if (startText?.parent.isEmpty && yStart > startText.length) {
			// In case the placeholder or suggestion is not absolutely positioned, we need to set the selection to the start of the text because caret may be placed after the placeholder which is deceptive
			return this.setAtTextOffset(startText, startText.length);
		}

		const inlineBlockSelectedByBoundaryRange = getInlineBlockBetweenBoundaryTexts(
			startText,
			endText,
			yStart,
			yEnd
		);
		if (inlineBlockSelectedByBoundaryRange) {
			clearDomSelection(this.edytor.node);
			this.selectInlineBlock(inlineBlockSelectedByBoundaryRange);
			return;
		}

		this.select(this.textValue(startText, yStart, endText ?? startText, yEnd, isReversed), 'dom', {
			startNode,
			endNode,
			edge: isCollapsed ? getMarkEdgeSide(startText, startNode, yStart) : undefined
		});
		if (shouldRestoreNormalizedDomRange && options.restoreNormalizedDomRange !== false && endText) {
			void this.setAtRange(startText, yStart, endText, yEnd, { isReversed });
		}

		// Remember when the derived selection came from a node-bound
		// native range (endpoints outside text elements — e.g. a block
		// node selection or a stray boundary node). Engines asynchronously
		// normalize such DOM selections into text points, so by the time a
		// keydown arrives the live DOM selection may no longer look
		// node-bound — the signature pins the flag to the derived
		// selection it describes and any differently-shaped derive clears
		// it.
		const derivedKey = `${startText.id}:${yStart}:${endText?.id}:${yEnd}:${isReversed ? 1 : 0}`;
		if (
			!isTextBoundSelectionPoint(selection.anchorNode) ||
			!isTextBoundSelectionPoint(selection.focusNode)
		) {
			this.#nodeBoundSelectionKey = derivedKey;
		} else if (this.#nodeBoundSelectionKey !== derivedKey) {
			this.#nodeBoundSelectionKey = null;
		}
	};

	#nodeBoundSelectionKey: string | null = null;

	/**
	 * Whether the live model selection was derived from a node-bound
	 * native range — the shape whose Shift+Arrow extension is
	 * engine-defined and therefore intercepted by the hotkey layer.
	 */
	hasNativeNodeSelection = () => {
		const { startText, endText, yStart, yEnd, isReversed } = this.state;
		if (!startText || !endText) {
			return false;
		}
		return (
			this.#nodeBoundSelectionKey ===
			`${startText.id}:${yStart}:${endText.id}:${yEnd}:${isReversed ? 1 : 0}`
		);
	};

	/**
	 * Anchor a text position into the BACKING text that owns the atom at
	 * that display position — the v14 replacement for
	 * `Y.createRelativePositionFromTypeIndex(yText, offset, -1)`.
	 *
	 * `affinity` decides which side of the position the anchor binds to
	 * (`'left'` = bound to the preceding atom, inserts at the position
	 * land on the anchor's right — the caret baseline `-1`; `'right'` =
	 * bound to the following atom, inserts land outside a range starting
	 * here). `offset` is an offset inside `text`'s display segment;
	 * `text.segStart + offset` is the block-level display offset the
	 * facade maps to the owning backing text — content routed from other
	 * blocks' backing texts (merges/splits) anchors correctly.
	 *
	 * `null` while the text isn't bound to a live block (mirrors the
	 * baseline where a non-integrated Y.Text couldn't produce an absolute
	 * position).
	 */
	createTextAnchor = (
		text: Text,
		offset: number,
		affinity: 'left' | 'right' = 'left'
	): TextAnchor | null => {
		const blockId = text.parent?._blockId;
		if (blockId == null || !text._live || !this.edytor.facade) {
			return null;
		}
		return this.edytor.facade.anchorAt(blockId, text.segStart + offset, affinity);
	};

	/**
	 * Resolve a `TextAnchor` → `{text, offset}` (offset within the text
	 * segment). The anchor is resolved through ownership — when the bound
	 * atoms moved to another block (merge/split), the returned text lives
	 * in that block; deleted atoms resolve to the gap where they lived;
	 * fully-unowned backing resolves to the owner seam. `null` when the
	 * anchor is unresolvable (deleted/hidden target or not-yet-integrated
	 * bound item — callers fall back to id/path restore).
	 */
	resolveTextAnchor = (anchor: TextAnchor): { text: Text; offset: number } | null => {
		const facade = this.edytor.facade;
		if (!facade) {
			return null;
		}
		const resolved = facade.resolveAnchor(anchor);
		if (!resolved) {
			return null;
		}
		const block = this.edytor.idToBlock.get(resolved.blockId);
		if (!block) {
			return null;
		}
		// Map the display offset onto a Text segment using the ENGINE-fresh
		// per-block read (`deriveContentParts` boundaries) — wrapper part
		// lengths can lag a model write until the mirror reconciles, which
		// would misplace the caret right after an edit. The live wrapper is
		// matched by `segOrd` (the segment ordinal it is bound to).
		//
		// U8a — scoped reads: `isVisibleBlock` carries the
		// `projectedBlock → null` oracle (hidden/deleted), `contentItems`
		// is the maintained per-block runs view `project()` itself reads —
		// same pair `Text.refreshFromProject` uses (U5). The old
		// `projectedBlock` call forced a full-tree `facade.project()` per
		// doc-version change — the dominant selection-restore cost at 5k.
		if (facade.isVisibleBlock(resolved.blockId)) {
			const parts = block.deriveContentParts(facade.contentItems(resolved.blockId));
			let off = 0;
			let lastTextPart: { segOrd: number; len: number } | null = null;
			let target: { segOrd: number; offset: number } | null = null;
			for (const part of parts) {
				const len = part.kind === 'text' ? part.items.reduce((n, i) => n + i.text.length, 0) : 1;
				if (part.kind === 'text') {
					lastTextPart = { segOrd: part.segOrd, len };
					if (resolved.offset <= off + len) {
						target = {
							segOrd: part.segOrd,
							offset: Math.max(0, resolved.offset - off)
						};
						break;
					}
				} else if (resolved.offset <= off) {
					break;
				}
				off += len;
			}
			const segOrd = target?.segOrd ?? lastTextPart?.segOrd;
			const segOffset = target?.offset ?? lastTextPart?.len ?? 0;
			const wrapper =
				segOrd == null
					? null
					: (block.content.find(
							(part): part is Text => part instanceof Text && part._segOrd === segOrd
						) ?? null);
			if (wrapper) {
				return { text: wrapper, offset: Math.min(segOffset, wrapper.length) };
			}
		}
		// Fallback — no projection (or no matching live wrapper): walk the
		// wrapper parts directly. Boundary offsets prefer the left part's
		// end.
		let off = 0;
		let lastText: Text | null = null;
		for (const part of block.content) {
			const len = part instanceof Text ? part.length : 1;
			if (part instanceof Text) {
				lastText = part;
				if (resolved.offset <= off + len) {
					return { text: part, offset: Math.max(0, resolved.offset - off) };
				}
			} else if (resolved.offset <= off) {
				break;
			}
			off += len;
		}
		return lastText ? { text: lastText, offset: lastText.length } : null;
	};

	restoreRelativePosition = (text: Text) => {
		if (this.expectHistoryRestore || this.isRestoringHistorySelection) {
			return;
		}
		// Atomic selections (block / inline-block) keep their own restore
		// machinery — a remote text edit must never collapse them to a caret.
		if (this.selectedBlocks.size > 0 || this.selectedInlineBlock.size > 0) {
			return;
		}
		// Mid pointer-drag the live DOM range IS the user's in-progress
		// choice — each drag derive already re-mints anchors on the moved
		// atoms, so a remote-edit restore here would only hijack the drag.
		if (this.pointerDragStart !== null) {
			return;
		}

		const state = this.state;
		if (!state.relativePosition) {
			return;
		}

		const resolved = this.resolveTextAnchor(state.relativePosition);
		if (!resolved) {
			return;
		}
		// The range end rides its own anchor (`endPosition`, 'left' affinity —
		// boundary inserts stay outside). An unresolvable end collapses at the
		// restored start rather than holding a stale offset on a dead span.
		const resolvedEnd = state.isCollapsed
			? resolved
			: state.endPosition
				? this.resolveTextAnchor(state.endPosition)
				: null;

		const touchesStart = text === state.startText;
		const touchesEnd = !state.isCollapsed && text === state.endText;
		if (!touchesStart && !touchesEnd) {
			// An endpoint's anchor can migrate INTO `text` while the state's
			// own wrapper stays live: a caret at a fresh split block's empty
			// start binds its anchor to the neighbor's atoms, and a remote
			// merge then claims those atoms into the neighbor's text. The
			// touched text owns the endpoint's position now — follow it.
			const startDriftedHere =
				resolved.text === text &&
				(resolved.text !== state.startText || resolved.offset !== state.yStart);
			const endDriftedHere =
				!state.isCollapsed &&
				resolvedEnd != null &&
				resolvedEnd.text === text &&
				(resolvedEnd.text !== state.endText || resolvedEnd.offset !== state.yEnd);
			if (!startDriftedHere && !endDriftedHere) {
				return;
			}
		}

		const activeElement = getActiveElement(this.edytor.node);
		const isEditorFocused =
			typeof Node !== 'undefined' &&
			activeElement instanceof Node &&
			Boolean(this.edytor.node?.contains(activeElement));
		if (!isEditorFocused) {
			const externalActiveElement =
				typeof HTMLElement !== 'undefined' &&
				activeElement instanceof HTMLElement &&
				this.edytor.node &&
				!this.edytor.node.contains(activeElement)
					? activeElement
					: null;
			// The model position is the projection of the anchors: nothing to
			// write. Only the native selection left inside the blurred editor
			// is repaired, and the user's outside focus kept.
			const repairBlurredNativeSelection = () => {
				// Ownership may have moved on while this repair waited (tick
				// + 0/50ms): any focusin or pointerdown back inside the editor
				// clears `lastUserGestureOutsideEditor` — a user who returned
				// to the editor (or a programmatic refocus) owns the caret
				// they just placed. Clearing the fresh DOM selection or
				// refocusing the stale external element would yank the
				// selection back out from under them.
				if (!this.edytor.lastUserGestureOutsideEditor) {
					return;
				}
				const selection = getDomSelection(this.edytor.node);
				if (
					this.edytor.node &&
					((selection?.anchorNode && this.edytor.node.contains(selection.anchorNode)) ||
						(selection?.focusNode && this.edytor.node.contains(selection.focusNode)))
				) {
					clearDomSelection(this.edytor.node);
				}

				const currentActiveElement = getActiveElement(this.edytor.node);
				const ownerDocument = this.edytor.node?.ownerDocument;
				const shouldRestoreExternalFocus =
					externalActiveElement?.isConnected &&
					(currentActiveElement === null ||
						currentActiveElement === ownerDocument?.body ||
						(this.edytor.node &&
							currentActiveElement instanceof Node &&
							this.edytor.node.contains(currentActiveElement)));
				if (shouldRestoreExternalFocus) {
					externalActiveElement.focus({ preventScroll: true });
				}
			};
			void tick().then(() => {
				repairBlurredNativeSelection();
				this.scheduleReassert(repairBlurredNativeSelection, [0, 50]);
			});
			return;
		}

		if (
			!resolvedEnd ||
			(resolved.text === resolvedEnd.text && resolved.offset === resolvedEnd.offset)
		) {
			this.setAtTextOffset(resolved.text, resolved.offset);
			return;
		}
		void this.setAtRange(resolved.text, resolved.offset, resolvedEnd.text, resolvedEnd.offset, {
			isReversed: state.isReversed
		});
	};

	/**
	 * Pre-remote-commit selection capture — the
	 * `reconcileSelectionAfterRemoteApply` counterpart. Position identity
	 * lives in the anchors (`relativePosition`/`endPosition`), which
	 * re-resolve on the post-apply document; capturing the state object
	 * preserves that identity even when the remote edit legitimately moves
	 * the caret (deletions before it, merges claiming its backing).
	 */
	captureSelectionForRemoteApply = (): {
		state: SelectionState;
		gestureSerial: number;
	} | null => {
		const state = this.state;
		if (!state.relativePosition || !state.startText) {
			return null;
		}
		return { state: { ...state }, gestureSerial: this.edytor.gestureSerial };
	};

	/**
	 * Post-render reconcile for remote commits (called from the `tick()`
	 * continuation after `flushMirror`). A remote apply can churn the DOM
	 * under a LIVE caret — a reconciled text node re-splits or gets
	 * replaced — and the browser re-parks the caret wherever the nodes land
	 * (Gecko clamps to the shortened node; Blink keeps the offset). The
	 * trailing `selectionchange` echo then re-derives the model from the
	 * drifted position and re-mints the anchor one atom off. Running after
	 * Svelte's flush but before the echo's task, this resolves the captured
	 * anchors on the post-apply document and re-asserts DOM ← model when
	 * they disagree, turning the echo into a no-op.
	 */
	reconcileSelectionAfterRemoteApply = (capture: {
		state: SelectionState;
		gestureSerial: number;
	}) => {
		if (this.expectHistoryRestore || this.isRestoringHistorySelection) {
			return;
		}
		if (this.selectedBlocks.size > 0 || this.selectedInlineBlock.size > 0) {
			return;
		}
		// Mid pointer-drag the live DOM range IS the user's in-progress
		// choice — remote churn repair would hijack it.
		if (this.pointerDragStart !== null) {
			return;
		}
		// A newer user gesture supersedes the captured position — the same
		// serial contract every other deferred selection write honors.
		if (this.edytor.gestureSerial !== capture.gestureSerial) {
			return;
		}
		if (this.edytor.isComposing) {
			return;
		}
		// Inside a user-input window the DOM caret is the user's own write
		// (autocorrect, IME commit, drop) — the input path owns the final
		// position. A commit under it can legitimately slide the captured
		// anchors (deleting the bound atom drops the anchor to the deletion
		// seam), so model→DOM re-assertion would revert the user's caret.
		if (this.edytor.isHandlingUserInput) {
			return;
		}
		const pre = capture.state;
		if (pre.isBlockSpanning || pre.isVoid || !pre.relativePosition) {
			return;
		}
		const resolved = this.resolveTextAnchor(pre.relativePosition);
		const resolvedEnd =
			pre.isCollapsed || !pre.endPosition ? resolved : this.resolveTextAnchor(pre.endPosition);
		if (!resolved || !resolvedEnd) {
			// Dead endpoints are restoreDeadSelectionEndpoints' recovery —
			// it ran during flushMirror and retries on text mount.
			return;
		}
		if (!resolved.text.node?.isConnected || !resolvedEnd.text.node?.isConnected) {
			return;
		}
		const container = this.edytor.node;
		if (!container) {
			return;
		}
		const selection = getDomSelectionSnapshot(container);
		if (selection?.anchorNode && selection.focusNode) {
			if (!container.contains(selection.anchorNode)) {
				// The DOM selection legitimately lives outside this editor —
				// not drift to repair.
				return;
			}
			const nativeIsReversed = isBackward(selection);
			const domStartNode = nativeIsReversed ? selection.focusNode : selection.anchorNode;
			const domStartOffset = nativeIsReversed ? selection.focusOffset : selection.anchorOffset;
			const domEndNode = nativeIsReversed ? selection.anchorNode : selection.focusNode;
			const domEndOffset = nativeIsReversed ? selection.anchorOffset : selection.focusOffset;
			const domStartText = this.getTextOfNode(domStartNode);
			const domEndText = this.getTextOfNode(domEndNode);
			if (
				selection.isCollapsed === pre.isCollapsed &&
				domStartText === resolved.text &&
				domEndText === resolvedEnd.text &&
				getYIndex(resolved.text, domStartNode, domStartOffset) === resolved.offset &&
				getYIndex(resolvedEnd.text, domEndNode, domEndOffset) === resolvedEnd.offset
			) {
				return;
			}
		}
		if (resolved.text === resolvedEnd.text && resolved.offset === resolvedEnd.offset) {
			void this.setAtTextOffset(resolved.text, resolved.offset);
			return;
		}
		void this.setAtRange(resolved.text, resolved.offset, resolvedEnd.text, resolvedEnd.offset, {
			isReversed: pre.isReversed
		});
	};

	/** The text and block the selection's start last resolved to (the seam origin once they die). */
	#lastText: Text | null = null;
	#lastBlock: string | null = null;

	private isEditorFocused = () => {
		const activeElement = getActiveElement(this.edytor.node);
		return (
			typeof Node !== 'undefined' &&
			activeElement instanceof Node &&
			Boolean(this.edytor.node?.contains(activeElement))
		);
	};

	/**
	 * Displayable (§2.4, a Surface fact): the block's own content is mounted
	 * and not hidden by view state — a collapsed toggle's body, a `hidden`
	 * subtree. A phantom content slot (a snippet that renders no `content()`)
	 * never mounts.
	 */
	#displayable = (id: string) => {
		const node = this.edytor.idToBlock
			.get(id)
			?.content.find((part): part is Text => part instanceof Text && part.node != null)?.node;
		return !!node && !node.closest(HIDDEN);
	};

	/** A caret at the seam `dead` vacated (`doc/anchors`); `null` when nothing displays. */
	#seamValue = (dead: string | null): SelectionValue | null => {
		const { facade } = this.edytor;
		const at = seam(facade, dead, this.#displayable);
		const anchor = at && facade.anchorAt(at.block, at.offset, 'left');
		return anchor ? textSelection(anchor) : null;
	};

	/**
	 * Post-mirror-flush repair of the endpoints this view did not author
	 * (R9: a command that declared its result selection authors its own), through
	 * `select()`. Text endpoints follow their anchors by projection; what is
	 * repaired is a value that no longer resolves: a block set keeps its live
	 * members, an atom that vanished leaves a caret at its block's start, and
	 * otherwise the selection lands at the seam of the block it last resolved in
	 * (`doc/anchors`: the replicated slot, displayable stops only). The model is
	 * written at once; a focused editor also displays it (also when the text the
	 * caret was displayed in died while its anchor moved on).
	 */
	restoreDeadSelectionEndpoints = () => {
		if (this.expectHistoryRestore || this.isRestoringHistorySelection) {
			return;
		}
		// Mid pointer-drag the user's in-progress range owns the selection; a
		// command that declared its result selection owns this view's endpoints.
		if (this.pointerDragStart !== null || this.edytor.dispatcher.authoring) {
			return;
		}
		const { value } = this;
		const facade = this.edytor.facade;
		let dead: string | null;
		if (value.kind === 'blocks') {
			const live = value.ids.filter((id) => facade.isVisibleBlock(id));
			if (live.length === value.ids.length) return;
			if (live.length) {
				this.select(blockSelection(live), 'repair');
				return;
			}
			dead = value.ids[0] ?? null;
		} else if (value.kind === 'atom') {
			if (this.state.startText) return;
			const anchor = facade.isVisibleBlock(value.blockId)
				? facade.anchorAt(value.blockId, 0, 'left')
				: null;
			if (anchor) {
				this.#land(textSelection(anchor));
				return;
			}
			dead = value.blockId;
		} else if (value.kind === 'text') {
			const state = this.state;
			if (state.startText) {
				const displayedDied = this.#lastText !== null && !this.#lastText._live;
				this.#lastText = state.startText;
				this.#lastBlock = state.startBlock?.id ?? null;
				this.deadEndpointRecoveryPending = false;
				if (displayedDied && this.isEditorFocused()) {
					if (state.isCollapsed) void this.setAtTextOffset(state.startText, state.yStart);
					else
						void this.setAtRange(state.startText, state.yStart, state.endText, state.yEnd, {
							isReversed: state.isReversed
						});
				}
				return;
			}
			dead = this.#lastBlock;
		} else {
			return;
		}
		// A live origin means the anchors are not integrated yet: they converge.
		if (dead !== null && facade.isVisibleBlock(dead)) return;
		const target = this.#seamValue(dead);
		// A live destination can exist in the model without a mounted DOM node
		// (a whole-document remote delete runs this pass before the replacement
		// paragraph mounts): the next `Text.attach` replays the recovery.
		this.deadEndpointRecoveryPending = !target;
		if (target) this.#land(target);
	};

	/** Select a repaired caret; a focused editor also displays it. */
	#land = (target: SelectionValue) => {
		const previous = this.caretSignature();
		this.select(target, 'repair');
		this.recordPostDeleteCaretTarget(previous);
		const { startText, yStart } = this.state;
		if (startText && this.isEditorFocused()) void this.setAtTextOffset(startText, yStart);
	};

	/**
	 * `Text.attach` hook — a real editable element just mounted. Replays
	 * a pending dead-endpoint recovery once, when the destination that was
	 * missing at `flushMirror` time now has a DOM node. Phantom content
	 * slots never attach, so this cannot retarget a caret onto hidden
	 * text; all admission guards (gesture serial, live endpoints, focus
	 * ownership) re-run inside the recovery itself.
	 */
	notifyTextMounted = () => {
		if (this.deadEndpointRecoveryPending) {
			this.restoreDeadSelectionEndpoints();
		}
	};

	/** A text range over one block's content (the triple-click shape); the start binds left. */
	private setStateFromBlockContentRange = (block: Block) => {
		const endText = edgeText(block, 'last');
		this.select(
			this.textValue(edgeText(block, 'first'), 0, endText, endText.length, false, 'left')
		);
	};

	/**
	 * Select a set of whole blocks. With no block, leave block selection:
	 * the value becomes the text range the set spanned.
	 */
	selectBlocks = (...blocks: Block[]) => {
		this.pendingBlockRangeRequest = null;
		if (blocks.length) {
			this.select(blockSelection(blocks.map((block) => block.id)));
			return;
		}
		this.ignoreNextSelectedBlockSelectionChange = false;
		const { value } = this;
		if (value.kind !== 'blocks') return;
		const [first, last] = [this.state.blocks[0], this.state.blocks.at(-1)];
		const endText = last && edgeText(last, 'last');
		this.select(
			first && endText
				? this.textValue(edgeText(first, 'first'), 0, endText, endText.length, false, 'left')
				: noSelection
		);
	};

	addBlockToSelection = (block: Block) => {
		const ids = this.value.kind === 'blocks' ? this.value.ids : [];
		if (!ids.includes(block.id)) this.select(blockSelection([...ids, block.id]));
	};

	removeBlockFromSelection = (block: Block) => {
		const ids = this.value.kind === 'blocks' ? this.value.ids : [];
		if (ids.includes(block.id)) this.select(blockSelection(ids.filter((id) => id !== block.id)));
	};

	setRangeStateAtTextOffsets = (
		startText: Text,
		startOffset: number,
		endText: Text,
		endOffset: number,
		options: { isReversed?: boolean } = {}
	) => {
		const range = this.normalizeTextRangePoints(
			startText,
			startOffset,
			endText,
			endOffset,
			options.isReversed ?? false
		);
		this.select(
			this.textValue(
				range.startText,
				range.startOffset,
				range.endText,
				range.endOffset,
				range.isReversed
			)
		);
	};

	setCollapsedStateAtTextOffset = (textOrId: Text | string, offset: number) => {
		this.clearModelSelectionPreservation();
		const text = textOrId instanceof Text ? textOrId : this.edytor.getTextById(textOrId);
		if (text) this.select(this.textValue(text, Math.min(Math.max(offset, 0), text.length)));
	};

	private findTextNode = (node: HTMLElement, offset: number = 0) => {
		let nodeOffset = 0;
		const treeWalker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT, (node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				return NodeFilter.FILTER_ACCEPT;
			}
			return NodeFilter.FILTER_SKIP;
		});
		let currentNode = treeWalker.nextNode();
		let textNode: Node | null = null;
		let currentOffset = 0;

		while (currentNode) {
			const endOffset = currentOffset + (currentNode as any).length;
			if (offset >= currentOffset && offset <= endOffset) {
				textNode = currentNode;
				nodeOffset = offset - currentOffset;
				break;
			}
			currentOffset = endOffset;
			currentNode = treeWalker.nextNode();
		}

		return [textNode, nodeOffset] as const;
	};
	/**
	 * Whether a foreign element currently holds DOM focus. While true, a
	 * DOM selection write would steal it back — Firefox focuses the
	 * contenteditable on `addRange` alone, no `.focus()` call needed — so
	 * async writers must fall back to the model-only write. Nothing/body
	 * focused stays writable (the programmatic-restore case), and a
	 * preventDefault'd outside mousedown (plugin chrome like the toolbar)
	 * keeps the editor's own focus, so it is writable too.
	 *
	 * Checked at WRITE time — `await` continuations resume only after the
	 * click's task completes, focus transfer included, so `activeElement`
	 * here is already settled.
	 */
	private foreignFocusOwnsSelection = () => {
		const activeElement = getActiveElement(this.edytor.node);
		const ownerDocument = this.edytor.node?.ownerDocument;
		return Boolean(
			this.edytor.node &&
			activeElement instanceof Node &&
			!this.edytor.node.contains(activeElement) &&
			activeElement !== ownerDocument?.body &&
			activeElement !== ownerDocument?.documentElement
		);
	};

	setAtTextOffset = async (
		textOrId: Text | string | undefined | null,
		textOffset: number | null | undefined = this.state.yStart,
		options: { verify?: boolean } = {}
	) => {
		if (!textOrId || typeof textOffset !== 'number') {
			return;
		}

		// Capture the position this write moves the caret FROM. A stale
		// native re-anchor (the DOM text node swapped after the write, the
		// browser re-establishing the anchor at its old absolute offset)
		// reverts the model to exactly this state — the signature the
		// post-write verification repairs.
		const verify = options.verify !== false;
		const preWriteState = verify ? this.#written : null;
		const gestureSerial = this.edytor.gestureSerial;
		// Every armed verify supersedes older pending ones — otherwise two
		// verifies fighting over different targets ping-pong the caret (each
		// observes `backToPreWrite` after the other drags state back).
		const writeEpoch = ++this.caretWriteEpoch;
		const commitVersion = this.edytor._docCommitVersion;
		const lookup = () => (textOrId instanceof Text ? textOrId : this.edytor.getTextById(textOrId));
		const callText = lookup();
		const clamp = (text: Text) => Math.min(Math.max(textOffset, 0), text.length);
		const intended = callText?._live ? this.textValue(callText, clamp(callText)) : null;
		// The model fallback: the anchors minted now, else (a text created or
		// already gone at call time) the ones its wrapper answers then.
		const fallback = () => {
			const text = lookup();
			const late = text?._live ? this.textValue(text, clamp(text)) : noSelection;
			this.#admit(intended ?? late, text ?? callText);
		};

		// Same staleness contract as `setAtRange`: the `getTextNode` awaits
		// below span a window where a foreign write (remote resolution,
		// repair restore, a newer user gesture) can re-target the model
		// selection. Committing then would stomp the newer state with this
		// call's captured offset.
		const stateAtCall = this.#written;
		const callTarget = {
			startText: stateAtCall.startText,
			endText: stateAtCall.endText,
			yStart: stateAtCall.yStart,
			yEnd: stateAtCall.yEnd,
			isCollapsed: stateAtCall.isCollapsed,
			isReversed: stateAtCall.isReversed
		};
		const stale = () => {
			// A newer user gesture supersedes the write even when it
			// re-picks the call-time position — position equality cannot
			// distinguish the newer decision, only the serial can. Runs for
			// EVERY admission, including string-id writes and the failure
			// fallbacks — a `Text` argument is not required to know a newer
			// gesture happened.
			if (this.edytor.gestureSerial !== gestureSerial) {
				return true;
			}
			const s = this.#written;
			if (s === stateAtCall) return false;
			const text = textOrId instanceof Text ? textOrId : this.edytor.getTextById(textOrId);
			if (
				text &&
				this.stateMatchesSelectionTarget(s, {
					startText: text,
					endText: text,
					yStart: textOffset,
					yEnd: textOffset,
					isCollapsed: true,
					isReversed: false
				})
			) {
				return false;
			}
			return !this.stateMatchesSelectionTarget(s, callTarget);
		};

		const done = () => {
			if (preWriteState) {
				this.scheduleCaretWriteVerification(
					textOrId,
					textOffset,
					preWriteState,
					gestureSerial,
					writeEpoch,
					commitVersion
				);
			}
		};

		for (let attempt = 0; attempt < 10; attempt++) {
			let node: HTMLElement;
			try {
				node = await this.edytor.getTextNode(textOrId);
			} catch {
				if (stale()) {
					done();
					return;
				}
				fallback();
				done();
				return;
			}
			if (!node.isConnected) {
				// A remount can leave `text.node` pointing at a detached element
				// for a few ticks — retry through it like a missing text node.
				// Falling back to a model-only write here would let a later
				// selectionchange re-derive the stale native position and
				// silently revert the caret.
				await tick();
				continue;
			}
			const [textNode, nodeOffset] = this.findTextNode(node, textOffset);

			if (textNode) {
				if (stale()) {
					done();
					return;
				}
				// The awaits above span a window where an outside click can
				// claim focus — writing the DOM range now would drag it back.
				if (this.foreignFocusOwnsSelection()) {
					fallback();
				} else {
					this.setAtNodeOffset(textNode, nodeOffset);
				}
				done();
				return;
			}

			await tick();
		}

		if (stale()) {
			done();
			return;
		}
		fallback();
		done();
	};

	/**
	 * A write's model-side fallback: the value minted when the write was
	 * requested (R4: anchors are captured at call time, before any await, so
	 * a target merged away meanwhile is followed through its atoms), or the
	 * seam of `origin`'s block when nothing of it resolves any more.
	 */
	#admit = (intended: SelectionValue, origin: Text | undefined) => {
		this.clearModelSelectionPreservation();
		if (project(intended, this.edytor.facade).start) {
			this.select(intended);
			return;
		}
		const target = origin && this.#seamValue(origin.parent?.id ?? null);
		if (target) this.select(target);
	};

	/**
	 * Bounded post-write repair: if the caret drifted back to the exact
	 * pre-write position inside the verify window and no user gesture
	 * intervened, the last derive was a stale native re-anchor echo —
	 * re-assert the intended offset. Gecko can re-anchor after EACH write
	 * while a remount chain settles (observed bouncing twice on Firefox),
	 * so the check re-arms a few times; `attemptsLeft` bounds the fight —
	 * a browser that permanently insists on its own position keeps it
	 * rather than looping.
	 */
	private scheduleCaretWriteVerification = (
		textOrId: Text | string,
		textOffset: number,
		preWriteState: SelectionState,
		gestureSerial: number,
		writeEpoch: number,
		commitVersion: number,
		attemptsLeft = 3
	) => {
		setTimeout(() => {
			if (this.edytor.destroyed || this.edytor.gestureSerial !== gestureSerial) {
				return;
			}
			// Superseded by a newer caret write, or a commit landed since
			// arming — a remote/local edit is a legitimate caret mover owned
			// by the post-commit reconcile, not evidence the write reverted.
			if (writeEpoch !== this.caretWriteEpoch || commitVersion !== this.edytor._docCommitVersion) {
				return;
			}
			// The verify repairs the caret the user is editing with — if
			// focus left the editor (click-out, foreign control), the caret
			// war is over: a re-assert would steal focus back from the
			// user's new target.
			const activeElement = getActiveElement(this.edytor.node);
			if (
				!this.edytor.node ||
				!(activeElement instanceof Node) ||
				!this.edytor.node.contains(activeElement)
			) {
				return;
			}
			const text = textOrId instanceof Text ? textOrId : this.edytor.getTextById(textOrId);
			const s = this.#written;
			const atTarget =
				s.isCollapsed && s.startText === text && s.yStart === textOffset && s.yEnd === textOffset;
			const backToPreWrite =
				s.isCollapsed === preWriteState.isCollapsed &&
				s.startText === preWriteState.startText &&
				s.endText === preWriteState.endText &&
				s.yStart === preWriteState.yStart &&
				s.yEnd === preWriteState.yEnd &&
				s.isReversed === preWriteState.isReversed;
			if (atTarget || !backToPreWrite) {
				return;
			}
			void this.setAtTextOffset(textOrId, textOffset, { verify: false });
			if (attemptsLeft > 0) {
				this.scheduleCaretWriteVerification(
					textOrId,
					textOffset,
					preWriteState,
					gestureSerial,
					this.caretWriteEpoch,
					commitVersion,
					attemptsLeft - 1
				);
			}
		}, SELECTION_WRITE_VERIFY_DELAY_MS);
	};

	setAtTextsRange = async (startText: Text, endText: Text) => {
		if (!startText.node || !endText.node) {
			return;
		}

		// Outside gesture owns the selection — a DOM write would steal the
		// user's focus back into the editor. Model write only.
		if (this.foreignFocusOwnsSelection()) {
			this.setRangeStateAtTextOffsets(startText, 0, endText, endText.length);
			return;
		}

		const [startTextNode, startNodeOffset] = this.findTextNode(startText.node, 0);
		const [endTextNode, endNodeOffset] = this.findTextNode(endText.node, endText.length);

		if (startTextNode && endTextNode) {
			const selection = getDomSelection(startText.node);
			// U8a — the live DOM selection already covers this exact range:
			// skip the redundant removeAllRanges/addRange write (each forces
			// synchronous layout), keep the state derive so the model mirrors
			// the live selection.
			if (
				domSelectionCoversRange(
					selection,
					startTextNode,
					startNodeOffset,
					endTextNode,
					endNodeOffset,
					false
				)
			) {
				this.edytor.expectInternalFocus();
				startTextNode.parentElement?.focus();
				this.applySelectionSnapshot(getDomSelectionSnapshot(startTextNode));
				return;
			}
			const range = createDomRange(startTextNode);
			range.setStart(startTextNode, startNodeOffset);
			range.setEnd(endTextNode, endNodeOffset);
			selection?.removeAllRanges();
			selection?.addRange(range);
			this.scrollCaretIntoView();

			this.edytor.expectInternalFocus();
			startTextNode.parentElement?.focus();
			this.applySelectionSnapshot(createDomSelectionSnapshotFromRange(range, selection ?? null));
		}
	};

	/**
	 * Typing affordance — scrolls the just-written caret into view only
	 * for real user input (`edytor.isHandlingUserInput`). Programmatic
	 * writes (`clear()`, remote sync, API-driven selection, deferred
	 * restores) must never move the page under the user.
	 */
	private scrollCaretIntoView = () => {
		if (this.edytor.isHandlingUserInput && this.edytor.suppressCaretScrollDepth === 0) {
			scrollCaretIntoView(this.edytor.node);
		}
	};

	#verticalExtendGoal: { column: number; signature: string } | null = null;

	/**
	 * Deterministic Shift+ArrowUp/ArrowDown extension over a text
	 * selection. Native vertical extension is engine-defined — Firefox can
	 * collapse the range at its anchor, drop the focus on stray boundary
	 * text nodes, or measure a different destination column than
	 * Blink/WebKit — so the same keypress used to derive three different
	 * model selections. The editor owns the semantic instead: the
	 * document-order edge nearest the motion direction moves one visual
	 * line (the start edge for `up`, the end edge for `down`) and the
	 * opposite edge stays as the pivot — `up` therefore yields a reversed
	 * range and `down` a forward one, matching Blink/WebKit conventions.
	 *
	 * Returns false when no model text selection is live (block/inline
	 * selections keep their own hotkey behavior) so callers can fall back
	 * to native handling.
	 */
	extendSelectionVertically = (direction: 'up' | 'down'): boolean => {
		const { startText, endText, yStart, yEnd, isReversed } = this.state;
		if (
			!startText ||
			!endText ||
			this.selectedBlocks.size > 0 ||
			this.selectedInlineBlock.size > 0
		) {
			return false;
		}

		const movingText = direction === 'up' ? startText : endText;
		const movingOffset = direction === 'up' ? yStart : yEnd;

		const signatureOf = (start: Text, ys: number, end: Text, ye: number, reversed: boolean) =>
			`${start.id}:${ys}:${end.id}:${ye}:${reversed ? 1 : 0}`;

		// Goal-column memory: consecutive vertical extends keep the column
		// the gesture started on instead of drifting toward clamped edges.
		const goal = this.#verticalExtendGoal;
		const column =
			goal && goal.signature === signatureOf(startText, yStart, endText, yEnd, isReversed)
				? goal.column
				: undefined;

		const destination = getVerticalLineDestination(movingText, movingOffset, direction, column);
		if (!destination) {
			return false;
		}

		const normalized =
			direction === 'up'
				? this.normalizeTextRangePoints(destination.text, destination.offset, endText, yEnd, true)
				: this.normalizeTextRangePoints(
						startText,
						yStart,
						destination.text,
						destination.offset,
						false
					);

		this.#verticalExtendGoal = {
			column: destination.column,
			signature: signatureOf(
				normalized.startText,
				normalized.startOffset,
				normalized.endText,
				normalized.endOffset,
				normalized.isReversed
			)
		};

		void this.setAtRange(
			normalized.startText,
			normalized.startOffset,
			normalized.endText,
			normalized.endOffset,
			{ isReversed: normalized.isReversed }
		);
		return true;
	};

	setAtRange = async (
		startText: Text | undefined | null,
		startOffset: number | undefined | null,
		endText: Text | undefined | null,
		endOffset: number | undefined | null,
		options: { isReversed?: boolean } = {}
	) => {
		if (
			!startText ||
			!endText ||
			typeof startOffset !== 'number' ||
			typeof endOffset !== 'number'
		) {
			return;
		}
		const requestedReversed =
			options.isReversed ??
			(!this.state.isCollapsed &&
				this.state.isReversed &&
				this.state.startText === startText &&
				this.state.endText === endText &&
				this.state.yStart === startOffset &&
				this.state.yEnd === endOffset);
		const normalizedRange = this.normalizeTextRangePoints(
			startText,
			startOffset,
			endText,
			endOffset,
			requestedReversed
		);
		startText = normalizedRange.startText;
		startOffset = normalizedRange.startOffset;
		endText = normalizedRange.endText;
		endOffset = normalizedRange.endOffset;

		// Staleness guard: this call awaits `getTextNode` before touching the
		// DOM, so a newer selection (a real selectionchange, another restore,
		// a programmatic collapse) can land in between. `this.state` is
		// replaced on every derive, so identity change + mismatch means the
		// write was superseded — dropping it is what stops a stale async
		// write from stomping a fresh caret. Direction is part of the
		// mismatch (P2-6): a newer range on the SAME endpoints with the
		// opposite direction still supersedes this write.
		const stateAtCall = this.#written;
		const gestureSerialAtCall = this.edytor.gestureSerial;
		const writeIsCollapsed = startText === endText && startOffset === endOffset;
		const writeTarget = {
			startText,
			endText,
			yStart: startOffset,
			yEnd: endOffset,
			isCollapsed: writeIsCollapsed,
			isReversed: normalizedRange.isReversed
		};
		const callTarget = {
			startText: stateAtCall.startText,
			endText: stateAtCall.endText,
			yStart: stateAtCall.yStart,
			yEnd: stateAtCall.yEnd,
			isCollapsed: stateAtCall.isCollapsed,
			isReversed: stateAtCall.isReversed
		};
		const previousCaret = this.caretSignature();
		const intended = this.textValue(
			startText,
			startOffset,
			endText,
			endOffset,
			normalizedRange.isReversed
		);
		// Admission gate for EVERY write this call can perform — DOM ranges
		// AND the model-side fallbacks. A newer user gesture (serial bump)
		// supersedes the write even when it re-picks the call-time position
		// — position equality cannot distinguish the newer decision. A
		// foreign state differing from both targets is likewise stale.
		const stale = () => {
			if (this.edytor.gestureSerial !== gestureSerialAtCall) return true;
			const s = this.#written;
			return (
				s !== stateAtCall &&
				!this.stateMatchesSelectionTarget(s, writeTarget) &&
				!this.stateMatchesSelectionTarget(s, callTarget)
			);
		};
		// U8a — both endpoint lookups each await at least one tick();
		// running them concurrently halves the serialized restore latency
		// (same flush semantics — each still ticks before reading .node).
		for (let attempt = 0; attempt < 10; attempt++) {
			let startNode: HTMLElement;
			let endNode: HTMLElement;
			try {
				[startNode, endNode] = await Promise.all([
					this.edytor.getTextNode(startText),
					this.edytor.getTextNode(endText)
				]);
			} catch {
				// Unresolvable endpoint (dead/malformed text) — fall back to
				// the model-side write like `setAtTextOffset`'s catch rather
				// than letting the rejection escape unhandled. The stale
				// gate applies HERE too: a lookup that only resolves after
				// a newer gesture must not commit the old range.
				if (stale()) {
					return;
				}
				this.#admit(intended, startText);
				if (writeIsCollapsed) {
					this.recordPostDeleteCaretTarget(previousCaret);
				}
				return;
			}
			const [startTextNode, startNodeOffset] = this.findTextNode(startNode, startOffset);
			const [endTextNode, endNodeOffset] = this.findTextNode(endNode, endOffset);
			// `state` is replaced on EVERY derive, so identity change alone
			// can't tell "foreign caret move" from an equivalent re-derive of
			// the call-time position (a selectionchange echo of the op's own
			// DOM mutation carries the pre-write position — no new intent).
			// Abort only when the live state differs from BOTH the write
			// target AND the call-time fields: a genuinely different
			// position. An echo of `stateAtCall` proceeds and this write
			// still corrects the DOM. A newer user GESTURE supersedes the
			// write even when it re-picks the call-time position — position
			// equality cannot distinguish the newer decision.
			if (stale()) {
				return;
			}

			// A remount can leave `text.node` detached for a few ticks — writing
			// into a dead subtree would land nothing in the live DOM while the
			// fabricated snapshot claims success; a later selectionchange then
			// re-derives the stale native position and reverts the caret. Retry
			// through the transient window (the staleness guard above still
			// aborts on genuinely newer writes).
			// The awaits above span a window where an outside click can
			// claim focus — writing the DOM range now would drag it back.
			if (this.foreignFocusOwnsSelection()) {
				this.#admit(intended, startText);
				if (writeIsCollapsed) {
					this.recordPostDeleteCaretTarget(previousCaret);
				}
				return;
			}
			if (startNode.isConnected && endNode.isConnected && startTextNode && endTextNode) {
				const selection = getDomSelection(startNode);
				const shouldRestoreBackwardRange = normalizedRange.isReversed;
				// U8a — the live DOM selection already covers this exact range
				// (direction included): skip the redundant
				// removeAllRanges/(addRange|setBaseAndExtent) write — each one
				// forces synchronous layout — but still run the state derive so
				// the model mirrors the live selection.
				if (
					domSelectionCoversRange(
						selection,
						startTextNode,
						startNodeOffset,
						endTextNode,
						endNodeOffset,
						shouldRestoreBackwardRange
					)
				) {
					this.edytor.expectInternalFocus();
					startTextNode.parentElement?.focus();
					this.applySelectionSnapshot(getDomSelectionSnapshot(startNode));
				} else {
					const range = createDomRange(startTextNode);
					range.setStart(startTextNode, startNodeOffset);
					range.setEnd(endTextNode, endNodeOffset);
					selection?.removeAllRanges();
					let restoredBackwardRange = false;
					if (selection && shouldRestoreBackwardRange) {
						restoredBackwardRange = restoreBackwardDomRange(
							selection,
							range,
							endTextNode,
							endNodeOffset,
							startTextNode,
							startNodeOffset
						);
					} else {
						selection?.addRange(range);
					}
					this.scrollCaretIntoView();
					this.edytor.expectInternalFocus();
					startTextNode.parentElement?.focus();
					this.applySelectionSnapshot(
						(restoredBackwardRange ? getDomSelectionSnapshot(startNode) : null) ??
							createDomSelectionSnapshotFromRange(range, selection ?? null)
					);
				}
				if (
					this.state.startText !== startText ||
					this.state.endText !== endText ||
					this.state.yStart !== startOffset ||
					this.state.yEnd !== endOffset
				) {
					this.setRangeStateAtTextOffsets(startText, startOffset, endText, endOffset, {
						isReversed: shouldRestoreBackwardRange
					});
				}
				if (startText === endText && startOffset === endOffset) {
					this.recordPostDeleteCaretTarget(previousCaret);
				}
				return;
			}
			await tick();
		}
	};

	setAtBlockRange = async (
		block?: Block | null,
		startOffset?: number,
		endOffset?: number,
		options: { syncModelState?: boolean } = {}
	) => {
		if (!block) {
			return;
		}
		if (!startOffset) {
			startOffset = 0;
		}
		if (!endOffset) {
			endOffset = edgeText(block, 'last').length;
		}
		const syncModelState =
			options.syncModelState !== false &&
			startOffset === 0 &&
			endOffset === edgeText(block, 'last').length;
		// Same staleness contract as `setAtRange`, captured BEFORE the
		// sync-model write below so a mid-await derive to a position that
		// matches neither the write target nor the call-time state aborts
		// this stale write instead of stomping the newer selection (P2-6).
		const stateAtCall = this.#written;
		const gestureSerialAtCall = this.edytor.gestureSerial;
		const callTarget = {
			startText: stateAtCall.startText,
			endText: stateAtCall.endText,
			yStart: stateAtCall.yStart,
			yEnd: stateAtCall.yEnd,
			isCollapsed: stateAtCall.isCollapsed,
			isReversed: stateAtCall.isReversed
		};
		const targetBlock = block;
		const resolvedStartOffset = startOffset;
		const resolvedEndOffset = endOffset;
		const syncStateToBlockRange = () => {
			if (syncModelState) {
				this.setStateFromBlockContentRange(targetBlock);
			} else {
				this.setRangeStateAtTextOffsets(
					edgeText(targetBlock, 'first'),
					resolvedStartOffset,
					edgeText(targetBlock, 'last'),
					resolvedEndOffset
				);
			}
		};
		if (syncModelState) {
			this.setStateFromBlockContentRange(block);
		}
		const blockRangeRequest = Symbol();
		this.pendingBlockRangeRequest = blockRangeRequest;
		// Same admission gate as `setAtRange`/`setAtTextOffset` — every
		// write this call can still perform (DOM range AND model-side
		// fallbacks) checks gesture serial + foreign-state drift.
		const blockStale = () => {
			if (this.edytor.gestureSerial !== gestureSerialAtCall) return true;
			const s = this.#written;
			const startText = edgeText(block, 'first');
			const endText = edgeText(block, 'last');
			return (
				s !== stateAtCall &&
				!this.stateMatchesSelectionTarget(s, {
					startText,
					endText,
					yStart: resolvedStartOffset,
					yEnd: resolvedEndOffset,
					isCollapsed: startText === endText && resolvedStartOffset === resolvedEndOffset,
					isReversed: false
				}) &&
				!this.stateMatchesSelectionTarget(s, callTarget)
			);
		};

		// U8a — overlap the two tick()-gated endpoint lookups (same flush
		// semantics, half the serialized latency). Remounts can leave the
		// resolved node detached for a few ticks — retry through that
		// transient window instead of writing into a dead subtree.
		for (let attempt = 0; attempt < 10; attempt++) {
			let startNode: HTMLElement;
			let endNode: HTMLElement;
			try {
				[startNode, endNode] = await Promise.all([
					this.edytor.getTextNode(edgeText(block, 'first')),
					this.edytor.getTextNode(edgeText(block, 'last'))
				]);
			} catch {
				// Unresolvable endpoint — mirror the model write like every
				// other `setAt*` writer instead of rejecting unhandled. A
				// superseded request writes nothing at all.
				if (this.pendingBlockRangeRequest === blockRangeRequest && !blockStale()) {
					syncStateToBlockRange();
					this.pendingBlockRangeRequest = null;
				}
				return;
			}
			const startText = edgeText(block, 'first');
			const endText = edgeText(block, 'last');
			const [startTextNode, startNodeOffset] = this.findTextNode(startNode, startOffset);
			const [endTextNode, endNodeOffset] = this.findTextNode(endNode, endOffset);

			if (!(startTextNode && endTextNode && startNode.isConnected && endNode.isConnected)) {
				if (this.pendingBlockRangeRequest !== blockRangeRequest) {
					return;
				}
				await tick();
				continue;
			}

			if (this.pendingBlockRangeRequest !== blockRangeRequest || this.selectedBlocks.size > 0) {
				return;
			}
			if (blockStale()) {
				return;
			}
			// Deferred write — if an outside gesture claimed the selection
			// since the call, the interaction is over: `addRange`/`focus()`
			// here would steal focus back from the user's new target. Land
			// the model write only, same as the unresolvable-endpoint path.
			if (this.foreignFocusOwnsSelection()) {
				syncStateToBlockRange();
				this.pendingBlockRangeRequest = null;
				return;
			}
			const selection = getDomSelection(startNode);
			// U8a — the live DOM selection already covers this exact range:
			// skip the redundant removeAllRanges/addRange write.
			if (
				domSelectionCoversRange(
					selection,
					startTextNode,
					startNodeOffset,
					endTextNode,
					endNodeOffset,
					false
				)
			) {
				this.edytor.expectInternalFocus();
				startTextNode.parentElement?.focus();
				this.applySelectionSnapshot(getDomSelectionSnapshot(startTextNode));
				this.pendingBlockRangeRequest = null;
				return;
			}
			const range = createDomRange(startTextNode);
			range.setStart(startTextNode, startNodeOffset);
			range.setEnd(endTextNode, endNodeOffset);
			selection?.removeAllRanges();
			selection?.addRange(range);
			this.scrollCaretIntoView();
			// this.edytor.node!.focus();
			this.edytor.expectInternalFocus();
			startTextNode.parentElement?.focus();
			this.applySelectionSnapshot(createDomSelectionSnapshotFromRange(range, selection ?? null));
			this.pendingBlockRangeRequest = null;
			return;
		}
	};

	setAtNodeOffset = (node: Node, offset: number) => {
		const selection = getDomSelection(node);
		// U8a — the caret is already exactly where this call would put it
		// (the common case: a second setAtTextOffset for the same offset
		// after reconcile, or a no-op restore). `addRange` forces a
		// synchronous layout pass even when it changes nothing — skip the
		// write, keep the state derive so callers still observe a fresh
		// snapshot.
		const previousState = this.caretSignature();
		if (domSelectionIsCollapsedAt(selection, node, offset)) {
			this.applySelectionSnapshot(getDomSelectionSnapshot(node));
			this.recordPostDeleteCaretTarget(previousState);
			return;
		}
		const range = createDomRange(node);
		range.setStart(node, offset);
		range.collapse(true);
		selection?.removeAllRanges();
		selection?.addRange(range);
		this.scrollCaretIntoView();
		this.applySelectionSnapshot(createDomSelectionSnapshotFromRange(range, selection ?? null));
		this.recordPostDeleteCaretTarget(previousState);
	};
}
