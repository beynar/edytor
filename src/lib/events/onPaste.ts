import type { Edytor } from '../edytor.svelte.js';
import { prevent } from '$lib/utils.js';
import { readEdytorClipboardFragment } from '$lib/clipboard/clipboard.js';
import { flowOfFragment, pasteFlow } from '$lib/clipboard/insertClipboardFragment.js';
import { flowOfHtml } from '$lib/clipboard/htmlFlow.js';
import { Block } from '$lib/block/block.svelte.js';
import { getDomSelectionSnapshot } from '$lib/selection/domSelection.js';
import { getYIndex } from '$lib/selection/selection.utils.js';
import { observeInternalDragSources } from './onDrop.js';
import { runOccurrence } from './onBeforeInput.js';
import { firstUriListEntry } from './dataTransferPayload.js';
import { isNestedForeignEditableTarget } from './nativeInteractiveControl.js';

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

const isInsideSelectedBlock = (block: Block, selectedBlocks: Set<Block>) => {
	let current: Block | undefined = block;
	while (current) {
		if (selectedBlocks.has(current)) {
			return true;
		}
		current = current.parent instanceof Block ? current.parent : undefined;
	}
	return false;
};

const syncCollapsedDomCaretForPaste = (edytor: Edytor) => {
	if (edytor.selection.selectedBlocks.size === 0) {
		return;
	}

	const selection = getDomSelectionSnapshot(edytor.node);
	const container = edytor.container;
	if (
		!selection?.isCollapsed ||
		!selection.anchorNode ||
		!selection.focusNode ||
		!container?.contains(selection.anchorNode) ||
		!container.contains(selection.focusNode)
	) {
		return;
	}

	const targetText = edytor.selection.getTextOfNode(selection.anchorNode, selection.anchorOffset);
	if (!targetText) {
		return;
	}

	const selectedBlocks = new Set(edytor.selection.selectedBlocks);
	if (isInsideSelectedBlock(targetText.parent, selectedBlocks)) {
		return;
	}

	edytor.selection.setCollapsedStateAtTextOffset(
		targetText,
		getYIndex(targetText, selection.anchorNode, selection.anchorOffset)
	);
};

export async function onPaste(this: Edytor, e: ClipboardEvent) {
	if (this.readonly || this.selection.state.isVoidEditableElement) {
		return;
	}

	// A paste inside a nested `contenteditable` island belongs to the
	// island — inserting the clipboard fragment at the stale model
	// selection would corrupt the document AND preventDefault the
	// island's own paste.
	if (isNestedForeignEditableTarget(this.node, e.target)) {
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

		const claimed = (plugin: (typeof this.plugins)[number]) => plugin.onPaste?.({ prevent, e });
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
