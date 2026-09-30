/**
 * FX-11 (client side): a document's `transact(fn)` is one transaction and
 * one undo step, but not a rollback: a throw from `fn` keeps the writes
 * made before it (documents.mdx says so). The room's `transact` does the
 * same (tests/do/review-20260930-fx.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { createDocument } from '$lib/crdt/index.js';

describe('FX-11: document.transact keeps the writes made before a throw', () => {
	it('the partial write stays, and is one update', () => {
		const document = createDocument({
			value: { children: [{ id: 'p', type: 'paragraph', content: [{ text: 'hello' }] }] }
		});
		let updates = 0;
		document.doc.on('update', () => updates++);
		expect(() =>
			document.transact(() => {
				document.facade.insertText('p', 5, '!');
				throw new Error('fn failed');
			})
		).toThrow('fn failed');
		expect([document.facade.blockText('p'), updates]).toEqual(['hello!', 1]);
		document.destroy();
	});
});
