import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONContentPart } from './types.js';
import type { EdytorClipboardFragment } from './types.js';
import { sliceContent } from '$lib/block/contentRange.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { rangeCovers, selectedMembers } from '$lib/selection/visibility.js';
import { liftLayouts } from '$lib/selection/replaceSelection.js';

/**
 * Block values nested as in the document, members only: a child that is not
 * a member is left out, a member under a non-member starts a top-level entry.
 * `blocks` in document order; `valueOf` answers fresh JSON (children dropped here).
 */
const nestMembers = (blocks: Block[], valueOf: (block: Block) => JSONBlock): JSONBlock[] => {
	const values = new Map<Block, JSONBlock>();
	const out: JSONBlock[] = [];
	for (const block of blocks) {
		const value = valueOf(block);
		delete value.children;
		values.set(block, value);
		const parent = block.parent && values.get(block.parent);
		if (parent) parent.children = [...(parent.children ?? []), value];
		else out.push(value);
	}
	return out;
};

/**
 * `fragment` without the marks whose record says `copy: false` (a
 * comment's anchor, `comment:<id>`: Notion copies the text, not the
 * comment): one rule for copy, cut and the internal paste they feed.
 */
const withoutUncopied = (
	edytor: Edytor,
	fragment: EdytorClipboardFragment | null
): EdytorClipboardFragment | null => {
	if (!fragment) return fragment;
	const strip = (content: JSONContentPart[] | undefined) => {
		for (const part of content ?? []) {
			if (!('text' in part) || !part.marks) continue;
			for (const key of Object.keys(part.marks))
				if (edytor.marks.get(key)?.copy === false) delete part.marks[key];
			if (Object.keys(part.marks).length === 0) delete part.marks;
		}
	};
	const walk = (blocks: JSONBlock[]) => {
		for (const block of blocks) {
			strip(block.content as JSONContentPart[] | undefined);
			if (block.children) walk(block.children);
		}
	};
	if (fragment.kind === 'blocks') walk(fragment.blocks);
	else strip(fragment.content);
	return fragment;
};

export const createEdytorClipboardFragment = (edytor: Edytor): EdytorClipboardFragment | null =>
	withoutUncopied(edytor, fragmentOf(edytor));

const fragmentOf = (edytor: Edytor): EdytorClipboardFragment | null => {
	const { selection, idToBlock } = edytor;
	// A layout the block selection covers whole is copied as the layout.
	const selectedBlocks = selectedMembers(edytor, liftLayouts(selection.selectedBlocks));
	if (selectedBlocks.length > 0) {
		return {
			version: 1,
			source: 'edytor',
			kind: 'blocks',
			// Exactly the members (`sel.blocks.exact`), a layout covered whole as itself, which
			// deleting its blocks removes: what a cut copies is what it deletes.
			blocks: nestMembers(selectedBlocks, (block) => block.value),
			whole: true
		};
	}

	// The range in block offsets: `block.value` is the document's serializer output (fresh JSON).
	const { start, end, isCollapsed, isBlockSpanning, blocks } = selection.projection;
	const startBlock = start && idToBlock.get(start.block);
	if (!start || !end || !startBlock || isCollapsed) return null;
	if (!isBlockSpanning) {
		const content = sliceContent(startBlock.value.content, start.offset, end.offset);
		return { version: 1, source: 'edytor', kind: 'content', blockType: startBlock.type, content };
	}
	// A hidden block (a closed toggle's body) is copied exactly when the range's
	// delete removes it, so a cut, or a copy then Backspace, never loses or
	// duplicates it (`del.range.hidden-body`).
	const copied = blocks.flatMap((id) => idToBlock.get(id) ?? []).filter(rangeCovers(edytor));
	return {
		version: 1,
		source: 'edytor',
		kind: 'blocks',
		blocks: nestMembers(copied, (block) => {
			const value = block.value;
			const [first, last] = [block.id === start.block, block.id === end.block];
			if (first || last)
				value.content = sliceContent(
					value.content,
					first ? start.offset : 0,
					last ? end.offset : Infinity
				);
			return value;
		})
	};
};
