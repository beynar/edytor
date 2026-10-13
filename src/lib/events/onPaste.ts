import type { Edytor } from '../edytor.svelte.js';
import { vetoable } from '$lib/utils.js';
import { readEdytorClipboardFragment } from '$lib/clipboard/clipboard.js';
import {
	flowOfFragment,
	flowOfMarkdown,
	pasteFlow
} from '$lib/clipboard/insertClipboardFragment.js';
import { inCodeLines } from '$lib/session/inputRules.js';
import { flowOfHtml } from '$lib/clipboard/htmlFlow.js';
import { getDomSelectionSnapshot } from '$lib/selection/domSelection.js';
import { getYIndex } from '$lib/selection/selection.utils.js';
import { runOccurrence } from './onBeforeInput.js';
import { firstUriListEntry } from './dataTransferPayload.js';
import { ownsEvent } from './nativeInteractiveControl.js';

/**
 * Shift-paste requests a plain-text paste (PM input.ts:620-630 —
 * `mod-shift-v` and `Shift+Insert` keyCode 45 both take the plain branch).
 * `ClipboardEvent` carries no modifier state, so the Shift state is tracked
 * on the document's keydown/keyup capture (a shadow root's keys are composed:
 * the document sees them first, Shift included).
 */
let shiftPasteModifierHeld = false;

if (typeof document !== 'undefined') {
	const track = (event: KeyboardEvent | FocusEvent) => {
		shiftPasteModifierHeld = (event as KeyboardEvent).shiftKey === true;
	};
	document.addEventListener('keydown', track, true);
	document.addEventListener('keyup', track, true);
	window.addEventListener('blur', track);
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
	if (text) edytor.selection.selectText(text, getYIndex(text, node, dom.anchorOffset));
};

/**
 * A paste: the browser's in a readonly view, a void's field, a kind's own
 * control (a field bound to `block.data`, a nested editable island:
 * `ownsEvent` — inserting the fragment at the model selection would write
 * the document AND cancel its paste) or under a live composition (its
 * preview owns the write path: the browser pastes, the observer reconciles
 * it after the end, as PM input.ts:656-660). Else, unless Shift asks for
 * plain text: an Edytor fragment; what an extension's `onPaste` claims (the
 * `pasteFirst` ones first, then list order); a
 * file nothing claimed inserts nothing (the Files → image seam), never its
 * name; external HTML (HTML that carries nothing falls through); markdown
 * text as its blocks (`paste.markdown`), except in a code block's lines.
 * The plain text (or a URI) left is the paste occurrence's.
 */
export async function onPaste(this: Edytor, e: ClipboardEvent) {
	if (this.readonly || this.selection.voidField || ownsEvent(this.node, e) || this.isComposing)
		return;
	syncCollapsedDomCaretForPaste(this);
	const data = e.clipboardData;
	const plain = data?.getData('text/plain') ?? '';
	let flow = null;
	if (!(shiftPasteModifierHeld && plain)) {
		const fragment = readEdytorClipboardFragment(data);
		if (!fragment) {
			// The `pasteFirst` hooks (a pasted reference: page link's `fromPaste`), then the
			// others in list order; the first that prevents claims the paste.
			const claimed = (first: boolean) => (plugin: (typeof this.plugins)[number]) =>
				!!plugin.pasteFirst === first && vetoable((prevent) => plugin.onPaste?.({ prevent, e }));
			const stop = () => e.preventDefault();
			if (
				this.dispatcher.intercept(claimed(true), stop) ||
				this.dispatcher.intercept(claimed(false), stop)
			)
				return;
			if (data?.files?.length) return e.preventDefault();
		}
		const start = this.idToBlock.get(this.selection.projection.start?.block ?? '');
		flow = fragment
			? flowOfFragment(fragment)
			: (flowOfHtml(this, data?.getData('text/html')) ??
				(start && inCodeLines(this, start) ? null : flowOfMarkdown(this, plain)));
	}
	if (!flow && !plain && !firstUriListEntry(data?.getData('text/uri-list'))) return;
	e.preventDefault();
	return flow
		? this.dispatcher.run('insertFromPaste', () => pasteFlow(this, flow))
		: runOccurrence(this, {
				inputType: 'insertFromPaste',
				data: plain,
				dataTransfer: data,
				cancelable: true
			});
}
