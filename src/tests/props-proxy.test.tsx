/** @jsxImportSource ./jsx */
/**
 * The data proxy on a headless view: the writes of one task are one
 * dispatched `patchData` (one undo step) with the right pointer patches,
 * array methods patch only their items, and a readonly view refuses at
 * once. Expected values are hand-authored from the properties page.
 */
import { describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import { createTestEdytor, defaultPlugins } from './test.utils.js';

const value = {
	children: [
		{
			id: 'c',
			type: 'paragraph',
			data: { meta: { author: { name: 'Bob' } }, tags: ['b', 'a'] },
			content: [{ text: 'x' }]
		}
	]
};
const settle = () => Promise.resolve();

describe('block.data on a headless view', () => {
	it('one task: one patchData of pointer patches, one undo step', async () => {
		const seen: unknown[] = [];
		const spy: Plugin = () => ({
			onBeforeOperation: ({ operation, payload }) => {
				if (operation === 'patchData') seen.push(payload);
			}
		});
		const { edytor } = createTestEdytor(<root />, { value, plugins: [spy, ...defaultPlugins] });
		const data = edytor.idToBlock.block('c').data;
		data.meta.author.name = 'Ada';
		data.tags.sort();
		data.tags.push('c');
		data.tags.pop();
		expect([...data.tags]).toEqual(['a', 'b']);
		await settle();
		expect(seen).toEqual([
			[
				'c',
				[
					{ path: ['meta', 'author', 'name'], value: 'Ada' },
					{ path: ['tags'], order: [1, 0] },
					{ path: ['tags'], splice: [2, 0, 'c'] },
					{ path: ['tags'], splice: [2, 1] }
				]
			]
		]);
		expect(edytor.facade.blockDataOf('c')).toEqual({
			meta: { author: { name: 'Ada' } },
			tags: ['a', 'b']
		});
		edytor.historyUndo();
		expect(edytor.facade.blockDataOf('c')).toEqual(value.children[0]!.data);
	});

	it('a readonly view refuses at once and writes nothing', async () => {
		const { edytor } = createTestEdytor(<root />, { value, readonly: true });
		edytor.idToBlock.block('c').data.tags.push('z');
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'patchData', status: 'refused' });
		await settle();
		expect(edytor.facade.blockDataOf('c')).toEqual(value.children[0]!.data);
	});
});
