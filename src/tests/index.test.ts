import { describe, it, expect, should } from 'vitest';

// describe('sum test', () => {
// 	it('should work', () => {
// 		const doc = new Y.Doc();
// 		const root = doc.getMap('root');
// 		const object = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 };

// 		for (let i = 0; i < 20000; i++) {
// 			const map = new Y.Map();
// 			root.set(i.toString(), map);
// 			const assignProperties = (object: Record<string, any>) => {
// 				for (const key in object) {
// 					const randomString = Math.random().toString(36).substring(2, 15);
// 					const randomString2 = Math.random().toString(36).substring(2, 15);
// 					map.set(randomString2, randomString);
// 				}
// 			};
// 			assignProperties(object);
// 		}

// 		console.log(Y.encodeStateAsUpdateV2(doc).byteLength);
// 		const megabytes = Y.encodeStateAsUpdateV2(doc).byteLength / 1024 / 1024;
// 		console.log({ megabytes });
// 	});
// });

function getAttributesAtRange(
	children: { text: string; marks: Map<string, boolean> }[],
	yStart: number,
	yEnd: number
) {
	let attributes = {};
	let offset = 0;
	let entered = false;

	for (let i = 0; i < children.length; i++) {
		const { text, marks } = children[i];
		const length = text.length;
		const end = offset + length;
		if (yStart >= offset && yStart < end) {
			entered = true;
			console.log({ marks, length });
			Object.assign(attributes, Object.fromEntries(marks));
		}
		if (end >= yEnd && entered) {
			console.log({ marks, length, end });
			Object.assign(attributes, Object.fromEntries(marks));
			break;
		}
		offset += length;
	}
	return attributes;
}

const getMarksAtRange = (
	children: { text: string; marks: Map<string, boolean> }[],
	yStart: number,
	yEnd: number
) => {
	const result: { text: string; marks: Map<string, boolean> }[] = [];
	let offset = 0;
	let entered = false;

	for (let i = 0; i < children.length; i++) {
		const { text, marks } = children[i];
		const length = text.length;
		const end = offset + length;

		if (yStart >= offset && yStart < end) {
			// Found start of range
			entered = true;
			const startOffset = yStart - offset;
			const endOffset = Math.min(length, yEnd - offset);
			result.push({
				text: text.slice(startOffset, endOffset),
				marks: new Map(marks)
			});
		} else if (entered && end <= yEnd) {
			// Middle of range
			result.push({
				text,
				marks: new Map(marks)
			});
		} else if (entered && offset < yEnd && yEnd <= end) {
			// End of range
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

describe('check if mark exists', () => {
	it('should work', () => {
		const content = [
			{ text: 'H', marks: new Map([['bold', true]]) },
			{ text: 'ello W', marks: new Map([['italic', true]]) },
			{ text: 'orld', marks: new Map([['bold', true]]) }
		];
		const attributes_1 = getAttributesAtRange(content, 1, 7);
		expect(attributes_1).toEqual({ italic: true });
		const attributes_2 = getAttributesAtRange(content, 1, 8);
		expect(attributes_2).toEqual({ bold: true, italic: true });
		const attributes_3 = getAttributesAtRange(content, 1, 2);
		expect(attributes_3).toEqual({ italic: true });
		const attributes_4 = getAttributesAtRange(content, 1, 9);
		expect(attributes_4).toEqual({ bold: true, italic: true });

		// Test getMarksAtRange
		const range1 = getMarksAtRange(content, 1, 7);
		expect(range1).toEqual([{ text: 'ello W', marks: new Map([['italic', true]]) }]);

		const range2 = getMarksAtRange(content, 1, 8);
		expect(range2).toEqual([
			{ text: 'ello W', marks: new Map([['italic', true]]) },
			{ text: 'o', marks: new Map([['bold', true]]) }
		]);

		const range3 = getMarksAtRange(content, 0, 3);
		expect(range3).toEqual([
			{ text: 'H', marks: new Map([['bold', true]]) },
			{ text: 'el', marks: new Map([['italic', true]]) }
		]);
	});
});
