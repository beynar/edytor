/**
 * The data proxy over a bare document (`document.data`): a write at any
 * depth is the raw `patchData` at that path, so two replicas editing
 * different deep leaves both keep their edit once they exchange updates,
 * in either delivery order. Expected values are hand-authored.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { createDocument, loadDocument } from '../../../lib/crdt/index.js';

const seed = {
	children: [],
	data: { meta: { author: { name: 'Bob', age: 1 } }, tags: ['a', 'b'] }
};
const twins = () => {
	const a = createDocument({ value: seed });
	const b = loadDocument(a.encode());
	return [a, b] as const;
};
const exchange = (x: ReturnType<typeof twins>[number], y: typeof x, yFirst: boolean) => {
	const ux = Y.encodeStateAsUpdate(x.doc as never);
	const uy = Y.encodeStateAsUpdate(y.doc as never);
	if (yFirst) Y.applyUpdate(x.doc as never, uy);
	Y.applyUpdate(y.doc as never, ux);
	if (!yFirst) Y.applyUpdate(x.doc as never, uy);
};

describe('document.data: deep writes are raw patches of their leaf', () => {
	it('writes at once and reads plain', () => {
		const [a] = twins();
		a.data.meta.author.name = 'Ada';
		a.data.tags.push('c');
		delete a.data.meta.author.age;
		expect(a.docData()).toEqual({ meta: { author: { name: 'Ada' } }, tags: ['a', 'b', 'c'] });
		expect(JSON.parse(JSON.stringify(a.data))).toEqual(a.docData());
	});

	it.each([false, true])(
		'two replicas editing different deep leaves merge (b first: %s)',
		(bFirst) => {
			const [a, b] = twins();
			a.data.meta.author.name = 'Ada';
			b.data.meta.author.age = 2;
			a.data.tags[0] = 'A';
			b.data.tags.push('c');
			exchange(a, b, bFirst);
			const want = { meta: { author: { name: 'Ada', age: 2 } }, tags: ['A', 'b', 'c'] };
			expect(a.docData()).toEqual(want);
			expect(b.docData()).toEqual(want);
			expect(a.data.meta.author.age).toBe(2);
		}
	);
});
