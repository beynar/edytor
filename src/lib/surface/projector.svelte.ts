/**
 * The display projector (R10, O49–O57, §4.4 `surface/projector`): the only
 * writer of the DOM selection. It always writes the CURRENT selection value,
 * after a Svelte flush — from the root component's post-flush `$effect`, which
 * runs after every DOM write of the flush — so an older request can never
 * overwrite a newer one, and a destination that was not mounted is displayed
 * by the root `$effect` of the flush that mounts it.
 *
 * A pass displays when the selection asked for it (a non-DOM `select()`) or
 * when the render epoch moved (a commit this view did not issue, a remount, a
 * cell mounted while a display was pending), deduped on those two epochs, and
 * only when:
 * - no composition session owns a host (BI-2): the session's end re-runs the
 *   pass, which catches up;
 * - no pointer drag is in progress, for a pass the selection did not ask for;
 * - the focus verdict is ours (BI-14): focus inside the editor, or orphaned by
 *   our own render, or nothing focused and the pass was asked for — never a
 *   foreign focus, a last gesture that landed outside, or a DOM selection the
 *   user made outside the editor;
 * - the destination is displayable (mounted).
 * The live DOM selection is compared with the value in model coordinates: an
 * equal selection is not rewritten (D5).
 *
 * Before the first transaction after a settled render that this view did not
 * issue, the projector reads the live DOM selection and mints anchors from an
 * unobserved native move; it admits the move through `select()` once that
 * transaction committed, never inside it (BI-3, LH2-5).
 */
import { untrack } from 'svelte';
import type { Edytor } from '../edytor.svelte.js';
import type { Text } from '../text/text.svelte.js';
import type { YTransaction as Transaction } from '../crdt/index.js';
import {
	clearDomSelection,
	createDomRange,
	getActiveElement,
	getDomSelection,
	getDomSelectionSnapshot,
	scrollCaretIntoView,
	type DomSelectionSnapshot
} from '../selection/domSelection.js';
import { getMarkEdgeSide, getYIndex } from '../selection/selection.utils.js';
import { project, type SelectionValue } from '../session/selection.js';

type Point = [node: Node, offset: number];
type Points = { anchor: Point; focus: Point };

/** The DOM point of a text-segment offset: its text leaf, else the element itself. */
export const domPointOf = (element: HTMLElement, offset: number): Point => {
	const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	let at = 0;
	for (let leaf = walker.nextNode(); leaf; leaf = walker.nextNode()) {
		const end = at + (leaf as CharacterData).length;
		if (offset <= end) return [leaf, offset - at];
		at = end;
	}
	return [element, 0];
};

const samePoint = (a: Point, node: Node | null, offset: number) => a[0] === node && a[1] === offset;

export class Projector {
	/** Render epoch: commits this view did not issue, and cells mounted while a display waits. */
	render = $state(0);
	/** What the last display left in the DOM, and the selection epoch it showed. */
	#displayed: ((Points | { cleared: number }) & { epoch: number; intent: number }) | null = null;
	/** The observer holds DOM records it has not reconciled yet (set at attach). */
	recordsPending: () => boolean = () => false;
	/** The (request, render, remount) key the last completed pass answered. */
	#done = '';
	#request = -1;
	#pending = false;
	/** The focused element inside the editor, noted before the flush's DOM writes. */
	#noted: Element | null = null;
	/** The document version the last flush rendered. */
	#rendered = -1;
	/** Flushes rendered, and the flush at the last observation (a display, or a DOM derive). */
	#flushes = 0;
	#seen = -1;
	#minted: { value: SelectionValue; transaction: Transaction } | null = null;

	constructor(private edytor: Edytor) {}

	/** Root `$effect.pre`: note the focused element before the flush writes the DOM. */
	pre = () => {
		void this.#deps();
		untrack(() => {
			const node = this.edytor.node;
			const active = node && getActiveElement(node);
			this.#noted = active && node.contains(active) ? active : null;
		});
	};

	/** Root post-flush `$effect`: every DOM write of the flush has landed. */
	post = () => {
		const key = this.#deps();
		untrack(() => this.#pass(key));
	};

	#deps = () => {
		const { edytor } = this;
		void edytor.valueRevision;
		void edytor.isComposing;
		return `${edytor.selection.request}:${this.render}:${edytor.editorDomRevision}`;
	};

	#pass = (key: string) => {
		const { edytor } = this;
		this.#rendered = edytor.facade.version;
		this.#flushes++;
		const { selection } = edytor;
		// A value that no longer resolves is repaired on every pass (its seam may
		// have mounted in this flush); otherwise an answered key displays nothing.
		if (key === this.#done && (selection.value.kind === 'none' || selection.projection.start)) {
			// Nothing to display; a DOM that still shows the value is observed.
			const { startText, yStart, endText, yEnd, isReversed } = selection.state;
			const dom = edytor.node && getDomSelection(edytor.node);
			if (
				dom &&
				startText &&
				endText &&
				this.#shows(dom, startText, yStart, endText, yEnd, isReversed)
			)
				this.#seen = this.#flushes;
			return;
		}
		const request = selection.request;
		const requested = request !== this.#request;
		this.#pending = !this.#display(requested);
		if (this.#pending) return;
		this.#done = key;
		this.#request = request;
	};

	/**
	 * A text element (re)mounted: a display that waited for it, a value that
	 * waits for a displayable seam, or the text the selection is displayed in
	 * (its old nodes are gone) gets a pass after this flush.
	 */
	mounted = (text: Text) => {
		const { selection } = this.edytor;
		const { startText, endText } = selection.state;
		const dead = selection.value.kind !== 'none' && !selection.projection.start;
		if (this.#pending || dead || text === startText || text === endText) this.render++;
	};

	/** The observer processed DOM records (O55): a display that waits gets a pass. */
	recordsChanged = () => {
		if (this.#pending) this.render++;
	};

	/**
	 * A `selectionchange` that is not intent because the DOM selection is older
	 * than the value: a requested display has not landed yet (its destination is
	 * not mounted, or the flush has not run) and no intent gesture came after the
	 * request; or the value was displayed, no intent gesture came since, and the
	 * DOM holds foreign damage the observer has not reconciled (its repair
	 * displays the value again).
	 */
	get awaited() {
		const { selection, intentSerial, isComposing } = this.edytor;
		if (isComposing) return false;
		if (selection.request !== this.#request) return selection.requestSerial === intentSerial;
		// Displayed, no intent since, and the DOM diverged from the render (foreign
		// damage the observer has not reconciled): the move is its consequence.
		return this.#displayed?.intent === intentSerial && this.recordsPending();
	}

	/**
	 * The DOM selection is our last display, unchanged since (an echo, not
	 * intent) — or, after a display that cleared it for a block set or an atom,
	 * whatever the engine parked there before the next gesture.
	 */
	isEcho = (selection: DomSelectionSnapshot | null) => {
		const displayed = this.#displayed;
		if (!selection || !displayed || displayed.epoch !== this.edytor.selection.epoch) return false;
		if ('cleared' in displayed) return displayed.cleared === this.edytor.gestureSerial;
		return (
			samePoint(displayed.anchor, selection.anchorNode, selection.anchorOffset) &&
			samePoint(displayed.focus, selection.focusNode, selection.focusOffset)
		);
	};

	/** The DOM selection was observed (derived into the model). */
	observe = () => {
		this.#seen = this.#flushes;
		this.#displayed = null;
	};

	/** A flush rendered since the DOM selection was last observed (drift is possible). */
	get renderedSinceObservation() {
		return this.#seen !== this.#flushes;
	}

	/** Answers whether the pass completed (false: wait for a later flush). */
	#display = (requested: boolean): boolean => {
		const { edytor } = this;
		const { selection } = edytor;
		const node = edytor.node;
		if (!node?.isConnected || edytor.destroyed) return true;
		if (edytor.isComposing) return false;
		if (!requested && (selection.dragging || edytor.isHandlingUserInput)) return false;
		const value = selection.value;
		if (value.kind === 'none') return true;
		if (!selection.projection.start) {
			// A value that no longer resolves: the repair lands it (a live
			// destination may exist only once this flush mounted it).
			selection.restoreDeadSelectionEndpoints();
			return false;
		}
		const dom = getDomSelection(node);
		if (!dom) return true;
		if (value.kind !== 'text') {
			// A block set or an atom shows as selected elements, not a range.
			if (dom.anchorNode && node.contains(dom.anchorNode) && this.#ours(requested)) {
				clearDomSelection(node);
				this.#displayed = {
					cleared: edytor.gestureSerial,
					epoch: selection.epoch,
					intent: edytor.intentSerial
				};
			}
			return true;
		}
		const { startText, yStart, endText, yEnd, isCollapsed, isReversed } = selection.state;
		if (!startText?.node?.isConnected || !endText?.node?.isConnected) return false;
		const start = domPointOf(startText.node, yStart);
		const end = isCollapsed ? start : domPointOf(endText.node, yEnd);
		const points: Points = isReversed
			? { anchor: end, focus: start }
			: { anchor: start, focus: end };
		// Already shown (D5): an observation, whoever holds focus.
		if (!this.#shows(dom, startText, yStart, endText, yEnd, isReversed)) {
			if (!this.#ours(requested)) return true;
			const active = getActiveElement(node);
			if (!(active && node.contains(active))) {
				// Focus first (focusing a host can move the selection): the editing
				// host, never a focusable element inside the text such as a link.
				edytor.expectInternalFocus();
				const element = start[0] instanceof HTMLElement ? start[0] : start[0].parentElement;
				(element?.closest<HTMLElement>('[contenteditable="true"]') ?? node).focus({
					preventScroll: true
				});
			}
			this.#write(getDomSelection(node) ?? dom, points, isCollapsed);
			if (selection.scrollOnDisplay) scrollCaretIntoView(node);
		}
		selection.scrollOnDisplay = false;
		this.#displayed = { ...points, epoch: selection.epoch, intent: edytor.intentSerial };
		this.#seen = this.#flushes;
		selection.observed({
			startNode: start[0],
			endNode: end[0],
			edge: isCollapsed ? getMarkEdgeSide(startText, start[0], yStart) : undefined
		});
		return true;
	};

	/** The live DOM selection already shows these endpoints (model coordinates, direction). */
	#shows = (
		dom: Selection,
		startText: Text,
		yStart: number,
		endText: Text,
		yEnd: number,
		isReversed: boolean
	) => {
		if (!dom.anchorNode || !dom.focusNode || dom.rangeCount > 1) return false;
		const { selection } = this.edytor;
		const collapsed = startText === endText && yStart === yEnd;
		const [first, last] = isReversed
			? [[dom.focusNode, dom.focusOffset] as const, [dom.anchorNode, dom.anchorOffset] as const]
			: [[dom.anchorNode, dom.anchorOffset] as const, [dom.focusNode, dom.focusOffset] as const];
		return (
			dom.isCollapsed === collapsed &&
			selection.getTextOfNode(first[0]) === startText &&
			selection.getTextOfNode(last[0]) === endText &&
			getYIndex(startText, first[0], first[1]) === yStart &&
			getYIndex(endText, last[0], last[1]) === yEnd
		);
	};

	#write = (dom: Selection, { anchor, focus }: Points, collapsed: boolean) => {
		if (!collapsed && typeof dom.setBaseAndExtent === 'function') {
			try {
				dom.setBaseAndExtent(anchor[0], anchor[1], focus[0], focus[1]);
				return;
			} catch {
				// fall through to a forward range
			}
		}
		const range = createDomRange(anchor[0]);
		const backward =
			!collapsed &&
			(anchor[0] === focus[0]
				? focus[1] < anchor[1]
				: Boolean(anchor[0].compareDocumentPosition(focus[0]) & Node.DOCUMENT_POSITION_PRECEDING));
		const [from, to] = backward ? [focus, anchor] : [anchor, collapsed ? anchor : focus];
		range.setStart(from[0], from[1]);
		range.setEnd(to[0], to[1]);
		dom.removeAllRanges();
		dom.addRange(range);
	};

	/**
	 * The focus verdict (O53): focus inside the editor, or orphaned by our own
	 * render (the element noted before the flush is gone, or the DOM selection
	 * collapsed onto an ancestor of the editor). Never a foreign focus or a
	 * selection the user made outside the editor. With nothing focused, only a
	 * display the selection asked for (a command, history, host code) writes: a
	 * background pass (a peer's render, a repair) never takes focus — which is
	 * why a last gesture that landed outside leaves the editor alone.
	 */
	#ours = (requested: boolean) => {
		const node = this.edytor.node!;
		const active = getActiveElement(node);
		if (active && node.contains(active)) return true;
		const document = node.ownerDocument;
		if (active && active !== document.body && active !== document.documentElement) return false;
		const anchor = getDomSelection(node)?.anchorNode ?? null;
		if (
			(this.#noted !== null && !this.#noted.isConnected) ||
			(anchor !== null && anchor !== node && anchor.contains(node))
		)
			return true;
		if (anchor && !node.contains(anchor)) return false;
		return requested;
	};

	/**
	 * `beforeTransaction`: before the first transaction after a settled render
	 * that this view did not issue, mint anchors from an unobserved native move.
	 */
	before = (transaction: Transaction) => {
		const { edytor } = this;
		const origin = transaction.origin;
		if (origin === edytor.transaction || origin === edytor.undoManager || this.#minted) return;
		const node = edytor.node;
		if (!node || edytor.isComposing || edytor.isHandlingUserInput) return;
		// Only after a settled render, and with no display pending: then the DOM
		// is behind the model, not ahead of it.
		if (this.#rendered !== edytor.facade.version || edytor.selection.request !== this.#request)
			return;
		const snapshot = getDomSelectionSnapshot(node);
		if (!snapshot?.anchorNode || this.isEcho(snapshot)) return;
		const value = edytor.selection.mint(snapshot);
		if (!value) return;
		const minted = project(value, edytor.facade);
		const current = edytor.selection.projection;
		if (
			minted.start?.block === current.start?.block &&
			minted.start?.offset === current.start?.offset &&
			minted.end?.block === current.end?.block &&
			minted.end?.offset === current.end?.offset
		)
			return;
		this.#minted = { value, transaction };
	};

	/** `afterTransaction`: the transaction committed — admit the minted move. */
	after = (transaction: Transaction) => {
		const minted = this.#minted;
		if (minted?.transaction !== transaction) return;
		this.#minted = null;
		this.edytor.selection.select(minted.value, 'dom');
	};
}
