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
	getActiveElement,
	getDomSelectionSnapshot,
	type DomSelectionSnapshot
} from './domSelection.js';
import { domPointOf } from '$lib/surface/projector.svelte.js';
import { Block } from '../block/block.svelte.js';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { InlineBlock } from '../block/inlineBlock.svelte.js';
import type { EdgeSide } from '$lib/session/editing/text.js';
import type { JSONInlineBlock, JSONText } from '$lib/utils/json.js';
import { publishPresence } from '$lib/collaboration/awarenessSelection.js';
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
	serialize,
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

/**
 * Whether a DOM selection runs backward (focus before anchor in document
 * order), comparing boundary points — a focus on an ancestor element of the
 * anchor (`(textElement, childCount)`) is after it (F-S6).
 */
export const isBackward = (selection: {
	anchorNode: Node | null;
	anchorOffset: number;
	focusNode: Node | null;
	focusOffset: number;
}) => {
	const { anchorNode, focusNode } = selection;
	if (!anchorNode || !focusNode) return false;
	if (anchorNode === focusNode) return selection.focusOffset < selection.anchorOffset;
	try {
		const range = (anchorNode.ownerDocument ?? document).createRange();
		range.setStart(anchorNode, selection.anchorOffset);
		return range.comparePoint(focusNode, selection.focusOffset) < 0;
	} catch {
		return Boolean(
			anchorNode.compareDocumentPosition(focusNode) & Node.DOCUMENT_POSITION_PRECEDING
		);
	}
};

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
	/**
	 * Set for the synchronous window of THIS view's history command
	 * (`session/history`): the replay commits under the history's origin, so
	 * the remote-apply and repair restores stand aside — the view's recorded
	 * value is selected right after.
	 */
	expectHistoryRestore = false;
	ignoreNextSelectionChange = $state(false);
	ignoreNextSelectedBlockSelectionChange = $state(false);
	/**
	 * The collapsed caret target written by a cross-text jump — the
	 * write a backward merge/delete ends with. An Android-shifted
	 * `selectionchange` reporting `offset + 1` on that same text gets
	 * snapped back to this target (the named Android rule, V5).
	 */
	private postDeleteCaretTarget: { text: Text; offset: number; at: number } | null = null;
	private pointerDragStart: PointerTextPoint | null = null;
	private selectionDocument: Document | null = null;
	private shouldKeepModelSelectionForNextTextInsertion = false;
	private modelSelectionPreservationBlock: Block | null = null;

	/**
	 * The selection (R9, L4): a value — none, a text range of two anchors,
	 * one inline atom, or a set of block ids. Only `select()` replaces it.
	 */
	value = $state.raw<SelectionValue>(noSelection);
	/** Advanced by every `select()`. */
	epoch = 0;
	/**
	 * Advanced by every `select()` that did not come from the DOM: the
	 * projector displays the current value after the flush (R10).
	 */
	request = $state(0);
	/** The last display request came from a user-input frame: the display may scroll (O54). */
	scrollOnDisplay = false;
	/** The intent serial (gestures but `input`) when the last display was requested. */
	requestSerial = 0;
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
		const mirror = this.edytor._docCommitVersion;
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
		// A repair is a background display (it never takes focus); a command,
		// history or host code asks for one (R10).
		if (cause === 'repair') this.edytor.projector.render++;
		else if (cause !== 'dom') this.display();
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
		this.#caret = {
			startText: state.startText,
			yStart: state.yStart,
			isCollapsed: state.isCollapsed
		};
		this.edytor.history?.selected(value);
		if (state.startText) {
			this.#lastText = state.startText;
			this.#lastBlock = state.startBlock?.id ?? null;
		}
		if (!changed) return;
		// A dead view never publishes: its entry went with its teardown.
		if (!this.edytor.destroyed) {
			publishPresence(this.edytor.awareness, this.edytor.presenceKey, serialize(value, projection));
		}
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
		startAffinity?: 'left' | 'right',
		mint = this.createTextAnchor
	): SelectionValue => {
		const collapsed = startText === endText && yStart === yEnd;
		const start = mint(startText, yStart, startAffinity ?? (collapsed ? 'left' : 'right'));
		if (!start) return noSelection;
		if (collapsed) return textSelection(start);
		const end = mint(endText, yEnd, 'left') ?? start;
		return isReversed ? textSelection(end, start) : textSelection(start, end);
	};

	/**
	 * A write's intent (R4): `textValue` minted from each text's block record,
	 * live or not — the atoms of a text that died to a merge live on in the
	 * block that claimed them, so resolution follows them before any seam.
	 */
	#intent = (
		startText: Text,
		yStart: number,
		endText = startText,
		yEnd = yStart,
		isReversed = false
	): SelectionValue =>
		this.textValue(startText, yStart, endText, yEnd, isReversed, undefined, (text, at, side) => {
			const block = text.parent?._blockId;
			return block == null ? null : this.edytor.facade.anchorAt(block, text.segStart + at, side);
		});

	/** Ask the projector to display the current value after the flush (R10). */
	display = () => {
		this.scrollOnDisplay =
			this.edytor.isHandlingUserInput && this.edytor.suppressCaretScrollDepth === 0;
		this.requestSerial = this.edytor.intentSerial;
		this.request++;
	};

	/** The DOM nodes a display showed the current value with (DOM-derived fields). */
	observed = (surface: { startNode: Node | null; endNode: Node | null; edge?: EdgeSide }) => {
		this.#surface = { value: this.value, ...surface };
	};

	/** A pointer drag is in progress: the projector does not display under it (O57). */
	get dragging() {
		return this.pointerDragStart !== null;
	}

	/**
	 * The caret as the last `select()` left it — the Android snap-back's
	 * arming evidence ("a write moved a caret that sat at a text start"),
	 * which a projection that already followed the merge cannot give.
	 */
	#caret: { startText: Text | null; yStart: number; isCollapsed: boolean } = {
		startText: null,
		yStart: 0,
		isCollapsed: true
	};
	private caretSignature = () => this.#caret;

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
	destroy = () => {
		if (this.selectionDocument) {
			this.selectionDocument.removeEventListener('selectionchange', this.onSelectionChange);
			this.selectionDocument = null;
		}
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

	init = () => {
		if (typeof document !== 'undefined') {
			this.selectionDocument = this.edytor.node?.ownerDocument ?? document;
			this.selectionDocument.addEventListener('selectionchange', this.onSelectionChange);
		}
	};

	handleTripleClick = async (e: MouseEvent) => {
		if (e.detail < 3) return;
		const targetNode = e.target instanceof Node ? e.target : null;
		const clickedBlock = this.getBlockOfNode(targetNode);
		if (clickedBlock?.definition.void && !this.isInsideEditableText(targetNode)) {
			e.preventDefault();
			window.requestAnimationFrame(() => {
				window.setTimeout(() => {
					this.selectBlocks(clickedBlock);
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

				void this.setAtBlockRange(targetBlock);
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
			const [textNode, nodeOffset] = domPointOf(text.node, offset);
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
		void this.setAtTextOffset(text, this.getTextOffsetFromClientPoint(text, clientX, clientY));
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
		const { projector } = this.edytor;
		// Composition noise, the echo of the projector's own display, or a DOM
		// state older than a display still to land, is not intent (R10).
		if (projector.compositionNoise()) return;
		const selection = getDomSelectionSnapshot(this.edytor.node);
		if (projector.isEcho(selection) || projector.awaited) return;
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

		this.lastEchoGestureSerial = this.edytor.intentSerial;
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
	 * Gecko caret-drift guard. When a render mutates the DOM under a live
	 * caret (a delta re-split shortening the text node, a keyed span
	 * remount), Firefox re-parks the caret at the surviving boundary —
	 * one position off — and the echo would re-mint anchors from the
	 * drifted spot. Detection is deliberately structural: every real user
	 * caret move is preceded by a gesture event (pointerdown/focusin/
	 * keydown/beforeinput → `markUserGesture` bumps `intentSerial` and
	 * baselines `domSelectionChurnSeq`), so an echo at an unchanged serial
	 * while churn is still outstanding for the gesture window is drift —
	 * revert DOM to the resolved anchors. A matching echo derives as
	 * before; a quiet-serial echo with no outstanding churn is an
	 * ordinary foreign/programmatic write and derives too.
	 */
	private restoreDriftedEchoCaret = (selection: DomSelectionSnapshot | null): boolean => {
		const state = this.state;
		if (this.edytor.intentSerial !== this.lastEchoGestureSerial) {
			return false;
		}
		// Drift needs a render since the gesture AND since the last observation
		// (a display or a derive): with none, the move is a foreign write (F-S4).
		if (
			this.edytor.domSelectionChurnSeq === this.edytor.churnBaselineAtGesture ||
			!this.edytor.projector.renderedSinceObservation
		) {
			return false;
		}
		if (
			this.edytor.composition.live ||
			this.edytor.isHandlingUserInput ||
			this.pointerDragStart !== null ||
			this.expectHistoryRestore ||
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
		const { startText, yStart, isCollapsed } = this.state;
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
		const written = this.state;
		if (
			!previous.isCollapsed ||
			!previous.startText ||
			previous.yStart !== 0 ||
			!written.isCollapsed ||
			!written.startText ||
			written.startText === previous.startText ||
			Date.now() - this.lastDeleteCommandAt > ANDROID_POST_DELETE_RESTORE_WINDOW_MS
		) {
			return;
		}

		this.postDeleteCaretTarget = {
			text: written.startText,
			offset: written.yStart,
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
				void this.setAtTextOffset(targetText, 0);
				return;
			}
		}

		if (!startText) {
			const islandBlock = this.getNonNativeEditableIslandBlock(startNode);
			if (islandBlock?.firstText) {
				return this.setAtTextOffset(islandBlock.firstText, 0);
			}

			// A point on a white space node: the model caret is displayed again.
			if (this.state.startText && !inlineBlock) {
				this.display();
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
		this.edytor.projector.observe();
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
		return this.edytor.idToBlock.get(resolved.blockId)?.textAtOffset(resolved.offset) ?? null;
	};

	/** The text and block the selection's start last resolved to (the seam origin once they die). */
	#lastText: Text | null = null;
	#lastBlock: string | null = null;

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
	 * written at once; the projector displays it (also when the text the caret
	 * was displayed in died while its anchor moved on).
	 */
	restoreDeadSelectionEndpoints = () => {
		if (this.expectHistoryRestore) {
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
				// The text it was displayed in died while its anchor moved on: display again.
				if (this.#lastText !== null && !this.#lastText._live) this.display();
				this.#lastText = state.startText;
				this.#lastBlock = state.startBlock?.id ?? null;
				return;
			}
			dead = this.#lastBlock;
		} else {
			return;
		}
		// A live origin means the anchors are not integrated yet: they converge.
		if (dead !== null && facade.isVisibleBlock(dead)) return;
		// With no displayable stop yet (a whole-document remote delete runs this
		// pass before the replacement paragraph mounts), the value stays: the
		// projector's pass after the flush that mounts it runs this repair again.
		const target = this.#seamValue(dead);
		if (target) this.#land(target);
	};

	/** Select a repaired caret (the projector displays it). */
	#land = (target: SelectionValue) => {
		const previous = this.caretSignature();
		this.select(target, 'repair');
		this.recordPostDeleteCaretTarget(previous);
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

	setCollapsedStateAtTextOffset = (text: Text | undefined, offset: number) => {
		this.clearModelSelectionPreservation();
		if (text) this.select(this.textValue(text, Math.min(Math.max(offset, 0), text.length)));
	};

	/**
	 * Select a caret at `offset` of `textOrId`; the projector displays it after
	 * the flush (R10). The value is minted now (R4): a text that dies before the
	 * display is followed through its atoms, else the seam of its block.
	 */
	setAtTextOffset = async (
		text: Text | undefined | null,
		textOffset: number | null | undefined = this.state.yStart
	) => {
		if (!text || typeof textOffset !== 'number') return;
		const previous = this.caretSignature();
		this.#admit(this.#intent(text, Math.min(Math.max(textOffset, 0), text.length)), text);
		this.recordPostDeleteCaretTarget(previous);
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

	/** Select the whole content from `startText` to `endText` (the code block's select-all). */
	setAtTextsRange = async (startText: Text, endText: Text) =>
		this.setRangeStateAtTextOffsets(startText, 0, endText, endText.length);

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

	/** Select a text range; the projector displays it after the flush (R10). */
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
		const state = this.state;
		const range = this.normalizeTextRangePoints(
			startText,
			startOffset,
			endText,
			endOffset,
			options.isReversed ??
				(!state.isCollapsed &&
					state.isReversed &&
					state.startText === startText &&
					state.endText === endText &&
					state.yStart === startOffset &&
					state.yEnd === endOffset)
		);
		const previous = this.caretSignature();
		this.#admit(
			this.#intent(
				range.startText,
				range.startOffset,
				range.endText,
				range.endOffset,
				range.isReversed
			),
			range.startText
		);
		if (range.startText === range.endText && range.startOffset === range.endOffset) {
			this.recordPostDeleteCaretTarget(previous);
		}
	};

	/** Select `block`'s content (the whole of it by default); displayed after the flush. */
	setAtBlockRange = async (block?: Block | null, startOffset = 0, endOffset?: number) => {
		if (!block) return;
		const last = edgeText(block, 'last');
		const end = endOffset || last.length;
		if (!startOffset && end === last.length) this.setStateFromBlockContentRange(block);
		else this.setRangeStateAtTextOffsets(edgeText(block, 'first'), startOffset, last, end);
	};

	/**
	 * Anchors from a DOM selection, without selecting them: the projector mints
	 * an unobserved native move before a transaction it did not issue (BI-3).
	 */
	mint = (snapshot: DomSelectionSnapshot): SelectionValue | null => {
		const container = this.edytor.node;
		const { anchorNode, focusNode } = snapshot;
		if (!container || !anchorNode || !focusNode) return null;
		for (const node of [anchorNode, focusNode])
			if (!container.contains(node) || isNestedForeignEditableTarget(container, node)) return null;
		const reversed = isBackward(snapshot);
		const [startNode, start, endNode, end] = reversed
			? [focusNode, snapshot.focusOffset, anchorNode, snapshot.anchorOffset]
			: [anchorNode, snapshot.anchorOffset, focusNode, snapshot.focusOffset];
		const { startText, endText } = this.getTextsInSelection(startNode, endNode, start, end);
		if (!startText || !endText) return null;
		const at = (text: Text, node: Node, offset: number) =>
			Math.min(Math.max(getYIndex(text, node, offset), 0), text.length);
		return this.textValue(
			startText,
			at(startText, startNode, start),
			endText,
			at(endText, endNode, end),
			reversed
		);
	};
}
