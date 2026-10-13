/** @jsxImportSource ../../jsx */
/**
 * Properties as plain state: `block.data`, `atom.data` and `edytor.data`
 * are deep proxies. A write at any depth is a patch at that path (only that
 * leaf changes); the writes of one task are one `patchData` operation (one
 * undo step, one transaction) dispatched at the task's end; a readonly view
 * refuses at once and nothing throws; a remote change, a remote delete
 * included, re-renders. Expected values come from the properties page.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { createDocument, loadDocument, type EdytorDocument } from '$lib/crdt/index.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { mentionPlugin } from '../../atMention.svelte';
import { propsPlugin } from '../../dom/PropsKind.svelte';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';
import { richTextPlugin } from '$registry/edytor/chrome/plugins.js';

const value = {
	children: [
		{
			id: 'c',
			type: 'card',
			data: { title: 'One', tags: ['a'], meta: { author: { name: 'Bob' } } },
			content: [{ text: 'body' }]
		},
		{
			id: 'p',
			type: 'paragraph',
			content: [{ text: 'hi ' }, { id: 'm', type: 'mention', data: { name: 'ann' } }]
		}
	]
};
const plugins = [propsPlugin, richTextPlugin, mentionPlugin];
const settle = () => Promise.resolve();
/** Every `patchData` a hook sees, as `[target, patches]`. */
const spying = () => {
	const seen: unknown[] = [];
	const spy: Plugin = () => ({
		onBeforeOperation: ({ operation, payload }) => {
			if (operation === 'patchData') seen.push(payload);
		}
	});
	return { seen, spy };
};
const commitsOf = (edytor: Edytor) => {
	let n = 0;
	edytor.doc.on('update', () => n++);
	return () => n;
};
const RELAY = Symbol('relay');
const pair = (): [EdytorDocument, EdytorDocument] => {
	const a = createDocument({ value, history: { captureTimeout: 0 } });
	const b = loadDocument(a.encode(), { history: { captureTimeout: 0 } });
	for (const [from, to] of [
		[a, b],
		[b, a]
	] as const)
		from.doc.on('update', (u: Uint8Array, origin: unknown) => {
			if (origin !== RELAY) Y.applyUpdate(to.doc as never, u, RELAY);
		});
	return [a, b];
};

describe('a deep write is a patch at its path', () => {
	it('block.data.meta.author.name = … patches that leaf only, and reads back at once', async () => {
		const { seen, spy } = spying();
		const { edytor } = await renderDomEdytor(<root />, { value, plugins: [spy, ...plugins] });
		const block = edytor.idToBlock.block('c');
		block.data.meta.author.name = 'Ada';
		expect(block.data.meta.author.name).toBe('Ada');
		await settle();
		expect(seen).toEqual([['c', [{ path: ['meta', 'author', 'name'], value: 'Ada' }]]]);
		expect(edytor.facade.blockDataOf('c')).toEqual({
			title: 'One',
			tags: ['a'],
			meta: { author: { name: 'Ada' } }
		});
	});

	it('a proxy keeps its identity per path, and reads out as plain JSON', async () => {
		const { edytor } = await renderDomEdytor(<root />, { value, plugins });
		const block = edytor.idToBlock.block('c');
		expect(block.data).toBe(block.data);
		expect(block.data.meta).toBe(block.data.meta);
		expect(edytor.data).toBe(edytor.idToBlock.root.data);
		expect(JSON.parse(JSON.stringify(block.data))).toEqual(value.children[0]!.data);
		expect(structuredClone(JSON.parse(JSON.stringify(block.data.tags)))).toEqual(['a']);
	});

	it('delete removes the key; assigning an equal value writes nothing', async () => {
		const { seen, spy } = spying();
		const { edytor } = await renderDomEdytor(<root />, { value, plugins: [spy, ...plugins] });
		const commits = commitsOf(edytor);
		const block = edytor.idToBlock.block('c');
		block.data.title = 'One';
		block.data.meta = { author: { name: 'Bob' } };
		block.data.tags[0] = 'a';
		delete block.data.missing;
		await settle();
		expect(seen).toEqual([]);
		expect(commits()).toBe(0);
		delete block.data.title;
		expect('title' in block.data).toBe(false);
		await settle();
		expect(seen).toEqual([['c', [{ path: ['title'] }]]]);
		expect(edytor.facade.blockDataOf('c')?.title).toBeUndefined();
	});
});

describe('one task, one operation', () => {
	it('a burst on one block is one patchData, one transaction, one undo step', async () => {
		const { seen, spy } = spying();
		const { edytor } = await renderDomEdytor(<root />, { value, plugins: [spy, ...plugins] });
		const commits = commitsOf(edytor);
		const block = edytor.idToBlock.block('c');
		block.data.color = 'red';
		block.data.meta.author.name = 'Ada';
		block.data.tags.push('x');
		await settle();
		expect(seen).toHaveLength(1);
		expect(commits()).toBe(1);
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'patchData', status: 'applied' });
		expect(edytor.facade.blockDataOf('c')).toEqual({
			title: 'One',
			color: 'red',
			tags: ['a', 'x'],
			meta: { author: { name: 'Ada' } }
		});
		edytor.historyUndo();
		expect(edytor.facade.blockDataOf('c')).toEqual(value.children[0]!.data);
		edytor.historyRedo();
		expect(edytor.facade.blockDataOf('c')?.color).toBe('red');
	});

	it('a burst over a block, an atom and the document is one transaction and one undo step', async () => {
		const { edytor } = await renderDomEdytor(<root />, { value, plugins });
		const commits = commitsOf(edytor);
		edytor.idToBlock.block('c').data.title = 'Two';
		edytor.atomAt('p', 'm')!.data.name = 'bob';
		edytor.data.title = 'Doc';
		await settle();
		expect(commits()).toBe(1);
		expect(edytor.facade.blockDataOf('c')?.title).toBe('Two');
		expect(edytor.atomAt('p', 'm')!.value.data).toEqual({ name: 'bob' });
		expect(edytor.facade.docData()).toEqual({ title: 'Doc' });
		edytor.historyUndo();
		expect(edytor.facade.blockDataOf('c')?.title).toBe('One');
		expect(edytor.atomAt('p', 'm')!.value.data).toEqual({ name: 'ann' });
		expect(edytor.facade.docData()).toEqual({});
	});

	it('the next task is its own step; an operation in the same task goes after the queued writes', async () => {
		const { edytor } = await renderDomEdytor(<root />, { value, plugins });
		const block = edytor.idToBlock.block('c');
		block.data.title = 'Two';
		await settle();
		block.data.title = 'Three';
		edytor.setBlock('c', { type: 'card' }); // flushes 'Three' first
		await settle();
		edytor.historyUndo();
		expect(block.data.title).toBe('Two');
		edytor.historyUndo();
		expect(block.data.title).toBe('One');
	});
});

describe('admission', () => {
	it('a readonly view refuses an assignment at once: nothing queued, nothing thrown', async () => {
		const { edytor } = await renderDomEdytor(<root />, { value, plugins, readonly: true });
		const commits = commitsOf(edytor);
		const block = edytor.idToBlock.block('c');
		expect(() => (block.data.meta.author.name = 'Ada')).not.toThrow();
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'patchData', status: 'refused' });
		edytor.data.title = 'x';
		expect(edytor.dispatcher.last?.status).toBe('refused');
		edytor.atomAt('p', 'm')!.data.name = 'x';
		expect(edytor.dispatcher.last?.status).toBe('refused');
		await settle();
		expect(commits()).toBe(0);
		expect(block.data.meta.author.name).toBe('Bob');
	});

	it('a veto drops the burst, and the proxy reads the document again', async () => {
		const veto: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				if (operation === 'patchData') prevent();
			}
		});
		const { edytor } = await renderDomEdytor(<root />, { value, plugins: [veto, ...plugins] });
		const block = edytor.idToBlock.block('c');
		block.data.title = 'x';
		expect(block.data.title).toBe('x');
		await settle();
		expect(edytor.dispatcher.last?.status).toBe('refused');
		expect(block.data.title).toBe('One');
	});
});

describe('remote changes', () => {
	it('re-render a reader, and a key deleted remotely disappears', async () => {
		const [a, b] = pair();
		const one = await renderDomEdytor(<root />, { document: a, value, plugins });
		const two = await renderDomEdytor(<root />, { document: b, value, plugins });
		const title = one.editor.querySelector<HTMLInputElement>('[data-card-title]')!;
		two.edytor.idToBlock.block('c').data.title = 'Remote';
		await settle();
		await flushDomUpdates();
		expect(title.value).toBe('Remote');
		expect(one.edytor.idToBlock.block('c').data.title).toBe('Remote');
		delete two.edytor.idToBlock.block('c').data.title;
		two.edytor.data.title = 'Doc';
		await settle();
		await flushDomUpdates();
		expect(title.value).toBe('');
		expect(Object.keys(one.edytor.idToBlock.block('c').data)).not.toContain('title');
		expect(one.edytor.data.title).toBe('Doc');
	});
});
