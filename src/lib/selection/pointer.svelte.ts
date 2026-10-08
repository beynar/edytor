/**
 * The selection under a pointer (`selection.pointer`): a press and its drag
 * (`dragStart`, the drag's release, a normalization it held back), a press
 * on a block's non-editable chrome, a triple click, a drag across columns
 * (`acrossColumns`), a drag over inline atoms and `selectstart` on chrome.
 * It writes the selection only through the selection's own setters; the
 * selection's DOM adoption reads `dragging` and `across` and asks `hold()`.
 */
import { InlineBlock } from '../block/inlineBlock.svelte.js';
import type { Text } from '../text/text.svelte.js';
import { blockSelection } from '$lib/session/selection.js';
import { toTrailingParagraph } from '$lib/session/navigation.js';
import { isNativeInteractiveEvent } from '$lib/events/nativeInteractiveControl.js';
import { acrossColumns } from './replaceSelection.js';
import { getDomSelectionSnapshot, type DomSelectionSnapshot } from './domSelection.js';
import { domPointOf } from '$lib/surface/projector.svelte.js';
import { getElementFromNode, getYIndex, SUGGESTION } from './selection.utils.js';
import type { EdytorSelection } from './selection.svelte.js';

/** A text point under the pointer, with where the pointer was. */
export type PointerTextPoint = {
	text: Text;
	offset: number;
	clientX: number;
	clientY: number;
};

type DocumentWithCaretPoint = Document & {
	caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
	caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

export class SelectionPointer {
	/** The press's text point while a primary press (a drag) lasts; `null` after its release. */
	dragStart = $state.raw<PointerTextPoint | null>(null);

	constructor(private readonly selection: EdytorSelection) {}

	/** A primary press is down: the projector does not display under it. */
	get dragging() {
		return this.dragStart !== null;
	}

	/** The drag selects blocks across columns (`acrossColumns`), until its release. */
	get across() {
		return this.#across;
	}

	/** A normalization the drag holds back until its release. */
	hold = () => {
		this.#held = true;
	};

	private insideText = (node: Node | null) => {
		const element = getElementFromNode(node);
		return Boolean(element?.closest('[data-edytor-text]'));
	};

	private chromeBlock = (node: Node | null) => {
		const element = getElementFromNode(node);
		const nonEditableElement = element?.closest('[contenteditable="false"]');
		if (
			!(nonEditableElement instanceof HTMLElement) ||
			!this.selection.edytor.node?.contains(nonEditableElement)
		) {
			return null;
		}
		// A suggestion's preview is no block's chrome: a press there is its own (cancelled).
		if (nonEditableElement.closest(`input, textarea, select, button, a[href], ${SUGGESTION}`)) {
			return null;
		}
		const block = this.selection.getBlockOfNode(nonEditableElement);
		if (nonEditableElement.closest('[data-edytor-text], [data-edytor-inline-block]') || !block) {
			return null;
		}

		return block;
	};

	/**
	 * A press in the host's own area below its last block (its bottom
	 * padding, its height past the content; `nav.trailing.press`, Notion):
	 * the caret goes to the trailing paragraph (`toTrailingParagraph`, a new
	 * one when the last block is not an empty one). A primary press without
	 * a modifier, from a mouse or a pen (a touch there may start a scroll:
	 * the browser's); a view that writes nothing keeps the browser's caret.
	 * Answers whether it took the press.
	 * @internal
	 */
	belowPress = (event: MouseEvent): boolean => {
		const { edytor } = this.selection;
		const host = edytor.node;
		if (!host || event.target !== host || event.button !== 0) return false;
		if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
		if ((event as PointerEvent).pointerType === 'touch' || !edytor.dispatcher.permits())
			return false;
		const bottom = edytor.root?.children.at(-1)?.node?.getBoundingClientRect().bottom;
		if (bottom === undefined || event.clientY <= bottom) return false;
		// The model answers this press, as a chrome press: no native caret placement.
		event.preventDefault();
		edytor.expectInternalFocus();
		host.focus({ preventScroll: true });
		toTrailingParagraph(edytor);
		return true;
	};

	/** @internal */
	chromePress = (event: MouseEvent) => {
		const targetNode = event.target instanceof Node ? event.target : null;
		const targetBlock = this.chromeBlock(targetNode);
		const targetText = targetBlock?.firstText;
		// A native control inside the chrome (a void block's input) owns its press.
		if (!targetText || isNativeInteractiveEvent(event)) {
			return;
		}

		// The model answers this press: the browser's own caret placement on
		// the chrome is cancelled (a canceled pointerdown moves no selection).
		event.preventDefault();
		this.selection.edytor.expectInternalFocus();
		this.selection.edytor.node?.focus({ preventScroll: true });
		this.selection.setAtTextOffset(targetText, 0);
	};

	/**
	 * A triple click selects the block's content in the model; the browser's
	 * own multi-click selection is cancelled at its `mousedown`
	 * (`preventTripleClick`), so no native selection competes with the display.
	 * @internal
	 */
	tripleClick = (e: MouseEvent) => {
		if (e.detail < 3) return;
		const targetNode = e.target instanceof Node ? e.target : null;
		const clickedBlock = this.selection.getBlockOfNode(targetNode);
		if (clickedBlock?.definition.void && !this.insideText(targetNode)) {
			e.preventDefault();
			this.selection.selectBlocks(clickedBlock);
			return;
		}

		const targetBlock =
			targetNode instanceof Node
				? (this.selection.getTextOfNode(targetNode)?.parent ??
					this.selection.getBlockOfNode(targetNode))
				: this.selection.state.startText?.parent;
		if (targetBlock) {
			this.selection.preserveBlockRange(targetBlock);
		}
	};

	/** @internal */
	preventTripleClick = (e: MouseEvent) => {
		if (e.detail >= 3) e.preventDefault();
	};

	/** The text point under the pointer, if any. */
	pointAt = (clientX: number, clientY: number) => {
		const ownerDocument = (this.selection.edytor.node?.ownerDocument ??
			document) as DocumentWithCaretPoint;
		const caretPosition = ownerDocument.caretPositionFromPoint?.(clientX, clientY);
		const caretRange = caretPosition ? null : ownerDocument.caretRangeFromPoint?.(clientX, clientY);
		const node = caretPosition?.offsetNode ?? caretRange?.startContainer ?? null;
		const domOffset = caretPosition?.offset ?? caretRange?.startOffset ?? null;
		const text = this.selection.getTextOfNode(node, domOffset ?? undefined);

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

	offsetAt = (text: Text, clientX: number, clientY: number) => {
		const ownerDocument = text.node?.ownerDocument;
		if (!text.node || !ownerDocument) {
			return 0;
		}

		const caretPoint = this.pointAt(clientX, clientY);
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

	/** @internal */
	placeAt = (text: Text, clientX: number, clientY: number) => {
		this.selection.setAtTextOffset(text, this.offsetAt(text, clientX, clientY));
	};

	/** @internal */
	capture = (event: MouseEvent) => {
		if (event.button !== 0) {
			this.dragStart = null;
			return;
		}

		this.dragStart = this.pointAt(event.clientX, event.clientY);
		this.#across = false;
		this.#extending = event.shiftKey;
	};

	/** @internal */
	release = () => {
		this.dragStart = null;
		this.#dropped();
	};

	/** A normalization a pointer drag held back (the gesture is the user's). */
	#held = false;

	/** The pointer drag selected blocks across columns (`acrossColumns`), until its release. */
	#across = false;

	/** The press held Shift: it extends the range it found (a Shift+click). */
	#extending = false;

	/**
	 * The drag ended: the DOM selection it left is derived again, now
	 * normalized. A drag that ends as a block selection across columns keeps
	 * it: the native range it ignored goes (the projector shows a block
	 * selection as no range).
	 */
	#dropped = () => {
		// A Shift+press's range can reach the adopter only after its release
		// (Chromium queues its `selectionchange`): read here, as the press's.
		if (this.#extending && !this.#across)
			this.dragAcross(getDomSelectionSnapshot(this.selection.edytor.node));
		this.#extending = false;
		const across = this.#across;
		this.#across = false;
		if (across && this.selection.value.kind === 'blocks') {
			this.#held = false;
			return this.selection.display();
		}
		if (!this.#held) return;
		this.#held = false;
		this.selection.applySelectionSnapshot(getDomSelectionSnapshot(this.selection.edytor.node));
	};

	/**
	 * Under a pointer press (a drag, or a Shift+click extending the range it
	 * found), a native range with one end in a column and the other outside
	 * that column (another column, or outside the layout) is a block
	 * selection (`acrossColumns`, Notion): the blocks it covers are selected
	 * and the native range is ignored — the browser keeps extending it, so
	 * the drag coming back into the anchor's columns is a text range again.
	 * Its highlight is hidden while the value is a block selection
	 * (`data-edytor-selection`). The keyboard's ranges stay text ranges in
	 * document order. Answers whether it selected blocks.
	 */
	/** @internal */
	dragAcross = (dom: DomSelectionSnapshot | null) => {
		if (!dom?.anchorNode || !dom.focusNode || dom.isCollapsed) return false;
		const anchor = this.selection.getTextOfNode(dom.anchorNode as Node, dom.anchorOffset)?.parent;
		const focus = this.selection.getTextOfNode(dom.focusNode as Node, dom.focusOffset)?.parent;
		if (!anchor) return false;
		const blocks = focus && !anchor.isRoot && !focus.isRoot && acrossColumns(anchor, focus);
		if (!blocks || !blocks.length) return false;
		this.#across = true;
		this.selection.commit(blockSelection(blocks.map((block) => block.id)), 'dom');
		this.selection.edytor.projector.observe();
		return true;
	};

	/** @internal */
	collapseBlocksAt = (event: MouseEvent) => {
		if (event.button !== 0 || this.selection.selectedBlocks.size === 0) {
			return;
		}
		this.selection.placedOver = this.selection.value;

		const point = this.pointAt(event.clientX, event.clientY);
		if (!point) {
			return;
		}

		this.selection.setAtTextOffset(point.text, point.offset);
	};

	/** @internal */
	restoreAtomRange = (event: PointerEvent) => {
		const dragStart = this.dragStart;
		this.dragStart = null;
		this.#dropped();

		if (!dragStart || event.button !== 0) {
			return;
		}

		const dragEnd = this.pointAt(event.clientX, event.clientY);
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
			this.selection.clearInlineBlockSelection();
			this.selection.setAtRange(
				rangeStart.text,
				rangeStart.offset,
				rangeEnd.text,
				rangeEnd.offset,
				{
					isReversed
				}
			);
			this.selection.clearInlineBlockSelection();
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
	 * @internal
	 */
	onSelectStart = (event: Event) => {
		// Native controls (todo checkboxes, plugin inputs…) keep their own
		// selection behavior.
		if (isNativeInteractiveEvent(event)) {
			return;
		}
		const element = getElementFromNode(event.target instanceof Node ? event.target : null);
		if (!element || !this.selection.edytor.node?.contains(element)) {
			return;
		}
		// Walk ancestors to the nearest contenteditable boundary. Both the
		// attribute and the `contentEditable` property are checked — the
		// attach hooks of inline/void blocks set the property, which jsdom
		// does not reflect onto the attribute.
		let boundary: HTMLElement | null = element instanceof HTMLElement ? element : null;
		while (boundary && boundary !== this.selection.edytor.node) {
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
}
