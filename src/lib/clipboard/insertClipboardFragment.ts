import type { Edytor } from '$lib/edytor.svelte.js';
import type { Flow, FlowLine } from '$lib/crdt/flow.js';
import type { JSONContentPart } from '$lib/block/contentRange.js';
import {
	keepsSelectedBlocks,
	replaceSelectionWithCollapsedTarget,
	type SelectionInsertionTarget,
	type SelectionReplacementState
} from '$lib/selection/replaceSelection.js';
import { selectedMembers } from '$lib/selection/visibility.js';
import {
	cloneJsonSafe,
	jsonBlockToSpec,
	jsonContentToItems,
	type JSONBlock,
	type JSONText
} from '$lib/utils/json.js';
import { id } from '$lib/utils.js';
import { caretAt } from '$lib/session/attempt.js';
import { isValidEdytorClipboardFragment } from './fragmentData.js';
import { hasBlockMarkdown, textToBlocks } from './textBlocks.js';
import type { EdytorClipboardFragment } from './types.js';

// Admission (`flow.shape`): every id is minted fresh here, once.
const run = (content: JSONContentPart[]): FlowLine => ({
	id: id('b'),
	content: jsonContentToItems(content, true)
});
export const flowOfText = (text: string, marks?: JSONText['marks']): Flow => ({
	lines: text.split(/\r\n|\r|\n/).map((line) => run(line ? [{ text: line, marks }] : []))
});
/**
 * A pasted `text/plain` as markdown (`paste.markdown`): `null` unless a line
 * holds block markdown (`hasBlockMarkdown`), else the blocks it reads as
 * (`textToBlocks`). A kind the view does not register is a paragraph of its
 * text, its children after it (a divider is dropped); without a paragraph
 * kind, nothing converts.
 */
export const flowOfMarkdown = (edytor: Pick<Edytor, 'blocks'>, text: string): Flow | null => {
	if (!edytor.blocks.has('paragraph') || !hasBlockMarkdown(text)) return null;
	const known = (block: JSONBlock): JSONBlock[] => {
		const children = (block.children ?? []).flatMap(known);
		if (edytor.blocks.has(block.type))
			return [{ ...block, ...(block.children ? { children } : {}) }];
		const own: JSONBlock[] =
			block.type === 'divider' || (!block.content?.length && block.children?.length)
				? []
				: [{ type: 'paragraph', content: block.content ?? [] }];
		return [...own, ...children];
	};
	const blocks = textToBlocks(text).flatMap(known);
	return blocks.length ? { lines: blocks.map((block) => jsonBlockToSpec(block, true)) } : null;
};

export const flowOfFragment = (fragment: EdytorClipboardFragment): Flow =>
	fragment.kind === 'content'
		? { lines: [run(fragment.content)] }
		: {
				lines: fragment.blocks.map((block) => jsonBlockToSpec(block, true)),
				whole: fragment.whole === true
			};

/**
 * Place `flow` (`flow.*`) at `at`, over the selected blocks (unless
 * `keepsSelectedBlocks`), or over the selection (`selection`, default: the
 * live one) replaced first; then the caret.
 */
export const pasteFlow = (
	edytor: Edytor,
	flow: Flow,
	{ at, selection }: { at?: SelectionInsertionTarget; selection?: SelectionReplacementState } = {}
) => {
	if (flow.lines.length === 0) return;
	const selected = at ? [] : selectedMembers(edytor);
	if (selected.length && keepsSelectedBlocks(edytor, selected)) return;
	const replace = selected.map((block) => block.id);
	const p = replace.length ? null : (at ?? replaceSelectionWithCollapsedTarget(edytor, selection));
	const block = p?.text.parent;
	if (!replace.length && !block) return;
	const target = block ? { block: block.id, offset: p!.text.segStart + p!.offset } : { replace };
	const [text, offset] = edytor.insertFlow({ flow, target });
	if (replace.length) edytor.selection.selectBlocks();
	caretAt(edytor, text, offset);
};

/** Programmatic insertion: the fragment is untrusted input, projected to JSON and validated here. */
export const insertEdytorClipboardFragment = async (
	edytor: Edytor,
	fragment: EdytorClipboardFragment
) => {
	const json = cloneJsonSafe(fragment);
	if (isValidEdytorClipboardFragment(json)) await pasteFlow(edytor, flowOfFragment(json));
};
