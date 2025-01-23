import { describe, it, expect, should } from 'vitest';
import * as Y from 'yjs';
import type { JSONDelta, SerializableContent } from './lib/utils/json.ts';

// Move helper functions outside to avoid recreation on each call
const createDelta = (text: string, attributes: Map<string, SerializableContent>): JSONDelta => {
	const size = attributes.size;
	if (size === 0) {
		return { text, marks: [] };
	}

	const marks: [string, SerializableContent][] = new Array(size);
	let i = 0;
	attributes.forEach((value, key) => {
		marks[i++] = [key, value];
	});
	return { text, marks };
};

const toDeltas = (text: Y.Text) => {
	const result: JSONDelta[] = [];
	const currentAttributes = new Map<string, SerializableContent>();
	let currentString = '';
	let n = text._start;

	// Local function that captures currentString and result
	const flushString = () => {
		if (currentString) {
			result.push(createDelta(currentString, currentAttributes));
			currentString = '';
		}
	};

	while (n !== null) {
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
			flushString();
			const format = content as Y.ContentFormat;
			const { key, value } = format;
			if (value === null) {
				currentAttributes.delete(key);
			} else {
				currentAttributes.set(key, value as SerializableContent);
			}
		}

		n = n.right;
	}

	flushString();
	return result;
};

const doc = new Y.Doc();
const content = doc.getXmlFragment('content');
const text = new Y.XmlText('hello');
content.insert(0, [text]);

// text.format(0, 5, { bold: true });
text.format(0, 1, {
	italic: {
		hello: 3123
	}
});

describe('sum test', () => {
	it('should work', () => {
		console.log(JSON.stringify(text.toDelta(), null, 2));

		const ops = toDeltas(text);
		console.log('=====');
		console.log(JSON.stringify(ops, null, 2));
	});
});
