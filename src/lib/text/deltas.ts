// This is an adaptation of the toDeltas function of the yjs library that better suits our needs
import * as Y from 'yjs';
import type { JSONText, SerializableContent } from '../utils/json.ts';

export type Mark = [string, SerializableContent];
export type JSONDelta = {
	text: string;
	marks: Mark[];
	id: string;
};

export const jsonToDelta = (text: JSONText[]): JSONDelta[] => {
	return text.map((t) => ({
		text: t.text,
		marks: Object.entries(t.marks || {}),
		id: crypto.randomUUID()
	}));
};

export const deltaToJson = (delta: JSONDelta[]): JSONText[] => {
	return delta.map((d) => ({
		text: d.text,
		marks: Object.fromEntries(d.marks)
	}));
};

const createDelta = (text: string, attributes: Map<string, SerializableContent>): JSONDelta => {
	const size = attributes.size;
	if (size === 0) {
		return { text, marks: [], id: crypto.randomUUID() };
	}

	const marks: [string, SerializableContent][] = new Array(size);
	let i = 0;
	attributes.forEach((value, key) => {
		marks[i++] = [key, value];
	});
	return { text, marks, id: crypto.randomUUID() };
};

const areMarksEqual = (
	marks1: Map<string, SerializableContent>,
	marks2: Map<string, SerializableContent>
): boolean => {
	if (marks1.size !== marks2.size) return false;
	for (const [key, value] of marks1) {
		if (!marks2.has(key) || marks2.get(key) !== value) return false;
	}
	return true;
};

export const toDeltas = (text: Y.Text) => {
	const result: JSONDelta[] = [];
	if (!text) {
		return [result, true] as const;
	}
	const currentAttributes = new Map<string, SerializableContent>();
	let currentString = '';
	let n = text._start;
	let isEmpty = true;
	const flushString = () => {
		if (currentString) {
			const newDelta = createDelta(currentString, currentAttributes);

			// Check if we can merge with the previous delta
			const lastDelta = result[result.length - 1];
			if (lastDelta && lastDelta.marks.length === newDelta.marks.length) {
				const lastDeltaMarks = new Map(lastDelta.marks);
				const newDeltaMarks = new Map(newDelta.marks);

				if (areMarksEqual(lastDeltaMarks, newDeltaMarks)) {
					// Merge the text with the previous delta
					lastDelta.text += currentString;
				} else {
					result.push(newDelta);
				}
			} else {
				result.push(newDelta);
			}

			currentString = '';
			isEmpty = false;
		}
	};

	while (n) {
		if (!n.deleted) {
			const content = n.content;
			const contentType = content.constructor;

			if (contentType === Y.ContentString) {
				// Check ychange first to minimize map lookups
				if (currentAttributes.has('ychange')) {
					flushString();
					currentAttributes.delete('ychange');
				}
				currentString += (content as Y.ContentString).str;
			} else if (contentType === Y.ContentType || contentType === Y.ContentEmbed) {
				flushString();
				result.push(createDelta(String(content.getContent()[0]), currentAttributes));
			} else if (contentType === Y.ContentFormat) {
				if (!n.deleted) {
					flushString();
					const format = content as Y.ContentFormat;
					const { key, value } = format;
					if (value === null) {
						currentAttributes.delete(key);
					} else {
						currentAttributes.set(key, value as SerializableContent);
					}
				}
			}
		}
		n = n.right;
	}

	flushString();
	return [result, isEmpty] as const;
};
