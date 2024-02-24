import { describe, it, expect, should } from 'vitest';
import * as Y from 'yjs';

const doc = new Y.Doc();
const text = doc.getText('test');
text.insert(0, 'Hello');
describe('sum test', () => {
	it('Should be hello', () => {
		console.log(text.toString());
		expect(text.toString()).toBe('Hello');
	});

	it('should format', () => {
		text.format(0, 1, { bold: true });
		text.format(0, 3, { italic: true });
		console.log(text.toJSON(), text.toDelta());

		text.format(0, 3, { italic: null });
		console.log(text.toJSON(), text.toDelta());
	});
	it('should copy', () => {
		text.format(0, 1, { bold: true });
		text.format(0, 3, { italic: true });
		const clone = text.clone();
		clone.doc = text.doc;
		clone.applyDelta(text.toDelta());
		console.log(clone.toDelta(), text.toDelta());
	});
});
