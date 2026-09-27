import type { JSONInlineBlock, JSONText } from '$lib/utils/json.js';
import { InlineBlock } from './inlineBlock.svelte.js';
import type { Block } from './block.svelte.js';
import { Text } from '$lib/text/text.svelte.js';

export type JSONContentPart = JSONText | JSONInlineBlock;

export const isTextPart = (part: JSONContentPart): part is JSONText => 'text' in part;

export const getContentTextLength = (content: JSONContentPart[]) =>
	content.reduce((length, part) => length + (isTextPart(part) ? part.text.length : 0), 0);

export const sliceTextValue = (value: JSONText[], start: number, end: number) => {
	let offset = 0;
	const result: JSONText[] = [];

	for (const part of value) {
		const partStart = offset;
		const partEnd = offset + part.text.length;
		offset = partEnd;

		if (partEnd <= start || partStart >= end) {
			continue;
		}

		const textStart = Math.max(start - partStart, 0);
		const textEnd = Math.min(end - partStart, part.text.length);
		result.push({
			text: part.text.slice(textStart, textEnd),
			...(part.marks ? { marks: part.marks } : {})
		});
	}

	return result;
};

const getSerializableContent = (part: Text | InlineBlock): JSONContentPart[] =>
	part instanceof Text ? part.value : [part.value];

export const splitBlockContentAtText = (text: Text, offset: number) => {
	const before: JSONContentPart[] = [];
	const after: JSONContentPart[] = [];

	for (const part of text.parent.content) {
		if (part.index < text.index) {
			before.push(...getSerializableContent(part));
			continue;
		}

		if (part.index > text.index) {
			after.push(...getSerializableContent(part));
			continue;
		}

		if (part instanceof Text) {
			before.push(...sliceTextValue(part.value, 0, offset));
			after.push(...sliceTextValue(part.value, offset, part.length));
		}
	}

	return { before, after };
};

export const setSelectionAtBlockOffset = async (block: Block, offset: number) => {
	let remaining = offset;

	for (const part of block.content) {
		if (!(part instanceof Text)) {
			continue;
		}

		if (remaining <= part.length) {
			await block.edytor.selection.setAtTextOffset(part, remaining);
			return;
		}

		remaining -= part.length;
	}

	const text = block.lastText;
	if (text) await block.edytor.selection.setAtTextOffset(text, text.length);
};
