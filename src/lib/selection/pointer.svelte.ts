/**
 * The selection under a pointer (`selection.pointer`): a press and its drag
 * (`dragStart`, the drag's release, a normalization it held back), a press
 * on a block's non-editable chrome, a triple click, a drag across columns
 * (`acrossColumns`), a drag over inline atoms and `selectstart` on chrome.
 * It writes the selection only through the selection's own writers; the
 * selection's DOM adoption reads `dragging` and `across` and asks `hold()`.
 */
import type { Text } from '../text/text.svelte.js';
import type { Block } from '../block/block.svelte.js';
import { blockSelection } from '$lib/session/selection.js';
import { toTrailingParagraph } from '$lib/session/navigation.js';
import {
	isNativeInteractiveControl,
	isNativeInteractiveEvent,
	ownsPress
} from '$lib/events/nativeInteractiveControl.js';
import { acrossColumns } from './replaceSelection.js';
import {
	caretAtPoint,
	getDomSelectionSnapshot,
	type DomSelectionSnapshot
} from './domSelection.js';
import { domPointOf } from '$lib/surface/projector.svelte.js';
import {
	editableBoundary,
	isTextBoundSelectionPoint,
	offsetIn,
	SUGGESTION
} from './selection.utils.js';
import type { EdytorSelection } from './selection.svelte.js';

/** A text point under the pointer, with where the pointer was. */
export type PointerTextPoint = {
	text: Text;
	offset: number;
	clientX: number;
	clientY: number;
};

/** Where a press was, and its modifiers: what a margin click reads at its release. */
export type MarginPoint = Pick<
	MouseEvent,
	'clientX' | 'clientY' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'
>;

/** A gesture a press in the host's own area starts: answers whether it takes the press. */
export type MarginClaim = (event: MouseEvent) => boolean;

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

	/**
	 * The block whose non-editable chrome `node` is in: its nearest
	 * `contenteditable` boundary is `false`. A nested editable between them
	 * (a void block's caption) is no chrome: the browser places the caret
	 * at the press, in one step (`sel.press.nested-editable`).
	 */
	#chromeBlock = (node: Node | null) => {
		const boundary = editableBoundary(node, this.selection.edytor.node);
		if (!boundary || boundary.editable) return null;
		const nonEditableElement = boundary.element;
		// A suggestion's preview is no block's chrome: a press there is its own (cancelled).
		if (isNativeInteractiveControl(nonEditableElement) || nonEditableElement.closest(SUGGESTION)) {
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
		if (!this.#below(event.clientY)) return false;
		// The model answers this press, as a chrome press: no native caret placement.
		event.preventDefault();
		this.#trailing();
		return true;
	};

	/** Whether `y` lies below the host's last top-level block (`nav.trailing.press`'s place). */
	#below = (y: number) => {
		const last = this.selection.edytor.root?.children.at(-1)?.node;
		const bottom = last?.getBoundingClientRect().bottom;
		return bottom !== undefined && y > bottom;
	};

	#trailing = () => {
		const { edytor } = this.selection;
		edytor.expectInternalFocus();
		edytor.node?.focus({ preventScroll: true });
		toTrailingParagraph(edytor);
	};

	/** The gesture a press in the host's own area starts (`claimMargins`): the marquee's. */
	#margin: MarginClaim | null = null;

	/**
	 * The host's last press went to a gesture of the model's (the margin
	 * gesture's, `marginPress`; a void block's selection, `chromePress`),
	 * until its release: its compatibility `mousedown` is cancelled (no
	 * native caret, focus or selection), and it places no caret (`pressed`)
	 * and starts no text drag (`capture`).
	 * @internal
	 */
	claimed = false;

	/**
	 * Register the gesture a press in the host's own area starts (one per
	 * view: the marquee plugin's, `sel.marquee`). Answers the release.
	 * @internal
	 */
	claimMargins = (claim: MarginClaim) => {
		this.#margin = claim;
		return () => {
			if (this.#margin === claim) this.#margin = null;
		};
	};

	/**
	 * A primary press from a mouse or a pen on the host's own area (its
	 * padding beside and below the blocks: never a block, its text or its
	 * chrome) while a margin gesture is registered (`sel.marquee`): offered
	 * to it before the trailing paragraph's press (`belowPress`), whose click
	 * the gesture gives back (`marginClick`). Classified with the chrome
	 * press in `events/onFocus.ts`. Answers whether the gesture took it.
	 * @internal
	 */
	marginPress = (event: MouseEvent): boolean => {
		this.claimed = false;
		const claim = this.#margin;
		const host = this.selection.edytor.node;
		if (!claim || !host || event.target !== host || event.button !== 0) return false;
		if ((event as PointerEvent).pointerType === 'touch' || !claim(event)) return false;
		this.claimed = true;
		// WebKit's lone `mousedown` is the press itself (`isLonePress`).
		if (event.type === 'mousedown') event.preventDefault();
		return true;
	};

	/**
	 * The compatibility `mousedown` of the press the margin gesture took:
	 * cancelled, so the browser places no caret, moves no focus and starts no
	 * native selection (the `mousedown`'s default actions; the `pointerdown` is
	 * left alone).
	 * @internal
	 */
	marginMouse = (event: MouseEvent) => {
		if (this.claimed && event.button === 0) event.preventDefault();
	};

	/**
	 * A margin press released where it began (a click, no drag): what the
	 * press does when no gesture takes it. Below the last block, the trailing
	 * paragraph (`nav.trailing.press`: no modifier, a view that writes);
	 * beside the blocks, the caret at the text point of that height nearest
	 * the host's edge, where the browser puts it. A click with a modifier
	 * keeps the selection.
	 * @internal
	 */
	marginClick = (at: MarginPoint) => {
		const { edytor } = this.selection;
		const host = edytor.node;
		if (!host || at.shiftKey || at.altKey || at.metaKey || at.ctrlKey) return;
		if (this.#below(at.clientY)) {
			if (edytor.dispatcher.permits()) this.#trailing();
			return;
		}
		const box = host.getBoundingClientRect();
		const x = Math.min(Math.max(at.clientX, box.left + 1), box.right - 1);
		const point = this.#pointAt(x, at.clientY);
		if (!point) return;
		edytor.expectInternalFocus();
		host.focus({ preventScroll: true });
		this.selection.selectText(point.text, point.offset);
	};

	/**
	 * A press on a block's non-editable chrome. A void block's
	 * (`sel.press.void`, Notion): the block is selected, the host focused,
	 * no caret placed — unless the press is a control's of its own
	 * (`ownsPress`: a native control, an interactive role, an element the
	 * app marks `data-edytor-control`), which keeps it whole; Shift or Mod
	 * adds the block to a block selection. On the line of the block's text
	 * (a caption's, beside its text), the caret at the nearest point of it.
	 * Any other block's: the caret at the start of its text. A press a
	 * control owns (`ownPress`) never reaches it.
	 * @internal
	 */
	chromePress = (event: MouseEvent) => {
		const targetNode = event.target instanceof Node ? event.target : null;
		const targetBlock = this.#chromeBlock(targetNode);
		if (targetBlock && this.selection.edytor.facade.isVoid(targetBlock.id))
			return this.#voidPress(event, targetBlock);
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
		this.selection.selectText(targetText, 0);
	};

	/**
	 * A press (and its whole gesture: its clicks, multi-clicks, `selectstart`
	 * and drag) a control of a block's chrome owns (`ownsPress`,
	 * `sel.press.void`): the editor does nothing with it. Every press handler
	 * asks this one rule first.
	 * @internal
	 */
	ownPress = (event: Event) => ownsPress(this.selection.edytor.node, event);

	/** A press on void block `block`'s chrome selects it (`sel.press.void`). */
	#voidPress = (event: MouseEvent, block: Block) => {
		const { edytor, value } = this.selection;
		if (event.button !== 0) return;
		// The model answers it: no native caret, focus or selection; no text drag (`claimed`).
		event.preventDefault();
		this.claimed = true;
		edytor.expectInternalFocus();
		edytor.node?.focus({ preventScroll: true });
		// On the line of its text (a caption's, beside the text): the caret at the nearest point there.
		const target =
			event.target instanceof Element && event.target !== block.node ? event.target : null;
		const line = target?.querySelector<HTMLElement>('[data-edytor-text]');
		const text = line && this.selection.getTextOfNode(line);
		const box = line?.getBoundingClientRect();
		if (
			text &&
			text.parent === block &&
			box &&
			event.clientY >= box.top &&
			event.clientY <= box.bottom
		)
			return this.placeAt(text, event.clientX, event.clientY);
		const adding = (event.shiftKey || event.metaKey || event.ctrlKey) && value.kind === 'blocks';
		this.selection.select(
			blockSelection(adding ? [...new Set([...value.ids, block.id])] : [block.id])
		);
	};

	/**
	 * A triple click selects the block's content in the model; the browser's
	 * own multi-click selection is cancelled at its `mousedown`
	 * (`preventTripleClick`), so no native selection competes with the display.
	 * @internal
	 */
	tripleClick = (e: MouseEvent) => {
		if (e.detail < 3 || this.ownPress(e)) return;
		const targetNode = e.target instanceof Node ? e.target : null;
		const clickedBlock = this.selection.getBlockOfNode(targetNode);
		if (clickedBlock?.definition.void && !isTextBoundSelectionPoint(targetNode)) {
			e.preventDefault();
			this.selection.select(blockSelection([clickedBlock.id]));
			return;
		}
		const { selection } = this;
		selection.selectLines(
			targetNode
				? (selection.getTextOfNode(targetNode)?.parent ?? selection.getBlockOfNode(targetNode))
				: selection.textAt(selection.projection.start)?.text.parent
		);
	};

	/** @internal */
	preventTripleClick = (e: MouseEvent) => {
		if (e.detail >= 3 && !this.ownPress(e)) e.preventDefault();
	};

	/** The text point under the pointer, if any. */
	#pointAt = (clientX: number, clientY: number) => {
		const at = caretAtPoint(
			this.selection.edytor.node?.ownerDocument ?? document,
			clientX,
			clientY
		);
		const text = at && this.selection.getTextOfNode(at.node, at.offset);
		return text ? { text, offset: offsetIn(text, at.node, at.offset), clientX, clientY } : null;
	};

	#offsetAt = (text: Text, clientX: number, clientY: number) => {
		const ownerDocument = text.node?.ownerDocument;
		if (!text.node || !ownerDocument) {
			return 0;
		}

		const caretPoint = this.#pointAt(clientX, clientY);
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
		this.selection.selectText(text, this.#offsetAt(text, clientX, clientY));
	};

	/** @internal */
	capture = (event: MouseEvent) => {
		if (event.button !== 0) {
			this.dragStart = null;
			return;
		}

		this.dragStart = this.#pointAt(event.clientX, event.clientY);
		this.#across = false;
		this.#extending = event.shiftKey;
	};

	/** @internal */
	release = () => {
		this.claimed = false;
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

		const point = this.#pointAt(event.clientX, event.clientY);
		if (!point) {
			return;
		}

		this.selection.selectText(point.text, point.offset);
	};

	/** @internal */
	restoreAtomRange = (event: PointerEvent) => {
		const dragStart = this.dragStart;
		this.dragStart = null;
		this.#dropped();

		if (!dragStart || event.button !== 0) {
			return;
		}

		const dragEnd = this.#pointAt(event.clientX, event.clientY);
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

		// Two texts of one block hold an inline atom between them (a block's
		// content alternates texts and atoms): the range is the drag's.
		window.setTimeout(() => {
			const content = dragStart.text.parent.content;
			const [from, to] = [content.indexOf(dragStart.text), content.indexOf(dragEnd.text)];
			if (dragStart.text.parent !== dragEnd.text.parent || from < 0 || to < 0 || from === to)
				return;
			const [start, end] = from < to ? [dragStart, dragEnd] : [dragEnd, dragStart];
			this.selection.selectText(start.text, start.offset, end.text, end.offset, from > to);
		});
	};

	/**
	 * `selectstart` is the only event fired before a drag-selection begins.
	 * A drag starting on `contenteditable=false` chrome (void/island
	 * chrome, inline atoms, placeholders, block handles, the render
	 * anchor) would anchor the DOM selection on nodes the model cannot
	 * represent — block-level selection owns that surface instead.
	 *
	 * The nearest `[contenteditable]` boundary decides (`editableBoundary`,
	 * the chrome press's rule too): `false` means non-editable chrome, while
	 * a nested editable (void-block captions re-enable editing on their text
	 * spans) keeps native selection. The root itself is excluded so readonly
	 * mode stays selectable.
	 * @internal
	 */
	onSelectStart = (event: Event) => {
		// Native controls (todo checkboxes, plugin inputs…) keep their own
		// selection behavior.
		if (isNativeInteractiveEvent(event) || this.ownPress(event)) return;
		const target = event.target instanceof Node ? event.target : null;
		if (editableBoundary(target, this.selection.edytor.node)?.editable === false)
			event.preventDefault();
	};
}
