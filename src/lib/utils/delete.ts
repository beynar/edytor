import type { Array, Text } from 'yjs';
import { yBlockFromJson, type YBlock } from './json.js';

export const recursivelyDeleteBlock = (yBlock: YBlock) => {
	const parentArray = yBlock.parent as Array<YBlock>;
	const parentBlock = parentArray.parent as YBlock;
	const index = parentArray.toArray().indexOf(yBlock);
	parentArray.delete(index);
	if (parentArray.length === 0) {
		if (!parentBlock?.parent) {
			if (yBlock.doc?.getArray('children').length === 0) {
				yBlock.doc
					?.getArray('children')
					.insert(0, [
						yBlockFromJson({ type: 'blockquote', content: [{ text: 'eazeza', marks: [] }] })
					]);
			} else {
				return;
			}
		} else {
			recursivelyDeleteBlock(parentBlock);
		}
	}
};
export const recursivelyDeleteText = (yText: Text) => {
	const parent = yText.parent as YBlock;
	const hasNoChildren = (parent.get('children') as Array<YBlock>).length === 0;
	if (hasNoChildren && yText.length === 0) {
		recursivelyDeleteBlock(parent);
	}
};
