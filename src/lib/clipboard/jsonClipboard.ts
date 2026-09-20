import { isTextPart, type JSONContentPart } from '$lib/block/contentRange.js';
import { cloneJson, type JSONBlock, type JSONInlineBlock } from '$lib/utils/json.js';

export const stripIdsFromContent = (content: JSONContentPart[]) =>
	content.map((part) => {
		if (isTextPart(part)) {
			return cloneJson(part);
		}

		const inlineBlock = cloneJson(part) satisfies JSONInlineBlock;
		delete inlineBlock.id;
		return inlineBlock;
	});

export const stripIdsFromBlock = (block: JSONBlock): JSONBlock => {
	const next = cloneJson(block);
	delete next.id;

	if (next.children) {
		next.children = next.children.map(stripIdsFromBlock);
	}

	if (next.content) {
		next.content = stripIdsFromContent(next.content);
	}

	return next;
};
