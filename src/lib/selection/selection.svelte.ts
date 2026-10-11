import type { Edytor } from '../edytor.svelte.js';
import { Text } from '../text/text.svelte.js';
import {
	getElementFromNode,
	getInlineBlockOfNode,
	getInlineBlockInSelectedRange,
	getTextOfNode,
	getYIndex,
	getMarkEdgeSide,
	offsetIn,
	ordered,
	isTextBoundSelectionPoint,
	normalizeUtf16Boundary,
	SYNTHETIC_TEXT_OVERLAY_SELECTOR
} from './selection.utils.js';
import {
	clearDomSelection,
	createDomRange,
	getActiveElement,
	type DomSelectionSnapshot
} from './domSelection.js';
import { getDomSelectionSnapshot } from './domSelection.js';
import type { Block } from '../block/block.svelte.js';
import { SvelteSet } from 'svelte/reactivity';
import { InlineBlock } from '../block/inlineBlock.svelte.js';
import type { EdgeSide, PendingMarks } from '$lib/session/editing/text.js';
import type { RangeEndpoints } from './replaceSelection.js';
import {
	isKindControl,
	isNativeInteractiveControl,
	isOwnPoint
} from '$lib/events/nativeInteractiveControl.js';
import type { Anchor } from '$lib/crdt/text/model.js';
import {
	atomSelection,
	blockSelection,
	noSelection,
	project,
	sameEnds,
	sameValue,
	serialize,
	textSelection,
	type AtomSide,
	type Marks,
	type SelectCause,
	type SelectionPoint,
	type SelectionProjection,
	type SelectionValue
} from '$lib/session/selection.js';
import { seam } from '$lib/crdt/anchors.js';
import { landed } from '$lib/session/navigation.js';
import * as visibility from './visibility.js';
import { SelectionPointer } from './pointer.svelte.js';
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
 * A caret in block offsets: the block and the offset in its content, the
 * offsets `edytor.document.facade` takes (an inline atom counts 1). The
 * public form of a collapsed text selection (`selection.caret`), and what
 * `selection.setCaret` and `dispatcher.caret` take.
 */
export type Caret = { block: Block; offset: number };

/** A text range's endpoints and the texts it covers, in text-segment offsets. @internal */
export type TextRange = RangeEndpoints & { texts: Text[] };

/**
 * Whether a DOM selection runs backward (focus before anchor in document
 * order), comparing boundary points — a focus on an ancestor element of the
 * anchor (`(textElement, childCount)`) is after it.
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
		const range = createDomRange(anchorNode);
		range.setStart(anchorNode, selection.anchorOffset);
		return range.comparePoint(focusNode, selection.focusOffset) < 0;
	} catch {
		return Boolean(
			anchorNode.compareDocumentPosition(focusNode) & Node.DOCUMENT_POSITION_PRECEDING
		);
	}
};

/** A text suggestion's preview at a DOM point: around it, or the child at either side of it. */
const overlayAt = (node: Node | null, offset: number): HTMLElement | null => {
	const own = getElementFromNode(node)?.closest<HTMLElement>(SYNTHETIC_TEXT_OVERLAY_SELECTOR);
	if (own || !(node instanceof Element)) return own ?? null;
	for (const child of [node.childNodes[offset], node.childNodes[offset - 1]]) {
		if (!(child instanceof HTMLElement)) continue;
		if (child.matches(SYNTHETIC_TEXT_OVERLAY_SELECTOR)) return child;
		const inner = child.querySelector<HTMLElement>(SYNTHETIC_TEXT_OVERLAY_SELECTOR);
		if (inner) return inner;
	}
	return null;
};

/** The one inline atom between the end of `start` and the start of `end`, in one block. */
const atomBetween = (start: Text, end: Text | null, yStart: number, yEnd: number) => {
	if (!end || start.parent !== end.parent || yStart !== start.length || yEnd !== 0) return null;
	const content = start.parent.content;
	const [from, to] = [content.indexOf(start), content.indexOf(end)];
	const part = from !== -1 && to === from + 2 ? content[from + 1] : null;
	return part instanceof InlineBlock ? part : null;
};

/**
 * Where a range ending in `block` starts (`first`) or ends (`last`): its
 * first or last shown line (a list's items, a code block's lines); a block
 * that shows none (a divider) passes to its neighbours as a caret does, the
 * next line first.
 */
const rangeEdge = (block: Block, edge: 'first' | 'last'): SelectionInsertionTarget | null => {
	const text = shownText(block, edge);
	if (text) return { text, offset: edge === 'first' ? 0 : text.length };
	return caretBeside(block, 'blockAfter') ?? caretBeside(block, 'blockBefore');
};

/** One block's membership of the selected and focused sets, as its own two signals. */
class Membership {
	selected = $state(false);
	focused = $state(false);
}

export class EdytorSelection {
	edytor: Edytor;
	#focused = new SvelteSet<Block>();
	#selected = new SvelteSet<Block>();
	/**
	 * Each rendered block's membership (`keep`), written with the sets: a
	 * block's attributes follow its own membership, where a `SvelteSet`'s
	 * `has` of a block it does not hold follows every change of the set — a
	 * caret moving to the next block would re-run every block's attributes.
	 */
	#members = new WeakMap<Block, Membership>();
	/** The blocks the selection touches (read-only: `select()` keeps it). */
	get focusedBlocks(): ReadonlySet<Block> {
		return this.#focused;
	}
	/**
	 * The selected blocks as clicked: a grip-selected list is one block
	 * (read-only: `select()` keeps it).
	 */
	get selectedBlocks(): ReadonlySet<Block> {
		return this.#selected;
	}
	/**
	 * The blocks a command over the block selection acts on, in document
	 * order: the selected blocks, a selected list or code block with its
	 * whole subtree (`sel.blocks.exact`). Delete, cut, copy and Turn into read it.
	 */
	get selectedMembers(): Block[] {
		return visibility.selectedMembers(this.edytor);
	}
	selectedInlineBlock = new SvelteSet<InlineBlock>();
	/** @internal */
	inlineBlockDeletionTarget: InlineBlock | null = null;
	/**
	 * Set for the synchronous window of THIS view's history command
	 * (`session/history`): the replay commits under the history's origin, so
	 * the remote-apply and repair restores stand aside — the view's recorded
	 * value is selected right after.
	 * @internal
	 */
	expectHistoryRestore = false;
	/** @internal The selection under a pointer: a press, its drag and its release. */
	readonly pointer = new SelectionPointer(this);
	#document: Document | null = null;

	/**
	 * The selection: a value — none, a text range of two anchors,
	 * one inline atom, or a set of block ids. Read-only: only `select()`
	 * replaces it.
	 */
	get value(): SelectionValue {
		return this.#value;
	}
	#value = $state.raw<SelectionValue>(noSelection);
	/** @internal Advanced by every `select()`. */
	epoch = 0;
	/**
	 * Advanced by every `select()` that did not come from the DOM: the
	 * projector displays the current value after the flush.
	 * @internal
	 */
	request = $state(0);
	/** @internal The last display request came from a user-input frame: the display may scroll. */
	scrollOnDisplay = false;
	/** @internal The intent serial (gestures but `input`) when the last display was requested. */
	requestSerial = 0;
	/**
	 * DOM fields (Surface) observed with the value they describe: the
	 * mark-edge side a display or a DOM derive observed it with, and whether
	 * a DOM derive read it from a node-bound native range.
	 */
	#surface: { value: SelectionValue; edge?: EdgeSide; nodeBound?: boolean } | null = null;

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
	 * The text segment and the offset in it that a projection point shows
	 * (`block.textAtOffset`, the one offset → segment mapper).
	 * @internal
	 */
	textAt = (point: SelectionPoint | null | undefined): SelectionInsertionTarget | null =>
		(point && this.edytor.idToBlock.get(point.block)?.textAtOffset(point.offset)) || null;

	/**
	 * A projection's endpoints in text segments (`textAt`) and the texts it
	 * covers (an atom's: the texts on its two sides): what the text-handle
	 * operations take.
	 * @internal
	 */
	textRange = (projection = this.projection): TextRange => {
		const start = this.textAt(projection.start);
		const end = this.textAt(projection.end);
		const handles = this.edytor.idToBlock;
		const texts =
			projection.kind === 'atom'
				? [start, end].flatMap((at) => (at ? [at.text] : []))
				: projection.segments.flatMap((part) =>
						part.kind === 'text' && handles.has(part.block)
							? [handles.text(part.block, part.segOrd)]
							: []
					);
		return {
			startText: start?.text ?? null,
			yStart: start?.offset ?? 0,
			endText: end?.text ?? null,
			yEnd: end?.offset ?? 0,
			texts
		};
	};

	/** @internal The mark-edge side the DOM showed the current caret with (`marksForInsertion`). */
	get edge(): EdgeSide | undefined {
		return this.#surface?.value === this.value ? this.#surface.edge : undefined;
	}

	/** @internal Focus is in a void block's own `input` or `textarea`. */
	get voidField(): boolean {
		const tag = getActiveElement(this.edytor.node)?.tagName.toUpperCase();
		return this.projection.voidRoot !== null && (tag === 'INPUT' || tag === 'TEXTAREA');
	}

	/**
	 * Replace the selection with `next` (none, a text range of two anchors,
	 * one inline atom, or a set of block ids), keeping the selected and
	 * focused blocks, presence and `onSelectionChange` in step.
	 */
	select = (next: SelectionValue): void => this.commit(next);

	/**
	 * The one commit point: replaces the value, advances the epoch and
	 * applies every side effect once — the selected, atom and focused sets
	 * (hooks and attributes), and, when the value changed, presence and `onSelectionChange`.
	 * `surface` carries the mark-edge side the value was observed with.
	 * @internal
	 */
	commit = (
		next: SelectionValue,
		cause: SelectCause = 'model',
		surface?: { edge?: EdgeSide; nodeBound?: boolean }
	) => {
		next = this.#keepPending(this.#shown(next));
		const changed = !sameValue(this.value, next);
		if (changed) this.#value = next;
		const value = this.value;
		this.epoch++;
		// A repair is a background display (it never takes focus); a command,
		// history or host code asks for one.
		if (cause === 'repair') this.edytor.surface.update();
		else if (cause !== 'dom') this.display();
		if (surface) this.#surface = { value, ...surface };
		const projection = project(value, this.edytor.facade);
		const blocksOf = (ids: readonly string[]) =>
			ids.flatMap((id) => this.edytor.idToBlock.get(id) ?? []);
		const atom =
			value.kind === 'atom' && projection.start
				? this.edytor.idToBlock.atom(value.blockId, value.atomId)
				: undefined;
		this.#sync(this.#selected, value.kind === 'blocks' ? blocksOf(value.ids) : [], 'selected');
		this.#sync(
			this.#focused,
			value.kind === 'text'
				? blocksOf(projection.blocks)
				: value.kind === 'atom'
					? blocksOf([value.blockId])
					: [],
			'focused'
		);
		if (atom !== this.inlineBlockDeletionTarget || (!atom && this.selectedInlineBlock.size)) {
			this.selectedInlineBlock.clear();
			if (atom) this.selectedInlineBlock.add(atom);
			this.inlineBlockDeletionTarget = atom ?? null;
		}
		this.edytor.history?.selected(value);
		const start = this.textAt(projection.start);
		if (start) {
			this.#lastText = start.text;
		}
		if (!changed) return;
		// A dead view never publishes: its entry went with its teardown.
		if (!this.edytor.destroyed) {
			const focus = projection.isReversed ? projection.start : projection.end;
			this.edytor.presence.write(serialize(value, projection), focus?.block ?? null);
		}
		this.edytorOnSelectionChange?.(this);
		this.edytor.plugins.forEach((plugin) => {
			plugin.onSelectionChange?.(this);
		});
	};

	/**
	 * The collapsed text caret in block offsets (`{ block, offset }`, an
	 * inline atom counting 1), or `null` when the selection is not a caret
	 * (a range, an atom, blocks, none). Not reactive: read it when you need it.
	 */
	get caret(): Caret | null {
		const { start, isCollapsed, kind } = this.projection;
		if (kind !== 'text' || !isCollapsed || !start) return null;
		const block = this.edytor.idToBlock.get(start.block);
		return block ? { block, offset: start.offset } : null;
	}

	/**
	 * Select a caret at `caret.offset` of `caret.block` (block offsets, an
	 * inline atom counting 1; clamped to the block's content). A block that
	 * shows no text (a divider) keeps the current value. Displayed after the flush.
	 */
	setCaret = (caret: Caret | null | undefined) => {
		const at = caret && caret.block.textAtOffset(Math.max(0, caret.offset));
		if (at) this.selectText(at.text, at.offset);
	};

	/** The marks the next insertion at the caret takes (values kept). */
	get pending(): PendingMarks | undefined {
		return this.value.kind === 'text' ? (this.value.pending as PendingMarks) : undefined;
	}

	/** Stage (or, with `undefined`, clear) the caret's pending marks: a new value, same anchors. */
	stage = (pending: Marks | undefined) => {
		const value = this.value;
		if (value.kind === 'text') this.select(Object.freeze({ ...value, pending }));
	};

	/**
	 * No text endpoint rests in a block that renders no content: its
	 * slot never mounts, so typing there is saved and never shown. Such a
	 * caret moves to the nearest shown line — a container's first item, else
	 * the next line, else the end of the one before (a line just created is
	 * displayed once it mounts). A range's start moves to the block's first
	 * shown line and its end to its last (a list's items, `rangeEdge`);
	 * a void's passes on as a caret does. With none, the value stays as it
	 * was. Every caret write passes here, and so does the repair after a
	 * change this view did not make. A table's row or cell is never a block
	 * of a block selection: it stands for its table (`table.fits`).
	 */
	#shown = (next: SelectionValue): SelectionValue => {
		if (next.kind === 'blocks') {
			const { facade } = this.edytor;
			const ids = next.ids.map((id) =>
				facade.isTableCell(id) || facade.isTableRow(id) ? (facade.tableOf(id) ?? id) : id
			);
			return ids.some((id, i) => id !== next.ids[i]) ? blockSelection([...new Set(ids)]) : next;
		}
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

	/** A caret that did not move keeps its pending marks; a value that names them wins. */
	#keepPending = (next: SelectionValue): SelectionValue => {
		const prev = this.value;
		if (prev.kind !== 'text' || !prev.pending || next.kind !== 'text' || 'pending' in next)
			return next;
		const a = project(prev, this.edytor.facade);
		return a.start && sameEnds(a, project(next, this.edytor.facade))
			? textSelection(next.anchor, next.focus, prev.pending)
			: next;
	};

	/**
	 * Keep `block`'s membership as its own signals (a rendered block's
	 * attachment): `isSelected` and `isFocused` then follow only its changes.
	 * Created outside any reactive read — a signal a reaction creates is not
	 * its dependency — and answered only when there.
	 * @internal
	 */
	keep = (block: Block): Membership | undefined => {
		let member = this.#members.get(block);
		if (member || $effect.tracking()) return member;
		member = new Membership();
		member.selected = this.#selected.has(block);
		member.focused = this.#focused.has(block);
		this.#members.set(block, member);
		return member;
	};

	/** Whether `block` is in the selected set (reactive: follows that block's membership). @internal */
	isSelected = (block: Block): boolean =>
		this.#members.get(block)?.selected ?? this.#selected.has(block);

	/** Whether `block` is in the focused set (reactive: follows that block's membership). @internal */
	isFocused = (block: Block): boolean =>
		this.#members.get(block)?.focused ?? this.#focused.has(block);

	/** Diff one block set against its new members: hooks only for changes (the renderer draws the attributes). */
	#sync = (set: SvelteSet<Block>, blocks: Block[], kind: 'selected' | 'focused') => {
		const next = new Set(blocks);
		for (const block of set) {
			if (next.has(block)) continue;
			set.delete(block);
			const member = this.#members.get(block);
			if (member) member[kind] = false;
			// `onDeselect` pairs with `onSelect`; `onBlur` keeps firing on both
			// (it has historically doubled as the selection-loss hook).
			if (kind === 'selected') block.definition.onDeselect?.({ block });
			block.definition.onBlur?.({ block });
		}
		for (const block of next) {
			if (set.has(block)) continue;
			set.add(block);
			const member = this.#members.get(block);
			if (member) member[kind] = true;
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
	 * Select from `yStart` of `startText` to `yEnd` of `endText` (a caret by
	 * default; endpoints in document order, `isReversed` makes the end the
	 * anchor; offsets clamped to each text). The anchors are minted now from
	 * each text's block record, live or not — the atoms of a text that died
	 * to a merge live on in the block that claimed them, so resolution follows
	 * them — else the selection lands at the seam of the start's block. The
	 * projector displays it after the flush.
	 * @internal
	 */
	selectText = (
		startText: Text | null | undefined,
		yStart: number,
		endText: Text | null = startText ?? null,
		yEnd = yStart,
		isReversed = false
	) => {
		if (!startText || !endText) return;
		const at = (text: Text, offset: number) => Math.min(Math.max(offset, 0), text.length);
		const value = this.textValue(
			startText,
			at(startText, yStart),
			endText,
			at(endText, yEnd),
			isReversed,
			undefined,
			(text, offset, side) =>
				text.parent.isRoot
					? null
					: this.edytor.facade.anchorAt(text.blockId, text.segStart + offset, side)
		);
		const target = project(value, this.edytor.facade).start
			? value
			: this.#seamValue(startText.parent?.id ?? null);
		if (target) this.select(target);
	};

	/**
	 * Select `block`'s lines (Mod+A, a triple click): from its first shown
	 * line's start to its last's end (a list's items, a code block's lines),
	 * the start bound left so text typed before it stays inside. A block that
	 * shows no line keeps the current value.
	 * @internal
	 */
	selectLines = (block: Block | null | undefined) => {
		const [first, last] = block ? [shownText(block, 'first'), shownText(block, 'last')] : [];
		if (first && last) this.select(this.textValue(first, 0, last, last.length, false, 'left'));
	};

	/** @internal Ask the projector to display the current value after the flush. */
	display = () => {
		this.scrollOnDisplay =
			this.edytor.isHandlingUserInput && this.edytor.suppressCaretScrollDepth === 0;
		this.requestSerial = this.edytor.intentSerial;
		this.request++;
	};

	/** @internal The mark-edge side a display showed the current value with. */
	observed = (surface: { edge?: EdgeSide }) => {
		this.#surface = { value: this.value, nodeBound: this.hasNativeNodeSelection(), ...surface };
	};

	/**
	 * A pointer drag is in progress (a press in the host, until its release):
	 * the projector does not display under it, and the overlay chrome
	 * (block handles, column resize bands) takes no pointer, so the native
	 * selection is computed against the host. Reactive.
	 */
	get dragging() {
		return this.pointer.dragging;
	}

	/** @internal */
	destroy = () => {
		this.#document?.removeEventListener('selectionchange', this.onSelectionChange);
		this.#document = null;
	};

	/**
	 * Leave an atom selection: a caret at the atom's start (the end of the
	 * text before it), else none. `selectedInlineBlock` and
	 * `inlineBlockDeletionTarget` follow the value (`commit`).
	 */
	clearInlineBlockSelection = () => {
		const value = this.value;
		if (value.kind !== 'atom') return;
		const { start } = this.projection;
		const before = start && this.textAt(start);
		this.select(before ? this.textValue(before.text, before.offset) : noSelection);
	};
	selectInlineBlock = (inlineBlock: InlineBlock, from: AtomSide = 'before') => {
		this.select(atomSelection(inlineBlock.parent.id, inlineBlock.id, from));
	};
	/** @internal */
	getTextOfNode = getTextOfNode.bind(this);

	/** @internal The block whose element holds `node`, in this editor. */
	getBlockOfNode = (node: Node | null) => {
		const element = getElementFromNode(node)?.closest<HTMLElement>('[data-edytor-block]');
		const id = element && this.edytor.node?.contains(element) && element.dataset.edytorId;
		return (id && this.edytor.idToBlock.get(id)) || null;
	};

	/** @internal */
	init = () => {
		if (typeof document === 'undefined') return;
		this.#document = this.edytor.node?.ownerDocument ?? document;
		this.#document.addEventListener('selectionchange', this.onSelectionChange);
	};

	/**
	 * The block selection value over which the DOM caret was put — a primary
	 * pointer press in the editor, or a foreign `selectionchange` (a script's,
	 * no gesture) showing a collapsed caret in it (the block selection itself
	 * ignores both): a
	 * collapsed DOM caret a paste finds over it is the user's only then
	 * (`onPaste`), never the one a browser makes up at the editable's start
	 * when the block selection shows no DOM range (for the paste's own keys).
	 * @internal
	 */
	placedOver: SelectionValue | null = null;

	/**
	 * One classifier (the projector): an echo or a DOM state older than a
	 * display still to land is ignored, and so is a move while a composition
	 * session is live (the IME's; the session's end displays); drift is
	 * displayed again; a foreign write or intent is adopted.
	 * @internal
	 */
	onSelectionChange = () => {
		const selection = getDomSelectionSnapshot(this.edytor.node);
		const observation = this.edytor.projector.classify(selection);
		if (observation === 'echo' || observation === 'composition') return;
		if (observation === 'drift') return this.display();
		// A script's caret counts; one a key leaves (a browser's caret for a key
		// over a block selection, which shows no DOM range) does not.
		if (
			observation === 'foreign' &&
			this.selectedBlocks.size &&
			selection?.rangeCount &&
			selection.isCollapsed
		)
			this.placedOver = this.value;
		this.applySelectionSnapshot(selection);
	};

	/** @internal */
	applySelectionSnapshot = (
		selection: DomSelectionSnapshot | null,
		options: { restoreNormalizedDomRange?: boolean } = {}
	) => {
		if (this.dragging && this.pointer.dragAcross(selection)) return;
		// A block selection ignores the DOM, but the one a drag across columns made while it lasts.
		if (this.selectedBlocks.size > 0 && !(this.dragging && this.pointer.across)) return;

		// A selection in a kind's own control (a form control, a nested
		// editable island) or a focused one belongs to it, not the model —
		// deriving it would map the caret into the control's host text and
		// corrupt the next model-routed write. Both endpoints are checked: a
		// range anchored in host text but focused inside an island must not
		// resolve either.
		const container = this.edytor.node;
		const read = this.#read(selection);
		if (!selection || !read || isKindControl(container, getActiveElement(container))) return;

		const { anchorNode, focusNode, isCollapsed } = selection;
		// A native vertical move that landed on no caret stop takes the key's line stop.
		if (
			isCollapsed &&
			!isTextBoundSelectionPoint(anchorNode) &&
			!getInlineBlockOfNode(this.edytor, anchorNode) &&
			landed(this.edytor)
		)
			return;
		const { isReversed, startNode, start, endNode, end } = read;

		const atom = getInlineBlockInSelectedRange(
			this.edytor,
			selection.rangeCount ? selection.getRangeAt(0) : undefined
		);
		const startText = atom ? null : this.getTextOfNode(startNode, start);
		let endText = startText && this.getTextOfNode(endNode, end);

		if (!startText) {
			const inlineBlock = atom ?? getInlineBlockOfNode(this.edytor, startNode);
			// A press in a non-native editable island (contenteditable=false, no control).
			const island = getElementFromNode(startNode)?.closest('[contenteditable="false"]');
			const islandBlock =
				island && !isNativeInteractiveControl(island) && this.getBlockOfNode(island);
			if (islandBlock && islandBlock.firstText) return this.selectText(islandBlock.firstText, 0);
			// A point on a white space node: the model caret is displayed again.
			if (!inlineBlock && this.textAt(this.projection.start)) return this.display();
			clearDomSelection(this.edytor.node);
			if (inlineBlock) this.selectInlineBlock(inlineBlock);
			else this.clearInlineBlockSelection();
			return;
		}

		const overlay = isCollapsed ? overlayAt(startNode, start) : null;
		if (overlay) {
			const text = this.getBlockOfNode(overlay)?.lastText ?? startText;
			return this.selectText(text, text.length);
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
		// An empty native range reads as a caret; the DOM is normalized to one.
		let restore =
			yStart !== rawYStart ||
			yEnd !== rawYEnd ||
			(!isCollapsed && startText === endText && yStart === yEnd);

		if (
			!isCollapsed &&
			endText &&
			startText.parent !== endText.parent &&
			endText === endText.parent.firstText &&
			yEnd === 0
		) {
			// The shown block before: a closed toggle's header, not its hidden body.
			const previous = visibility.shown(endText.parent, 'blockBefore')?.lastText ?? null;
			if (previous?.node?.isConnected) {
				endText = previous;
				yEnd = previous.length;
				restore = true;
			}
		}

		if (startText.parent.isEmpty && yStart > startText.length) {
			// A caret after a placeholder or suggestion that is not absolutely positioned: its text's end.
			return this.selectText(startText, startText.length);
		}

		const between = atomBetween(startText, endText, yStart, yEnd);
		if (between) {
			clearDomSelection(this.edytor.node);
			this.selectInlineBlock(between, isReversed ? 'after' : 'before');
			return;
		}

		const value = this.textValue(startText, yStart, endText ?? startText, yEnd, isReversed);
		// A node-bound native range (endpoints outside text elements: a block
		// node selection, a stray boundary node) is the shape engines extend
		// their own way. They normalize it into text points asynchronously,
		// so a keydown may find the DOM no longer node-bound: the same value
		// derived again keeps the fact, any other derive clears it.
		const nodeBound =
			!isTextBoundSelectionPoint(anchorNode) ||
			!isTextBoundSelectionPoint(focusNode) ||
			(this.hasNativeNodeSelection() && sameValue(this.value, value));
		this.commit(value, 'dom', {
			edge: isCollapsed ? getMarkEdgeSide(startText, startNode, yStart) : undefined,
			nodeBound
		});
		this.edytor.projector.observe();
		if (restore && options.restoreNormalizedDomRange !== false && endText) {
			// Writing the DOM under a pointer drag would reset its anchor: after it.
			if (this.dragging) this.pointer.hold();
			else this.selectText(startText, yStart, endText, yEnd, isReversed);
		}
	};

	/**
	 * Whether the live model selection was derived from a node-bound
	 * native range — the shape whose Shift+Arrow extension is
	 * engine-defined and therefore intercepted by the hotkey layer.
	 * @internal
	 */
	hasNativeNodeSelection = () =>
		this.#surface?.value === this.value && this.#surface.nodeBound === true;

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
		const resolved = this.edytor.facade?.resolveAnchor(anchor);
		return resolved ? this.textAt({ block: resolved.blockId, offset: resolved.offset }) : null;
	};

	/** The text the selection's start last resolved to (its block is the seam origin once it dies). */
	#lastText: Text | null = null;

	/**
	 * Displayable (a fact of the rendering layer): the block's own content is mounted
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
	 * (a command that declared its result selection authors its own), through
	 * `select()`. Text endpoints follow their anchors by projection; what is
	 * repaired is a range whose content died (a caret at that point) and a
	 * value that no longer resolves: a block set keeps its live
	 * members, an atom that vanished leaves a caret at its block's start, and
	 * otherwise the selection lands at the seam of the block it last resolved in
	 * (`doc/anchors`: the replicated slot, displayable stops only). The model is
	 * written at once; the projector displays it (also when the text the caret
	 * was displayed in died while its anchor moved on).
	 * @internal
	 */
	restoreDeadSelectionEndpoints = () => {
		if (this.expectHistoryRestore) {
			return;
		}
		// Mid pointer-drag the user's in-progress range owns the selection; a
		// command that declared its result selection owns this view's endpoints.
		if (this.dragging || this.edytor.dispatcher.authoring) {
			return;
		}
		const { value } = this;
		const facade = this.edytor.facade;
		const { start, isCollapsed } = this.projection;
		const at = this.textAt(start);
		let dead: string | null;
		if (value.kind === 'blocks') {
			const live = value.ids.filter((id) => facade.isVisibleBlock(id));
			if (live.length === value.ids.length) return;
			if (live.length) {
				this.commit(blockSelection(live), 'repair');
				return;
			}
			dead = value.ids[0] ?? null;
		} else if (value.kind === 'atom') {
			if (at) return;
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
			if (at && start && isCollapsed && value.anchor !== value.focus) {
				// A range whose content died is a caret at the seam (`sel.seam.covered-atom`):
				// its two anchors would re-open around text re-inserted there.
				const caret = facade.anchorAt(start.block, start.offset, 'left');
				if (caret) {
					this.#land(textSelection(caret));
					return;
				}
			}
			if (at) {
				// The text it was displayed in died while its anchor moved on: display again.
				if (this.#lastText !== null && !this.#lastText.isInDocument) this.display();
				this.#lastText = at.text;
				return;
			}
			dead = this.#lastText?.blockId ?? null;
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
	#land = (target: SelectionValue) => this.commit(target, 'repair');

	/**
	 * Anchors from a DOM selection, without selecting them: the projector mints
	 * an unobserved native move before a transaction it did not issue.
	 * @internal
	 */
	mint = (snapshot: DomSelectionSnapshot): SelectionValue | null => {
		const read = this.#read(snapshot);
		if (!read) return null;
		const { isReversed, startNode, start, endNode, end } = read;
		const startText = this.getTextOfNode(startNode, start);
		const endText = startText && this.getTextOfNode(endNode, end);
		if (!startText || !endText) return null;
		const from = offsetIn(startText, startNode, start);
		return this.textValue(startText, from, endText, offsetIn(endText, endNode, end), isReversed);
	};

	/**
	 * A DOM selection whose two endpoints are this editor's own points (not
	 * in a kind's control): its endpoints in document order and its direction.
	 */
	#read = (dom: DomSelectionSnapshot | null) => {
		const container = this.edytor.node;
		if (!dom || !isOwnPoint(container, dom.anchorNode) || !isOwnPoint(container, dom.focusNode))
			return null;
		const isReversed = isBackward(dom);
		return { isReversed, ...ordered(dom, isReversed) };
	};
}
