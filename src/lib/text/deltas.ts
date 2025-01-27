// This is an adaptation of the toDeltas function of the yjs library that better suits our needs
import * as Y from 'yjs';
import type { SerializableContent } from '../utils/json.ts';

export type Mark = [string, SerializableContent];
export type JSONDelta = {
	text: string;
	marks: Mark[];
	id: string;
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
			result.push(createDelta(currentString, currentAttributes));
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
