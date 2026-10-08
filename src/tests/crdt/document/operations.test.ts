/**
 * The document's operations are its own members (`DocumentOperations`):
 * every name `DOCUMENT_OPERATIONS` lists reads through to the bound
 * facade (`document.facade`, internal since `1.0.0-rc.2`), so
 * `document.insertBlock(…)` writes exactly as the binding does.
 */
import { describe, expect, it } from 'vitest';
import { createDocument } from '$lib/crdt/document.js';
import { DOCUMENT_OPERATIONS } from '$lib/crdt/operations.js';

describe('document.operations', () => {
	it('every listed operation is the document’s own member', () => {
		const document = createDocument();
		for (const name of DOCUMENT_OPERATIONS) expect(document[name], name).toBeDefined();
	});

	it('writes and reads through the document, as through its internal binding', () => {
		const document = createDocument({
			value: { children: [{ id: 'p1', type: 'paragraph', content: [{ text: 'hello' }] }] }
		});
		expect(document.insertText('p1', 5, ' world')).toMatchObject({ status: 'applied' });
		expect(document.blockText('p1')).toBe('hello world');
		const before = document.version;
		document.insertBlock({ parent: null, index: 1 }, { id: 'p2', type: 'paragraph' });
		expect(document.version).not.toBe(before);
		expect(document.childrenIds(null)).toEqual(['p1', 'p2']);
		const plan = document.prepare.setBlockType('p2', 'heading');
		expect(document.apply(plan)).toMatchObject({ status: 'applied' });
		expect(document.facade.blockTypeOf('p2')).toBe('heading');
		expect(document.toJSON()).toEqual(document.facade.toJSON());
	});

	it('transact groups writes in one change, with the document’s origin by default', () => {
		const document = createDocument({
			value: { children: [{ id: 'p1', type: 'paragraph', content: [{ text: '' }] }] }
		});
		const changes: boolean[] = [];
		const off = document.onChange((change) => changes.push(change.local));
		document.transact(() => {
			document.insertText('p1', 0, 'a');
			document.insertText('p1', 1, 'b');
		});
		off();
		expect(changes).toEqual([true]);
		expect(document.blockText('p1')).toBe('ab');
	});
});
