import type { JSONInlineBlock, JSONText } from '$lib/utils/json.js';

export type JSONContentPart = JSONText | JSONInlineBlock;

export const isTextPart = (part: JSONContentPart): part is JSONText => 'text' in part;

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
