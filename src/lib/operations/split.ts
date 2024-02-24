import { getId } from '$lib/utils/getId.js';
import { yBlockFromJson, type YBlock, yTextToJSON } from '$lib/utils/json.js';
import { setCursorAtPosition } from '$lib/utils/setCursor.js';
import { Text, type Array } from 'yjs';

export const split = (yText: Text, index: number) => {
	// If block is empty, duplicate block
	// If block is only text, split it into two blocks of the same type
	// If block has children, split the text at the index and create a new block with the rest of the text of the type of the first child block

	const block = yText.parent as YBlock;
	const children = block.get('children') as Array<YBlock>;
	const hasChildren = children.length > 0;
	const isEmpty = yText.length === 0;
	const parentArray = block.parent as Array<YBlock>;
	const blockIndex = parentArray.toArray().indexOf(block);

	if (isEmpty) {
		parentArray.insert(blockIndex + 1, [
			yBlockFromJson({ type: block.get('type') as string, content: [] })
		]);
	} else if (!hasChildren) {
		const restOfText = yText.clone();
		restOfText.doc = yText.doc;
		restOfText.applyDelta(yText.toDelta());
		restOfText.delete(0, index);
		const newBlock = yBlockFromJson({
			type: block.get('type') as string,
			content: yTextToJSON(restOfText)
		});
		restOfText.doc = null;
		parentArray.insert(blockIndex + 1, [newBlock]);
		yText.delete(index, yText.length);
		const newTextNode = newBlock.get('content') as Text;
		setCursorAtPosition(getId(newTextNode), 0);
	} else {
		// const restOfText = yText.slice(index);
		// yText.delete(index, yText.length - index);
		// const parentArray = block.parent as Array<YBlock>;
		// const index = parentArray.toArray().indexOf(block);
		// parentArray.insert(index + 1, [
		// 	yBlockFromJson({ type: block.get('type') as string, content: yTextToJSON(restOfText) })
		// ]);
	}
};
