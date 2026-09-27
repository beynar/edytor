import type { Edytor } from '$lib/edytor.svelte.js';
import type { Flow, FlowLine } from '$lib/crdt/flow.js';
import type { JSONContentPart } from '$lib/block/contentRange.js';
import {
	replaceSelectionWithCollapsedTargetSync,
	type SelectionInsertionTarget,
	type SelectionReplacementState
} from '$lib/selection/replaceSelection.js';
import {
	jsonBlockToSpec,
	jsonContentToItems,
	type JSONBlock,
	type JSONText
} from '$lib/utils/json.js';
import { id } from '$lib/utils.js';
import { setSuppressedInputRepairSelectionTarget } from '$lib/events/beforeInputRepairTarget.js';
import { isValidEdytorClipboardFragment } from './fragmentData.js';
import type { EdytorClipboardFragment } from './types.js';

// Admission (`flow.shape`): every id is minted fresh here, once.
const run = (content: JSONContentPart[]): FlowLine => ({
	id: id('b'),
	content: jsonContentToItems(content, true)
});
export const flowOfBlocks = (blocks: JSONBlock[], whole = false): Flow => ({
	lines: blocks.map((block) => jsonBlockToSpec(block, true)),
	whole
});
export const flowOfText = (text: string, marks?: JSONText['marks']): Flow => ({
	lines: text.split(/\r\n|\r|\n/).map((line) => run(line ? [{ text: line, marks }] : []))
});
export const flowOfFragment = (fragment: EdytorClipboardFragment): Flow =>
	fragment.kind === 'content'
		? { lines: [run(fragment.content)] }
		: flowOfBlocks(fragment.blocks, fragment.whole === true);

/**
 * Place `flow` (`flow.*`) at `at`, over the selected blocks, or over the
 * selection (`selection`, default: the live one) replaced first; then the caret.
 */
export const pasteFlow = async (
	edytor: Edytor,
	flow: Flow,
	{ at, selection }: { at?: SelectionInsertionTarget; selection?: SelectionReplacementState } = {}
) => {
	if (flow.lines.length === 0) return;
	const replace = at ? [] : [...edytor.selection.selectedBlocks].map((block) => block.id);
	const p = replace.length
		? null
		: (at ?? replaceSelectionWithCollapsedTargetSync(edytor, selection));
	const block = p?.text.parent;
	if (!replace.length && !block) return;
	const target = block
		? { block: block.id, offset: block.partOffsetOf(p!.text) + p!.offset }
		: { replace };
	const [text, offset] = edytor.insertFlow({ flow, target });
	if (replace.length) edytor.selection.selectBlocks();
	if (!text) return;
	setSuppressedInputRepairSelectionTarget(edytor, text, offset);
	await edytor.selection.setAtTextOffset(text, offset);
};

/** Programmatic insertion: the fragment is untrusted input, validated here. */
export const insertEdytorClipboardFragment = async (
	edytor: Edytor,
	fragment: EdytorClipboardFragment
) => {
	if (isValidEdytorClipboardFragment(fragment)) await pasteFlow(edytor, flowOfFragment(fragment));
};
