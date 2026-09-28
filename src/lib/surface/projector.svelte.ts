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
 * - no composition session owns a host (BI-2, `edytor.composition`, the
 *   session's facts): a pass it holds back runs again at the session's end
 *   (`composition.ended`), which catches up;
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
 *
 * It classifies every `selectionchange` (`classify`) against its last display,
 * the render epoch and the gesture serial: echo, render drift (displayed
 * again), composition, foreign write or intent (adopted). Two named, counted,
 * time-bounded browser rules (plan §9.1 rule 5) are the only signatures:
 * the Android post-delete snap-back and the IME post-commit jump.
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
import {
	getMarkEdgeSide,
	getYIndex,
	isTextBoundSelectionPoint
} from '../selection/selection.utils.js';
import { project, type SelectionValue } from '../session/selection.js';
import type { Attempt } from '../session/attempt.js';
import { isAndroidChromeBrowser } from '../events/events.utils.js';
import { isNestedForeignEditableTarget } from '../events/nativeInteractiveControl.js';

/** What a `selectionchange` is (R10). Drift is displayed again; foreign writes and intent are adopted. */
export type Observation = 'echo' | 'drift' | 'composition' | 'foreign' | 'intent';

/**
 * Named rule (plan §9.1 rule 5): Android Chrome mutates the DOM after a
 * canceled `deleteContentBackward` and reports the caret one position right
 * of the model's merge point, in the same task or a few frames later.
 */
const ANDROID_SNAP_BACK_MS = 250;
/** Named rule (plan §9.1 rule 5): engines move the caret once more right after an IME commit. */
const IME_POST_COMMIT_JUMP_MS = 100;

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
	/** What the last display left in the DOM, and the selection epoch it showed. */
	#displayed: (Points & { epoch: number }) | null = null;
	/** The observer holds DOM records it has not reconciled yet (set at attach). */
	recordsPending: () => boolean = () => false;
	/** The (request, render, remount) key the last completed pass answered. */
	#done = '';
	#request = -1;
	#pending = false;
	/** The focused element inside the editor, noted before the flush's DOM writes. */
	#noted: Element | null = null;
	/** Flushes rendered, and the flush at the last observation (a display, or a DOM derive). */
	#flushes = 0;
	#seen = -1;
	#minted: { value: SelectionValue; transaction: Transaction } | null = null;
	/** The next transaction opens a batch: no earlier commit of it is still to report. */
	#opening = false;
	/** The gesture serial at the last observation (a display or an adopted `selectionchange`). */
	#serial = -1;
	/** The named rules' evidence: the last model-owned delete and the last IME commit. */
	#deleted: { attempt: Attempt; serial: number; at: number } | null = null;
	#committed: { serial: number; at: number } | null = null;
	/** A pass waits for the live composition session's end. */
	#held = false;

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
		return `${edytor.selection.request}:${edytor.surface.epoch}`;
	};

	#pass = (key: string) => {
		const { edytor } = this;
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
		if (this.#pending || dead || text === startText || text === endText)
			this.edytor.surface.update();
	};

	/**
	 * The composition gate (BI-2): a live session owns its host, whose DOM
	 * selection is the IME's. A pass it holds back runs once the session ended.
	 */
	#composing = () => {
		const { composition } = this.edytor;
		if (!composition.live) return false;
		if (!this.#held) {
			this.#held = true;
			composition.ended(() => {
				this.#held = false;
				this.edytor.surface.update();
			});
		}
		return true;
	};

	/** The observer processed DOM records (O55): a display that waits gets a pass. */
	recordsChanged = () => {
		if (this.#pending) this.edytor.surface.update();
	};

	/**
	 * Classify a `selectionchange` (R10) by comparing the DOM selection with the
	 * last display, the render epoch and the gesture serial:
	 * - echo: our last display unchanged; a requested display still to land
	 *   (no gesture since the request); a range that already shows the value;
	 * - composition: a session owns the host (its end catches up);
	 * - drift: no gesture since the last observation, and a render since it
	 *   (a flush the DOM selection was not observed after, or DOM records the
	 *   observer has not reconciled), or one of the two named signatures;
	 * - intent: a gesture since the last observation, or a pointer drag;
	 * - foreign: no gesture and no render (host code, assistive tech, O1).
	 */
	classify = (dom: DomSelectionSnapshot | null): Observation => {
		const { edytor } = this;
		const { selection } = edytor;
		const node = edytor.node;
		const anchor = dom?.anchorNode;
		// Not ours to classify: outside the editor, or in a nested editable island.
		if (!dom || !anchor || !node?.contains(anchor) || isNestedForeignEditableTarget(node, anchor))
			return 'foreign';
		if (this.#echoes(dom)) return 'echo';
		// The one composition branch: a live session's host is the IME's (I3).
		if (edytor.composition.live) return this.#observed('composition');
		if (selection.request !== this.#request && selection.requestSerial === edytor.intentSerial)
			return 'echo';
		if (edytor.intentSerial === this.#serial && (this.#snapBack(dom) || this.#jump()))
			return 'drift';
		if (edytor.intentSerial !== this.#serial || selection.dragging) return this.#observed('intent');
		return this.#seen !== this.#flushes || this.recordsPending()
			? 'drift'
			: this.#observed('foreign');
	};

	/** The DOM selection is observed now (adopted, or ignored by the adopter's own rules). */
	#observed = (observation: Observation) => {
		this.#seen = this.#flushes;
		this.#serial = this.edytor.intentSerial;
		return observation;
	};

	/** The DOM selection is our last display unchanged, or a text-bound range that shows the value. */
	#echoes = (dom: DomSelectionSnapshot) => {
		const displayed = this.#displayed;
		const { selection } = this.edytor;
		if (
			displayed?.epoch === selection.epoch &&
			samePoint(displayed.anchor, dom.anchorNode, dom.anchorOffset) &&
			samePoint(displayed.focus, dom.focusNode, dom.focusOffset)
		)
			return true;
		const { startText, yStart, endText, yEnd, isReversed, isCollapsed } = selection.state;
		return Boolean(
			!isCollapsed &&
			startText &&
			endText &&
			isTextBoundSelectionPoint(dom.anchorNode) &&
			isTextBoundSelectionPoint(dom.focusNode) &&
			this.#shows(dom, startText, yStart, endText, yEnd, isReversed)
		);
	};

	/** Evidence for the Android snap-back: a model-owned delete ran (`events/beforeInputDeleteCommands`). */
	deleted = (attempt: Attempt) => {
		this.#deleted = { attempt, serial: this.edytor.intentSerial, at: Date.now() };
	};

	/** Evidence for the IME post-commit jump: a composition committed its caret. */
	committed = () => {
		this.#committed = { serial: this.edytor.intentSerial, at: Date.now() };
	};

	/**
	 * Named rule — the Android post-delete snap-back: after a model-owned
	 * delete that merged a caret at a text start into another text, with no
	 * gesture since, a collapsed DOM caret one right of the value in the same
	 * text is Android's post-delete shift.
	 */
	#snapBack = (dom: DomSelectionSnapshot) => {
		const deleted = this.#deleted;
		const { edytor } = this;
		if (
			!deleted ||
			deleted.serial !== edytor.intentSerial ||
			Date.now() - deleted.at > ANDROID_SNAP_BACK_MS ||
			!isAndroidChromeBrowser() ||
			!dom.isCollapsed
		)
			return false;
		const { attempt } = deleted;
		const { startText, yStart, isCollapsed } = edytor.selection.state;
		return Boolean(
			attempt.isCollapsed &&
			attempt.yStart === 0 &&
			isCollapsed &&
			startText &&
			startText !== attempt.startText &&
			edytor.selection.getTextOfNode(dom.anchorNode) === startText &&
			getYIndex(startText, dom.anchorNode, dom.anchorOffset) === yStart + 1
		);
	};

	/** Named rule — the IME post-commit jump: a move right after a commit, with no gesture since. */
	#jump = () => {
		const committed = this.#committed;
		return Boolean(
			committed &&
			committed.serial === this.edytor.intentSerial &&
			Date.now() - committed.at <= IME_POST_COMMIT_JUMP_MS
		);
	};

	/** The DOM selection was observed (derived into the model). */
	observe = () => {
		this.#seen = this.#flushes;
		this.#serial = this.edytor.intentSerial;
		this.#displayed = null;
	};

	/** Answers whether the pass completed (false: wait for a later flush). */
	#display = (requested: boolean): boolean => {
		const { edytor } = this;
		const { selection } = edytor;
		const node = edytor.node;
		if (!node?.isConnected || edytor.destroyed) return true;
		if (this.#composing()) return false;
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
				this.#displayed = null;
				this.#serial = edytor.intentSerial;
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
		this.#displayed = { ...points, epoch: selection.epoch };
		this.#seen = this.#flushes;
		this.#serial = edytor.intentSerial;
		selection.observed({
			edge: isCollapsed ? getMarkEdgeSide(startText, start[0], yStart) : undefined
		});
		return true;
	};

	/** The live DOM selection already shows these endpoints (model coordinates, direction). */
	#shows = (
		dom: DomSelectionSnapshot | Selection,
		startText: Text,
		yStart: number,
		endText: Text,
		yEnd: number,
		isReversed: boolean
	) => {
		if (!dom.anchorNode || !dom.focusNode || dom.rangeCount > 1) return false;
		const collapsed = startText === endText && yStart === yEnd;
		const [first, last] = isReversed
			? [[dom.focusNode, dom.focusOffset] as const, [dom.anchorNode, dom.anchorOffset] as const]
			: [[dom.anchorNode, dom.anchorOffset] as const, [dom.focusNode, dom.focusOffset] as const];
		// Only points inside the texts' own elements show the value: an element
		// boundary (a re-parented block's old parent, R2; a caret left after a
		// text) is written again, whichever text a boundary walk would map it to.
		return (
			dom.isCollapsed === collapsed &&
			!!startText.node?.contains(first[0]) &&
			!!endText.node?.contains(last[0]) &&
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

	/** `beforeAllTransactions`: the engine opens a batch of transactions. */
	opening = () => {
		this.#opening = true;
	};

	/**
	 * `beforeTransaction`: before the first transaction after a settled render
	 * that this view did not issue, mint anchors from an unobserved native move.
	 * Only a transaction that opens a batch: one opened while another commits
	 * (the engine's formatting cleanup after a remote delete, a subscriber's
	 * write) follows a commit that has not reported yet, so the render key is
	 * still settled while the DOM already shows an older document.
	 */
	before = (transaction: Transaction) => {
		const opening = this.#opening;
		this.#opening = false;
		const { edytor } = this;
		const origin = transaction.origin;
		if (!opening || origin === edytor.transaction || origin === edytor.undoManager || this.#minted)
			return;
		const node = edytor.node;
		if (!node || edytor.composition.live || edytor.isHandlingUserInput) return;
		// Only when the last pass answered every render and display request: then
		// the DOM is behind the model, not ahead of it. (A commit that rendered
		// nothing leaves nothing to settle; comparing document versions kept the
		// rule off until the next render — the move a peer's first commit reverted.)
		if (this.#done !== `${edytor.selection.request}:${edytor.surface.epoch}`) return;
		const snapshot = getDomSelectionSnapshot(node);
		if (!snapshot?.anchorNode || this.#echoes(snapshot)) return;
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
