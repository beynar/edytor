/**
 * H4 (CRDT study 2026-10; contract row `data.retype.keep`): a retype —
 * `setBlock` with a type and data, as Turn into, a markdown shortcut and
 * the slash menu write it — sets the data leaves it names and removes
 * none: a to-do `{checked: true, color: 'red'}` turned into a heading keeps
 * `checked` and `color` and gains the heading's `level` (Notion keeps a
 * block's properties across kinds; a kind ignores the keys it does not
 * read). Replacing the whole data stays `setBlockData` (`block.setData`).
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { converge, replica, seedUpdate } from './p1-harness.js';

const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};
const todo = {
	id: 't',
	type: 'todo-item',
	text: 'buy milk',
	data: { checked: true, color: 'red' }
};

describe('H4: a retype keeps the block’s data', () => {
	it('a to-do turned into a heading keeps checked and color, and gains the level', () => {
		const a = replica('ada', seedUpdate([todo]), 2 ** 26 + 1);
		ok(a.ed.setBlock('t', { type: 'heading', data: { level: 'h1' } }));
		expect(a.ed.blockTypeOf('t')).toBe('heading');
		expect(a.ed.blockDataOf('t')).toEqual({ checked: true, color: 'red', level: 'h1' });
		// And back: the preset's leaf is set again, the rest kept.
		ok(a.ed.setBlock('t', { type: 'todo-item', data: { checked: false } }));
		expect(a.ed.blockDataOf('t')).toEqual({ checked: false, color: 'red', level: 'h1' });
		a.destroy();
	});

	it('setBlock with empty data writes no data; setBlockData still replaces it', () => {
		const a = replica('ada', seedUpdate([todo]), 2 ** 26 + 1);
		ok(a.ed.setBlock('t', { type: 'paragraph', data: {} }));
		expect(a.ed.blockDataOf('t')).toEqual({ checked: true, color: 'red' });
		ok(a.ed.setBlockData('t', { level: 'h2' }));
		expect(a.ed.blockDataOf('t')).toEqual({ level: 'h2' });
		a.destroy();
	});

	it('nested preset data sets its leaves, keeping the object’s other keys', () => {
		const seed = seedUpdate([{ id: 'c', type: 'code', text: '', data: { opts: { wrap: true } } }]);
		const a = replica('ada', seed, 2 ** 26 + 1);
		ok(a.ed.setBlock('c', { type: 'code', data: { opts: { lang: 'ts' } } }));
		expect(a.ed.blockDataOf('c')).toEqual({ opts: { wrap: true, lang: 'ts' } });
		a.destroy();
	});

	it('a key whose value is no object takes the preset’s value whole', () => {
		const seed = seedUpdate([{ id: 'c', text: '', data: { opts: 'x', list: [1, 2], keep: 1 } }]);
		const a = replica('ada', seed, 2 ** 26 + 1);
		ok(a.ed.setBlock('c', { type: 'heading', data: { opts: { lang: 'ts' }, list: { a: 1 } } }));
		expect(a.ed.blockTypeOf('c')).toBe('heading');
		expect(a.ed.blockDataOf('c')).toEqual({ opts: { lang: 'ts' }, list: { a: 1 }, keep: 1 });
		a.destroy();
	});

	it('a retype ‖ a peer’s property write: both kept', () => {
		for (const o of converge([todo], 2, ([a, b]) => {
			ok(a.ed.setBlock('t', { type: 'heading', data: { level: 'h1' } }));
			ok(b.ed.patchData('t', [{ path: ['color'], value: 'blue' }]));
		})) {
			expect(o.problems).toEqual([]);
			expect(o.ed.blockTypeOf('t')).toBe('heading');
			expect(o.ed.blockDataOf('t')).toEqual({ checked: true, color: 'blue', level: 'h1' });
			for (const r of o.reps) r.destroy();
		}
	});
});
