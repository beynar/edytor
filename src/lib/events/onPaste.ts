import type { Edytor } from '../edytor.svelte.js';
import { vetoable } from '$lib/utils.js';
import { readEdytorClipboardFragment } from '$lib/clipboard/clipboard.js';
import { flowOfFragment, pasteFlow } from '$lib/clipboard/insertClipboardFragment.js';
import { flowOfHtml } from '$lib/clipboard/htmlFlow.js';
import { getDomSelectionSnapshot } from '$lib/selection/domSelection.js';
import { getYIndex } from '$lib/selection/selection.utils.js';
import { observeInternalDragSources } from './onDrop.js';
import { runOccurrence } from './onBeforeInput.js';
import { firstUriListEntry } from './dataTransferPayload.js';
import { ownsEvent } from './nativeInteractiveControl.js';

/**
 * Shift-paste requests a plain-text paste (PM input.ts:620-630 —
 * `mod-shift-v` and `Shift+Insert` keyCode 45 both take the plain branch).
 * `ClipboardEvent` carries no modifier state, so the Shift state is tracked
 * on keydown/keyup capture at the owning root (document or shadow root).
 */
let shiftPasteModifierHeld = false;
const observedShiftRoots = new WeakSet<Node>();

export const observeShiftPasteModifier = (rootNode: Node | null | undefined) => {
	if (!rootNode || observedShiftRoots.has(rootNode)) {
		return;
	}
	observedShiftRoots.add(rootNode);
	const track = (event: Event) => {
		shiftPasteModifierHeld = (event as KeyboardEvent).shiftKey === true;
	};
	rootNode.addEventListener('keydown', track, true);
	rootNode.addEventListener('keyup', track, true);
	const view =
		rootNode instanceof Document ? rootNode.defaultView : rootNode.ownerDocument?.defaultView;
	view?.addEventListener('blur', () => {
		shiftPasteModifierHeld = false;
	});
};

if (typeof document !== 'undefined') {
	observeShiftPasteModifier(document);
}

/**
 * A paste over a block selection lands at a collapsed DOM caret put outside
 * the selected blocks since the selection was made (a press, or a
 * `selectionchange` the editor adopted: `selection.placedOver`), not over
 * them. A caret nothing put there is the browser's own (a paste with no DOM
 * range gets one at the editable's start): the blocks are replaced
 * (`flow.slot`).
 */
const syncCollapsedDomCaretForPaste = (edytor: Edytor) => {
	const { selectedBlocks } = edytor.selection;
	if (!selectedBlocks.size || edytor.selection.placedOver !== edytor.selection.value) return;
	const dom = getDomSelectionSnapshot(edytor.node);
	const node = dom?.isCollapsed && dom.anchorNode;
	if (!dom || !node || !edytor.node?.contains(node)) return;
	const text = edytor.selection.getTextOfNode(node, dom.anchorOffset);
	for (let block = text?.parent; block; block = block.parent) if (selectedBlocks.has(block)) return;
	if (text) edytor.selection.setAtTextOffset(text, getYIndex(text, node, dom.anchorOffset));
};

export async function onPaste(this: Edytor, e: ClipboardEvent) {
	if (this.readonly || this.selection.state.isVoidEditableElement) {
		return;
	}

	// A paste in a kind's own control (a field bound to `block.data`, a
	// nested editable island) is the control's (`ownsEvent`): inserting the
	// fragment at the model selection would write the document AND cancel its paste.
	if (ownsEvent(this.node, e)) {
		return;
	}

	if (this.isComposing) {
		// The composition preview owns the write path — the browser performs
		// the paste and the deferred observer reconciles it after
		// compositionend (PM input.ts:656-660 does the same).
		return;
	}

	observeInternalDragSources(this.node?.getRootNode());
	observeShiftPasteModifier(this.node?.getRootNode());
	syncCollapsedDomCaretForPaste(this);

	const preferPlainText = shiftPasteModifierHeld && Boolean(e.clipboardData?.getData('text/plain'));

	if (!preferPlainText) {
		const fragment = readEdytorClipboardFragment(e.clipboardData);
		if (fragment) {
			e.preventDefault();
			return this.dispatcher.run('insertFromPaste', () =>
				pasteFlow(this, flowOfFragment(fragment))
			);
		}

		const claimed = (plugin: (typeof this.plugins)[number]) =>
			vetoable((prevent) => plugin.onPaste?.({ prevent, e }));
		if (this.dispatcher.intercept(claimed, () => e.preventDefault())) return;

		// File payloads route only through the plugin `onPaste` hook (the
		// Files → image seam — no bundled consumer yet). An unclaimed file
		// paste inserts nothing rather than silent file-name text.
		if ((e.clipboardData?.files?.length ?? 0) > 0) {
			e.preventDefault();
			return;
		}

		// External HTML (P4.1); HTML that carries nothing falls through to text/plain.
		const flow = flowOfHtml(this, e.clipboardData?.getData('text/html'));
		if (flow) {
			e.preventDefault();
			return this.dispatcher.run('insertFromPaste', () => pasteFlow(this, flow));
		}
	}

	if (
		!e.clipboardData?.getData('text/plain') &&
		!firstUriListEntry(e.clipboardData?.getData('text/uri-list'))
	) {
		return;
	}

	e.preventDefault();
	return runOccurrence(this, {
		inputType: 'insertFromPaste',
		data: e.clipboardData?.getData('text/plain') ?? '',
		dataTransfer: e.clipboardData,
		cancelable: true
	});
}
