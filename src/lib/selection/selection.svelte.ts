import type { Edytor } from '../edytor.svelte.js';
import { Text } from '../text/text.svelte.js';
import {
	climbDom,
	getElementFromNode,
	getInlineBlockOfNode,
	getInlineBlockInSelectedRange,
	getRangesFromSelection,
	getTextOfNode,
	getTextsInSelection,
	getYIndex,
	getMarkEdgeSide,
	isTextBoundSelectionPoint,
	normalizeUtf16Boundary,
	SYNTHETIC_TEXT_OVERLAY_SELECTOR
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
import type { EdgeSide, PendingMarks } from '$lib/session/editing/text.js';
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
	type AtomSide,
	type Marks,
	type SelectCause,
	type SelectionPoint,
	type SelectionProjection,
	type SelectionSegment,
	type SelectionValue
} from '$lib/session/selection.js';
import { seam } from '$lib/crdt/anchors.js';
import { getTextPath } from '$lib/events/events.utils.js';
import { landed } from '$lib/session/navigation.js';
import * as visibility from './visibility.js';
import { caretBeside, shownText, type SelectionInsertionTarget } from './replaceSelection.js';

/**
 * CRDT-stable anchor for a text position — `{b}` is the home block id of
 * the BACKING text the bound atom lives in (not necessarily the block that
 * displays it — merges/splits reroute display while the anchor stays on
 * the same atoms), `a` the engine anchor carrying the endpoint affinity in
 * its `a` field (`a < 0` = left, `a >= 0` = right). JSON-serializable;
 * replaces the v13 `RelativePosition`. Same wire shape as `DocAnchor` on
 * the facade (`facade.anchorAt`/`facade.resolveAnchor`).
 */
export type TextAnchor = { b: string; a: Anchor };

/**
 * The public read-only view (D3): the projection's endpoints as wrappers
 * (`startText`/`yStart`… offsets inside text segments). Projection facts —
 * `content`, `marks`, the `isAt…`/`is…Spanning` flags, `islandRoot`,
 * `voidRoot` — are read from `selection.projection`.
 */
type SelectionState = {
	yStart: number;
	yEnd: number;
	isCollapsed: boolean;
	isReversed: boolean;
	startText: Text | null;
	endText: Text | null;
	startBlock: Block | null;
	endBlock: Block | null;
	texts: Text[];
	blocks: Block[];
	isBlockSpanning: boolean;
	/** Focus is in a void block's own `input`/`textarea`. */
	isVoidEditableElement: boolean;
	/** R4 admission: the mark-edge side of a DOM-derived caret (`marksForInsertion`). */
	edge?: EdgeSide;
};

/** An inline suggestion (L12): content parts shown after a block's text until cleared. */
export type SuggestionParts = (JSONText[] | JSONInlineBlock)[];

/** The compatibility state of no (or an unresolvable) selection. */
const EMPTY_STATE: SelectionState = Object.freeze({
	yStart: 0,
	yEnd: 0,
	isCollapsed: true,
	isReversed: false,
	texts: [],
	blocks: [],
	startText: null,
	endText: null,
	startBlock: null,
	endBlock: null,
	isBlockSpanning: false,
	isVoidEditableElement: false
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
 * Where a range over `block` starts (`first`) or ends (`last`): its first or
 * last shown line (a list's items, a code block's lines, GX-03). A block that
 * shows none (a divider) passes to its neighbours as a caret does, the next
 * line first; to `cover` it, a start passes to the line before it and an end
 * to the line after it, so the range still holds it — when a line lies on
 * that side: a divider with none beyond it (it starts or ends the
 * document, or only dividers follow to that edge) is left out.
 */
const rangeEdge = (
	block: Block,
	edge: 'first' | 'last',
	cover = false
): SelectionInsertionTarget | null => {
	const text = shownText(block, edge);
	if (text) return { text, offset: edge === 'first' ? 0 : text.length };
	const before = cover && edge === 'first';
	return (
		caretBeside(block, before ? 'blockBefore' : 'blockAfter') ??
		caretBeside(block, before ? 'blockAfter' : 'blockBefore')
	);
};

export class EdytorSelection {
	edytor: Edytor;
	focusedBlocks = new SvelteSet<Block>();
	/** The selected blocks as clicked: a grip-selected list is one block. */
	selectedBlocks = new SvelteSet<Block>();
	/**
	 * The blocks a command over the block selection acts on, in document
	 * order: the selected blocks, a selected list or code block with its
	 * whole subtree (`sel.blocks.exact`). Delete, cut, copy and Turn into read it.
	 */
	get selectedMembers(): Block[] {
		return visibility.selectedMembers(this.edytor);
	}
	selectedInlineBlock = new SvelteSet<InlineBlock>();
	inlineBlockDeletionTarget: InlineBlock | null = null;
	/**
	 * Set for the synchronous window of THIS view's history command
	 * (`session/history`): the replay commits under the history's origin, so
	 * the remote-apply and repair restores stand aside — the view's recorded
	 * value is selected right after.
	 */
	expectHistoryRestore = false;
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
	/** The mark-edge side a display or a DOM derive observed the value with. */
	#surface: { value: SelectionValue; edge?: EdgeSide } | null = null;
	/** Blocks holding the last selection's endpoints: a suggestion there is cleared when they are left. */
	#edges: string[] = [];
	#compat = new WeakMap<SelectionProjection, { surface: unknown; state: SelectionState }>();

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
	 * The read-only wrapper view of the projection (D3): every field is a
	 * projection of (value, document version); `edge` comes from the Surface
	 * for the value it was observed with.
	 */
	get state(): SelectionState {
		const projection = this.projection;
		const surface = this.#surface?.value === this.value ? this.#surface : null;
		const hit = this.#compat.get(projection);
		if (hit && hit.surface === surface) return hit.state;
		const state = this.#view(this.value, projection, surface?.edge);
		this.#compat.set(projection, { surface, state });
		return state;
	}

	#textOf = (block: Block, segment: SelectionSegment | undefined): Text | null => {
		if (segment?.kind !== 'text') return null;
		return this.edytor.idToBlock.text(block.id, segment.segOrd);
	};

	#view = (
		value: SelectionValue,
		projection: SelectionProjection,
		edge: EdgeSide | undefined
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
		const segments = parts.filter((part) => part.kind === 'text');
		const [startSegment, endSegment] = [segments[0], segments.at(-1)];
		const startText = this.#textOf(startBlock, startSegment);
		const endText = this.#textOf(endBlock, endSegment);
		if (!startText || !endText || !startSegment || !endSegment) return EMPTY_STATE;
		const texts = segments.flatMap((part) => {
			const block = blockOf(part.block);
			return (block && this.#textOf(block, part)) ?? [];
		});
		const blocks =
			value.kind === 'blocks'
				? value.ids
						.filter((id) => this.edytor.facade.isVisibleBlock(id))
						.sort((a, b) => this.edytor.facade.compare(a, b))
						.flatMap((id) => blockOf(id) ?? [])
				: projection.blocks.flatMap((id) => blockOf(id) ?? []);
		const node = this.edytor.node;
		return Object.defineProperty(
			{
				yStart: start.offset - startSegment.start,
				yEnd: end.offset - endSegment.start,
				isCollapsed: projection.isCollapsed,
				isReversed: projection.isReversed,
				isBlockSpanning: projection.isBlockSpanning,
				texts,
				blocks,
				edge,
				startText,
				endText,
				startBlock,
				endBlock
			},
			'isVoidEditableElement',
			{
				enumerable: true,
				get: () =>
					projection.voidRoot !== null &&
					['INPUT', 'TEXTAREA'].includes(getActiveElement(node)?.tagName.toUpperCase() ?? '')
			}
		) as SelectionState;
	};

	/**
	 * The one commit point (R9): replaces the value, advances the epoch and
	 * applies every side effect once — the selected, atom and focused sets
	 * (hooks and attributes), clearing suggestions whose block the selection
	 * left, and, when the value changed, presence and `onSelectionChange`.
	 * `surface` carries the mark-edge side the value was observed with.
	 */
	select = (next: SelectionValue, cause: SelectCause = 'model', surface?: { edge?: EdgeSide }) => {
		next = this.#keepPending(this.#shown(next));
		const changed = !sameValue(this.value, next);
		if (changed) this.value = next;
		const value = this.value;
		this.epoch++;
		// A repair is a background display (it never takes focus); a command,
		// history or host code asks for one (R10).
		if (cause === 'repair') this.edytor.surface.update();
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

	/** The marks the next insertion at the caret takes (L4, values kept). */
	get pending(): PendingMarks | undefined {
		return this.value.kind === 'text' ? (this.value.pending as PendingMarks) : undefined;
	}

	/** Stage (or, with `undefined`, clear) the caret's pending marks: a new value, same anchors. */
	stage = (pending: Marks | undefined) => {
		const value = this.value;
		if (value.kind === 'text') this.select(Object.freeze({ ...value, pending }));
	};

	/**
	 * No text endpoint rests in a block that renders no content (FX-01): its
	 * slot never mounts, so typing there is saved and never shown. Such a
	 * caret moves to the nearest shown line — a container's first item, else
	 * the next line, else the end of the one before (a line just created is
	 * displayed once it mounts). A range's start moves to the block's first
	 * shown line and its end to its last (a list's items, `rangeEdge`, GX-03);
	 * a void's passes on as a caret does. With none, the value stays as it
	 * was. Every caret write passes here, and so does the repair after a
	 * change this view did not make.
	 */
	#shown = (next: SelectionValue): SelectionValue => {
		if (next.kind !== 'text') return next;
		const { start, end, isReversed } = project(next, this.edytor.facade);
		const caret = next.focus === next.anchor;
		const moved = (at: SelectionPoint | null, anchor: TextAnchor, edge: 'first' | 'last') => {
			const block = at && this.edytor.idToBlock.get(at.block);
			if (!block || block.rendersContent) return anchor;
			const to = caret
				? (caretBeside(block, 'blockAfter') ?? caretBeside(block, 'blockBefore'))
				: rangeEdge(block, edge);
			return to && this.createTextAnchor(to.text, to.offset);
		};
		const [first, last] = isReversed ? (['last', 'first'] as const) : (['first', 'last'] as const);
		const anchor = moved(isReversed ? end : start, next.anchor, first);
		const focus = caret ? anchor : moved(isReversed ? start : end, next.focus, last);
		if (anchor === next.anchor && focus === next.focus) return next;
		return anchor && focus ? textSelection(anchor, focus, next.pending) : this.value;
	};

	/** A caret that did not move keeps its pending marks (L4); a value that names them wins. */
	#keepPending = (next: SelectionValue): SelectionValue => {
		const prev = this.value;
		if (prev.kind !== 'text' || !prev.pending || next.kind !== 'text' || 'pending' in next)
			return next;
		const [a, b] = [project(prev, this.edytor.facade), project(next, this.edytor.facade)];
		const at = (p: SelectionPoint | null, q: SelectionPoint | null) =>
			p !== null && q !== null && p.block === q.block && p.offset === q.offset;
		return at(a.start, b.start) && at(a.end, b.end)
			? textSelection(next.anchor, next.focus, prev.pending)
			: next;
	};

	/** Diff one block set against its new members: hooks only for changes (the renderer draws the attributes). */
	#sync = (set: SvelteSet<Block>, blocks: Block[], kind: 'selected' | 'focused') => {
		const next = new Set(blocks);
		for (const block of set) {
			if (next.has(block)) continue;
			set.delete(block);
			// `onDeselect` pairs with `onSelect`; `onBlur` keeps firing on both
			// (it has historically doubled as the selection-loss hook).
			if (kind === 'selected') block.definition.onDeselect?.({ block });
			block.definition.onBlur?.({ block });
		}
		for (const block of next) {
			if (set.has(block)) continue;
			set.add(block);
			if (kind === 'selected') block.definition.onSelect?.({ block });
			else block.definition.onFocus?.({ block });
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
			return text.parent.isRoot
				? null
				: this.edytor.facade.anchorAt(text.blockId, text.segStart + at, side);
		});

	/** Ask the projector to display the current value after the flush (R10). */
	display = () => {
		this.scrollOnDisplay =
			this.edytor.isHandlingUserInput && this.edytor.suppressCaretScrollDepth === 0;
		this.requestSerial = this.edytor.intentSerial;
		this.request++;
	};

	/** The mark-edge side a display showed the current value with. */
	observed = (surface: { edge?: EdgeSide }) => {
		this.#surface = { value: this.value, ...surface };
	};

	/** A pointer drag is in progress: the projector does not display under it (O57). */
	get dragging() {
		return this.pointerDragStart !== null;
	}

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
	selectInlineBlock = (inlineBlock: InlineBlock, from: AtomSide = 'before') => {
		this.select(atomSelection(inlineBlock.parent.id, inlineBlock.id, from));
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
		// A native control inside the chrome (a void block's input) owns its press.
		if (!targetText || isNativeInteractiveEvent(event)) {
			return;
		}

		// The model answers this press: the browser's own caret placement on
		// the chrome is cancelled (a canceled pointerdown moves no selection).
		event.preventDefault();
		this.edytor.expectInternalFocus();
		this.edytor.node?.focus({ preventScroll: true });
		this.setAtTextOffset(targetText, 0);
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

	/**
	 * A triple click selects the block's content in the model; the browser's
	 * own multi-click selection is cancelled at its `mousedown`
	 * (`preventNativeTripleClick`), so no native selection competes with the display.
	 */
	handleTripleClick = (e: MouseEvent) => {
		if (e.detail < 3) return;
		const targetNode = e.target instanceof Node ? e.target : null;
		const clickedBlock = this.getBlockOfNode(targetNode);
		if (clickedBlock?.definition.void && !this.isInsideEditableText(targetNode)) {
			e.preventDefault();
			this.selectBlocks(clickedBlock);
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
		}
	};

	preventNativeTripleClick = (e: MouseEvent) => {
		if (e.detail >= 3) e.preventDefault();
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
		this.setAtTextOffset(text, this.getTextOffsetFromClientPoint(text, clientX, clientY));
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
		this.#dropped();
	};
	/** A normalization a pointer drag held back (the gesture is the user's, O57). */
	#held = false;
	/** The drag ended: the DOM selection it left is derived again, now normalized. */
	#dropped = () => {
		if (!this.#held) return;
		this.#held = false;
		this.applySelectionSnapshot(getDomSelectionSnapshot(this.edytor.node));
	};
	collapseSelectedBlocksAtPointer = (event: PointerEvent) => {
		if (event.button !== 0 || this.selectedBlocks.size === 0) {
			return;
		}

		const point = this.getTextPointFromClientPoint(event.clientX, event.clientY);
		if (!point) {
			return;
		}

		this.setAtTextOffset(point.text, point.offset);
	};

	restoreInlineAtomDragRange = (event: PointerEvent) => {
		const dragStart = this.pointerDragStart;
		this.pointerDragStart = null;
		this.#dropped();

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
			this.clearInlineBlockSelection();
			this.setAtRange(rangeStart.text, rangeStart.offset, rangeEnd.text, rangeEnd.offset, {
				isReversed
			});
			this.clearInlineBlockSelection();
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
	/**
	 * One classifier (R10, the projector): an echo or a DOM state older than a
	 * display still to land is ignored, and so is a move while a composition
	 * session is live (the IME's; the session's end displays); drift is
	 * displayed again; a foreign write or intent is adopted.
	 */
	onSelectionChange = () => {
		const selection = getDomSelectionSnapshot(this.edytor.node);
		const observation = this.edytor.projector.classify(selection);
		if (observation === 'echo' || observation === 'composition') return;
		if (observation === 'drift') return this.display();
		this.applySelectionSnapshot(selection);
	};

	applySelectionSnapshot = (
		selection: DomSelectionSnapshot | null,
		options: { restoreNormalizedDomRange?: boolean } = {}
	) => {
		if (this.selectedBlocks.size > 0) return;

		const container = this.edytor.node;
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
		// A native vertical move that landed on no caret stop takes the key's line stop (R9).
		if (
			isCollapsed &&
			!isTextBoundSelectionPoint(anchorNode) &&
			!this.getInlineBlockOfNode(anchorNode) &&
			landed(this.edytor)
		)
			return;
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
			// The shown block before: a closed toggle's header, not its hidden body.
			const previousEndText = visibility.shown(endText.parent, 'blockBefore')?.lastText ?? null;
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
			this.selectInlineBlock(inlineBlockSelectedByBoundaryRange, isReversed ? 'after' : 'before');
			return;
		}

		this.select(this.textValue(startText, yStart, endText ?? startText, yEnd, isReversed), 'dom', {
			edge: isCollapsed ? getMarkEdgeSide(startText, startNode, yStart) : undefined
		});
		this.edytor.projector.observe();
		if (shouldRestoreNormalizedDomRange && options.restoreNormalizedDomRange !== false && endText) {
			// Writing the DOM under a pointer drag would reset its anchor: after it.
			if (this.dragging) this.#held = true;
			else this.setAtRange(startText, yStart, endText, yEnd, { isReversed });
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
		if (text.parent.isRoot || !text.isInDocument) return null;
		return this.edytor.facade.anchorAt(text.blockId, text.segStart + offset, affinity);
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
	displayable = (id: string) => {
		const node = this.edytor.idToBlock
			.get(id)
			?.content.find((part): part is Text => part instanceof Text && part.node != null)?.node;
		return !!node && !node.closest(visibility.HIDDEN);
	};

	/** The view's visibility rule (`selection/visibility.ts`), for extensions: hidden by view state, and the shown neighbour. */
	hidden = visibility.hidden;
	shown = visibility.shown;

	/** The text's computed direction (a Surface fact): arrow and word keys are visual. */
	rtl = (text: Text) => !!text.node?.isConnected && getComputedStyle(text.node).direction === 'rtl';

	/** A caret at the seam `dead` vacated (`doc/anchors`); `null` when nothing displays. */
	#seamValue = (dead: string | null): SelectionValue | null => {
		const { facade } = this.edytor;
		const at = seam(facade, dead, this.displayable);
		const anchor = at && facade.anchorAt(at.block, at.offset, 'left');
		return anchor ? textSelection(anchor) : null;
	};

	/**
	 * Post-mirror-flush repair of the endpoints this view did not author
	 * (R9: a command that declared its result selection authors its own), through
	 * `select()`. Text endpoints follow their anchors by projection; what is
	 * repaired is a range whose content died (a caret at that point) and a
	 * value that no longer resolves: a block set keeps its live
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
			// A peer or host code turned the block it rests in into one that shows
			// no content (an empty line into a divider): the nearest shown line.
			const shown = this.#shown(value);
			if (shown !== value) {
				this.#land(shown);
				return;
			}
			const state = this.state;
			const { start, isCollapsed } = this.projection;
			if (state.startText && start && isCollapsed && value.anchor !== value.focus) {
				// A range whose content died is a caret at the seam (`sel.seam.covered-atom`):
				// its two anchors would re-open around text re-inserted there.
				const caret = facade.anchorAt(start.block, start.offset, 'left');
				if (caret) {
					this.#land(textSelection(caret));
					return;
				}
			}
			if (state.startText) {
				// The text it was displayed in died while its anchor moved on: display again.
				if (this.#lastText !== null && !this.#lastText.isInDocument) this.display();
				this.#lastText = state.startText;
				this.#lastBlock = state.startBlock?.id ?? null;
				return;
			}
			dead = this.#lastBlock;
		} else {
			// An emptied document rests the caret in its virtual paragraph (`doc.empty.virtual`).
			const virtual = facade.virtual();
			if (virtual !== null) this.#land(textSelection(facade.anchorAt(virtual, 0, 'left')!));
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
	#land = (target: SelectionValue) => this.select(target, 'repair');

	/**
	 * A text range from `first`'s first shown line to `last`'s last (the
	 * triple-click shape; `rangeEdge`); the start binds left. None when no
	 * line is shown.
	 */
	#contentRange = (first: Block, last = first): SelectionValue | null => {
		const [from, to] = [rangeEdge(first, 'first', true), rangeEdge(last, 'last', true)];
		return from && to
			? this.textValue(from.text, from.offset, to.text, to.offset, false, 'left')
			: null;
	};
	/** Select `block`'s content range (the triple-click shape), when it shows a line. */
	private setStateFromBlockContentRange = (block: Block) => {
		const range = this.#contentRange(block);
		if (range) this.select(range);
	};

	/**
	 * Select a set of whole blocks. With no block, leave block selection:
	 * the value becomes the text range the set showed, from its first shown
	 * line to its last (a list's items; a divider at an edge stays covered
	 * unless no line lies beyond it, `rangeEdge`), and stays as it is
	 * when no line is shown anywhere.
	 */
	selectBlocks = (...blocks: Block[]) => {
		if (blocks.length) {
			this.select(blockSelection(blocks.map((block) => block.id)));
			return;
		}
		const { value } = this;
		if (value.kind !== 'blocks') return;
		const [first, last] = [this.state.blocks[0], this.state.blocks.at(-1)];
		const range = first && last ? this.#contentRange(first, last) : noSelection;
		if (range) this.select(range);
	};

	addBlockToSelection = (block: Block) => {
		const ids = this.value.kind === 'blocks' ? this.value.ids : [];
		if (!ids.includes(block.id)) this.select(blockSelection([...ids, block.id]));
	};

	removeBlockFromSelection = (block: Block) => {
		const ids = this.value.kind === 'blocks' ? this.value.ids : [];
		if (ids.includes(block.id)) this.select(blockSelection(ids.filter((id) => id !== block.id)));
	};

	/**
	 * Select a caret at `offset` of `text`; the projector displays it after
	 * the flush (R10). The value is minted now (R4): a text that dies before the
	 * display is followed through its atoms, else the seam of its block.
	 */
	setAtTextOffset = (
		text: Text | undefined | null,
		textOffset: number | null | undefined = this.state.yStart
	) => {
		if (!text || typeof textOffset !== 'number') return;
		this.#admit(this.#intent(text, Math.min(Math.max(textOffset, 0), text.length)), text);
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
	setAtTextsRange = (startText: Text, endText: Text) => {
		this.setAtRange(startText, 0, endText, endText.length);
	};

	/** Select a text range; the projector displays it after the flush (R10). */
	setAtRange = (
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
	};

	/**
	 * Select `block`'s content (the whole of it by default): from its first
	 * shown line to its last (a list's items, a code block's lines, GX-03), the
	 * offsets in those lines. A block that shows no line (a divider) keeps the
	 * current value. Displayed after the flush.
	 */
	setAtBlockRange = (block?: Block | null, startOffset = 0, endOffset?: number) => {
		const [first, last] = block ? [shownText(block, 'first'), shownText(block, 'last')] : [];
		if (!first || !last) return;
		const end = endOffset || last.length;
		if (!startOffset && end === last.length)
			this.select(this.textValue(first, 0, last, last.length, false, 'left'));
		else this.setAtRange(first, startOffset, last, end);
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
