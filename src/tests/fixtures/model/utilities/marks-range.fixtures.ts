import { defineFixtures, defineParserFixture } from '../../types.js';

type TextWithMarks = { text: string; marks: Map<string, boolean> };

function getAttributesAtRange(children: TextWithMarks[], yStart: number, yEnd: number) {
	let attributes = {};
	let offset = 0;
	let entered = false;

	for (const { text, marks } of children) {
		const length = text.length;
		const end = offset + length;
		if (yStart >= offset && yStart < end) {
			entered = true;
			Object.assign(attributes, Object.fromEntries(marks));
		}
		if (end >= yEnd && entered) {
			Object.assign(attributes, Object.fromEntries(marks));
			break;
		}
		offset += length;
	}
	return attributes;
}

const getMarksAtRange = (children: TextWithMarks[], yStart: number, yEnd: number) => {
	const result: TextWithMarks[] = [];
	let offset = 0;
	let entered = false;

	for (const { text, marks } of children) {
		const length = text.length;
		const end = offset + length;

		if (yStart >= offset && yStart < end) {
			entered = true;
			const startOffset = yStart - offset;
			const endOffset = Math.min(length, yEnd - offset);
			result.push({
				text: text.slice(startOffset, endOffset),
				marks: new Map(marks)
			});
		} else if (entered && end <= yEnd) {
			result.push({
				text,
				marks: new Map(marks)
			});
		} else if (entered && offset < yEnd && yEnd <= end) {
			const endOffset = yEnd - offset;
			result.push({
				text: text.slice(0, endOffset),
				marks: new Map(marks)
			});
			break;
		}

		offset += length;
	}

	return result;
};

export const fixtures = defineFixtures([
	defineParserFixture({
		description: 'collects marks across a text range',
		input: [
			{ text: 'H', marks: new Map([['bold', true]]) },
			{ text: 'ello W', marks: new Map([['italic', true]]) },
			{ text: 'orld', marks: new Map([['bold', true]]) }
		] satisfies TextWithMarks[],
		run: (content: TextWithMarks[]) => ({
			attributes_1: getAttributesAtRange(content, 1, 7),
			attributes_2: getAttributesAtRange(content, 1, 8),
			attributes_3: getAttributesAtRange(content, 1, 2),
			attributes_4: getAttributesAtRange(content, 1, 9),
			range_1: getMarksAtRange(content, 1, 7),
			range_2: getMarksAtRange(content, 1, 8),
			range_3: getMarksAtRange(content, 0, 3)
		}),
		output: {
			attributes_1: { italic: true },
			attributes_2: { bold: true, italic: true },
			attributes_3: { italic: true },
			attributes_4: { bold: true, italic: true },
			range_1: [{ text: 'ello W', marks: new Map([['italic', true]]) }],
			range_2: [
				{ text: 'ello W', marks: new Map([['italic', true]]) },
				{ text: 'o', marks: new Map([['bold', true]]) }
			],
			range_3: [
				{ text: 'H', marks: new Map([['bold', true]]) },
				{ text: 'el', marks: new Map([['italic', true]]) }
			]
		}
	})
]);
