/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Edytor } from '$lib/hooks/useEdytor.svelte.js';
import { getId } from '$lib/utils/getId.js';
import { yBlockFromJson, type YBlock, blockToJson } from '$lib/utils/json.js';
import { setCursorAtPosition } from '$lib/utils/setCursor.js';
import { Text, Array } from 'yjs';

const getLeftBlock = (block: YBlock) => {
	const parent = block.parent as Array<YBlock>;
	const index = parent.toArray().indexOf(block);
	return index > 0 ? parent.get(index - 1) : null;
};

const previousContent = (block: YBlock) => {
	let target = getLeftBlock(block);
	const hasChildren = () => target!.get('children').length > 0;
	while (target && hasChildren()) {
		target = target.get('children').get(target.get('children').length - 1);
	}
	return target!.get('content') as Text;
};
export const nest = (y: Text, edytor: Edytor) => {
	const block = y instanceof Text ? (y.parent as YBlock) : y;
	const doc = block.doc;
	const previous = getLeftBlock(block);
	const clone = yBlockFromJson(blockToJson(block));

	// If there is a previous block insert the current block as a child of the previous block
	if (previous) {
		const previousArray = previous.get('children') as Array<YBlock>;
		const parentArray = block.parent as Array<YBlock>;
		const index = parentArray.toArray().indexOf(block);
		if (previousArray) {
			doc?.transact(() => {
				parentArray.delete(index, 1);
				previousArray.insert(Math.max(previousArray.length, 0), [clone]);
				const id = getId(clone.get('content') as Text);
				setCursorAtPosition(id, edytor.selection.yStartIndex);
				return true;
			});

			// delete block from parent
		}
	}
};

const mergeTexts = (target: Text, text: Text) => {
	const delta = text.toDelta();
	let offset = target.length;
	for (const op of delta) {
		if (typeof op.insert === 'string') {
			target.insert(offset, op.insert, { ...op.attributes });
			offset += op.insert.length;
		}
	}

	return { offset, id: getId(target) };
};

export const unNest = (y: YBlock | Text, edytor: Edytor) => {
	const doc = y.doc;
	const block = y instanceof Text ? (y.parent as YBlock) : y;
	const blockArray = block.parent as Array<YBlock>;
	const index = blockArray.toArray().indexOf(block);
	const parent = blockArray.parent as YBlock;
	const parentArray = parent?.parent as Array<YBlock>;
	const parentIndex = parentArray?.toArray?.().indexOf(parent);
	const clone = yBlockFromJson(blockToJson(block));

	// Remove the block from its current parent and insert it in the parent of the current parent
	const isLast = index === blockArray.length - 1;
	const isSolo = blockArray.length === 1;
	const isFirst = index === 0;
	const children = block.get('children');
	const hasChildren = children.length > 0;
	const childrenClones = children.toArray().map((child: any) => yBlockFromJson(blockToJson(child)));

	doc?.transact(() => {
		if (!parent) {
			// The parent is the document just merge the current block with the left one
			const { offset, id } = mergeTexts(previousContent(block), block.get('content') as Text);
			blockArray.delete(index, 1);
			setCursorAtPosition(id, offset);
		} else {
			if ((isLast || isSolo) && !hasChildren) {
				blockArray.delete(index, 1);
				parentArray.insert(parentIndex + 1, [clone]);
				const id = getId(clone.get('content') as Text);
				setCursorAtPosition(id, edytor.selection.yStartIndex);
			} else if (isFirst) {
				const { offset, id } = mergeTexts(
					parent.get('content') as Text,
					block.get('content') as Text
				);
				blockArray.delete(index, 1);
				setCursorAtPosition(id, offset);
			} else if (!isLast && !isSolo) {
				const { offset, id } = mergeTexts(previousContent(block), block.get('content') as Text);
				blockArray.delete(index, 1);
				setCursorAtPosition(id, offset);
			} else if (!hasChildren) {
				const { offset, id } = mergeTexts(
					parent.get('content') as Text,
					block.get('content') as Text
				);
				blockArray.delete(index, 1);
				setCursorAtPosition(id, offset);
			}
		}

		hasChildren && blockArray.insert(index, childrenClones);
	});
};
