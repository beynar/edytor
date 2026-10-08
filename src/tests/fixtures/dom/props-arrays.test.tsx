/** @jsxImportSource ../../jsx */
/**
 * Fine-grained arrays through the properties proxy (0.1.0-next.7): every
 * array method, index or `length` write is one `patchData` command (one
 * undo step, shown to hooks, refused readonly) that touches only the items
 * it names, so `{#each}` rows bound into items edit synced data and two
 * views' concurrent edits of different items both land. Expected values
 * come from the properties page, never from running the code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/svelte';
import { snapshot } from '../../dom/snapshot.svelte.js';
import { Y } from '$lib/crdt/engine.js';
import { createDocument, loadDocument, type EdytorDocument } from '$lib/crdt/index.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { JSONDoc } from '$lib/utils/json.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { propsPlugin } from '../../dom/PropsKind.svelte';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

const tasks = [
	{ title: 'a', done: false },
	{ title: 'b', done: false }
];
const value = {
	children: [
		{ id: 't', type: 'tasks', data: { tasks, tags: ['p', 'q'] }, content: [{ text: 'body' }] }
	]
};
const plugins = [propsPlugin, richTextPlugin];
const q = (root: ParentNode, selector: string) => root.querySelector<HTMLInputElement>(selector)!;
const dataOf = (edytor: Edytor) => edytor.facade.blockDataOf('t');

/** Two replicas of `value`; each one's updates wait until `deliver()`. */
const held = (from: JSONDoc = value): [EdytorDocument, EdytorDocument, () => void] => {
	const a = createDocument({ value: from, history: { captureTimeout: 0 } });
	const b = loadDocument(a.encode(), { history: { captureTimeout: 0 } });
	const queues = new Map<EdytorDocument, Uint8Array[]>([
		[a, []],
		[b, []]
	]);
	const REMOTE = Symbol('remote');
	for (const d of [a, b])
		d.doc.on('update', (u: Uint8Array, origin: unknown) => {
			if (origin !== REMOTE) queues.get(d)!.push(u);
		});
	const deliver = () => {
		for (const [from, to] of [
			[a, b],
			[b, a]
		] as const)
			for (const u of queues.get(from)!.splice(0)) Y.applyUpdate(to.doc as never, u, REMOTE);
	};
	return [a, b, deliver];
};

describe('the JSON boundary warns only for values that are not JSON (2026-10-01 review)', () => {
	// First in the file: the boundary warns once per distinct report, so a
	// write earlier in this module would hide the warning these rows look for.
	afterEach(() => vi.restoreAllMocks());

	it('a set, a delete, an array method and a move log nothing', async () => {
		const warn = vi.spyOn(console, 'warn');
		const { edytor } = await renderDomEdytor(<root />, { value, plugins });
		const data = edytor.idToBlock.block('t').data as Record<string, any>;
		data.title = 'x';
		delete data.title;
		data.tags.push('r');
		data.tags.splice(0, 1);
		data.tags.sort();
		data.tasks[0].done = true;
		data.tags.length = 4;
		expect(edytor.dispatcher.last?.status).toBe('applied');
		expect(warn).not.toHaveBeenCalled();
	});

	it('a Date through the proxy becomes its string silently; a headless one warns once', async () => {
		const warn = vi.spyOn(console, 'warn');
		const { edytor } = await renderDomEdytor(<root />, { value, plugins });
		const data = edytor.idToBlock.block('t').data as Record<string, any>;
		data.when = new Date(0);
		expect(data.when).toBe('1970-01-01T00:00:00.000Z');
		expect(warn).not.toHaveBeenCalled();
		for (const at of [0, 1]) edytor.facade.patchData('t', [{ path: ['at'], value: new Date(at) }]);
		expect(edytor.facade.blockDataOf('t')?.at).toBe('1970-01-01T00:00:00.001Z');
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]![0])).toContain('$.value: Date');
	});
});

describe('array methods are one command and one undo step each', () => {
	const steps: [string, (tags: string[]) => unknown, (string | null)[], unknown][] = [
		['push', (t) => t.push('r', 's'), ['p', 'q', 'r', 's'], { splice: [2, 0, 'r', 's'] }],
		['pop', (t) => t.pop(), ['p'], { splice: [1, 1] }],
		['shift', (t) => t.shift(), ['q'], { splice: [0, 1] }],
		['unshift', (t) => t.unshift('o'), ['o', 'p', 'q'], { splice: [0, 0, 'o'] }],
		['splice', (t) => t.splice(-1, Infinity, 'z'), ['p', 'z'], { splice: [1, 1, 'z'] }],
		['sort', (t) => t.sort((x, y) => (x < y ? 1 : -1)), ['q', 'p'], { order: [1, 0] }],
		['reverse', (t) => t.reverse(), ['q', 'p'], { order: [1, 0] }],
		['fill', (t) => t.fill('f', 1), ['p', 'f'], { path: ['tags', '1'], value: 'f' }],
		['index', (t) => (t[1] = 'Q'), ['p', 'Q'], { value: 'Q' }],
		['length', (t) => (t.length = 3), ['p', 'q', null], { splice: [2, 0, null] }]
	];

	it.each(steps)('%s', async (_, write, after, op) => {
		const seen: unknown[] = [];
		const spy: Plugin = () => ({
			onBeforeOperation: ({ operation, payload }) => {
				if (operation === 'patchData') seen.push(payload);
			}
		});
		const { edytor } = await renderDomEdytor(<root />, { value, plugins: [spy, ...plugins] });
		const block = edytor.idToBlock.block('t');
		write(block.data.tags);
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'patchData', status: 'applied' });
		expect(seen).toHaveLength(1);
		expect((seen[0] as { ops: unknown[] }).ops[0]).toMatchObject(op as object);
		expect([...block.data.tags]).toEqual(after);
		expect(dataOf(edytor)?.tasks).toEqual(tasks);
		edytor.historyUndo();
		expect([...block.data.tags]).toEqual(['p', 'q']);
		edytor.historyRedo();
		expect([...block.data.tags]).toEqual(after);
	});

	it('a write inside an item patches that item: one step, and the others stay', async () => {
		const { edytor } = await renderDomEdytor(<root />, { value, plugins });
		const list = edytor.idToBlock.block('t').data.tasks;
		list[1].done = true;
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'patchData', status: 'applied' });
		expect(dataOf(edytor)?.tasks).toEqual([tasks[0], { title: 'b', done: true }]);
		list.push({ title: 'c', done: false });
		list[2].title = 'C';
		expect(JSON.stringify(list)).toBe(
			'[{"done":false,"title":"a"},{"done":true,"title":"b"},{"done":false,"title":"C"}]'
		);
		expect(structuredClone(snapshot(list))).toEqual(dataOf(edytor)?.tasks);
		edytor.historyUndo();
		edytor.historyUndo();
		expect(dataOf(edytor)?.tasks).toEqual([tasks[0], { title: 'b', done: true }]);
	});
});

describe('{#each} rows bound into items', () => {
	it('a checkbox and a text field write their own item; typing is one undo step', async () => {
		const { edytor, editor } = await renderDomEdytor(<root />, {
			document: createDocument({ value, history: { captureTimeout: 60_000 } }),
			value,
			plugins
		});
		await fireEvent.click(q(editor, '[data-task-done="1"]'));
		expect(dataOf(edytor)?.tasks).toEqual([tasks[0], { title: 'b', done: true }]);
		const title = q(editor, '[data-task-title="0"]');
		for (const typed of ['ab', 'abc', 'ab', 'abd']) {
			title.value = typed;
			await fireEvent.input(title);
		}
		expect((dataOf(edytor)?.tasks as { title: string }[])[0]!.title).toBe('abd');
		edytor.historyUndo();
		expect(dataOf(edytor)?.tasks).toEqual([tasks[0], { title: 'b', done: true }]);
	});

	it('two views’ concurrent edits of different items both land, and both views show them', async () => {
		const [a, b, deliver] = held();
		const one = await renderDomEdytor(<root />, { document: a, value, plugins });
		const two = await renderDomEdytor(<root />, { document: b, value, plugins });
		await fireEvent.click(q(one.editor, '[data-task-done="0"]'));
		const title = q(two.editor, '[data-task-title="1"]');
		title.value = 'B';
		await fireEvent.input(title);
		// And a concurrent push in view two, a move in view one.
		two.edytor.idToBlock.block('t').data.tasks.push({ title: 'c', done: false });
		one.edytor.idToBlock.block('t').data.tags.reverse();
		deliver();
		await flushDomUpdates();
		const want = {
			tasks: [
				{ title: 'a', done: true },
				{ title: 'B', done: false },
				{ title: 'c', done: false }
			],
			tags: ['q', 'p']
		};
		for (const { edytor, editor } of [one, two]) {
			expect(dataOf(edytor)).toEqual(want);
			expect(q(editor, '[data-task-done="0"]').checked).toBe(true);
			expect(q(editor, '[data-task-title="1"]').value).toBe('B');
			expect(q(editor, '[data-task-title="2"]').value).toBe('c');
		}
	});
});

describe('a row keyed by its item stays on it (DR-arrays-2)', () => {
	it('a peer’s insert above the focused row leaves the typing on its item', async () => {
		const [a, b, deliver] = held();
		const one = await renderDomEdytor(<root />, { document: a, value, plugins });
		const two = await renderDomEdytor(<root />, { document: b, value, plugins });
		const title = q(one.editor, '[data-task-title="1"]');
		title.focus();
		title.value = 'bX';
		await fireEvent.input(title);
		two.edytor.idToBlock.block('t').data.tasks.unshift({ title: 'new', done: false });
		deliver();
		await flushDomUpdates();
		expect(title.isConnected).toBe(true);
		expect(title.value).toBe('bX');
		expect(title.dataset.taskTitle).toBe('2');
		title.value = 'bXY';
		await fireEvent.input(title);
		deliver();
		await flushDomUpdates();
		for (const { edytor } of [one, two])
			expect(dataOf(edytor)?.tasks).toEqual([
				{ title: 'new', done: false },
				tasks[0],
				{ title: 'bXY', done: false }
			]);
	});

	it('an item held across a peer’s move edits that item; once removed, its writes are refused', async () => {
		const [a, b, deliver] = held();
		const one = await renderDomEdytor(<root />, { document: a, value, plugins });
		const two = await renderDomEdytor(<root />, { document: b, value, plugins });
		const list = one.edytor.idToBlock.block('t').data.tasks;
		const second = list[1];
		expect(list[1]).toBe(second);
		two.edytor.idToBlock.block('t').data.tasks.reverse();
		deliver();
		await flushDomUpdates();
		expect(list[0]).toBe(second);
		second.done = true;
		expect(dataOf(one.edytor)?.tasks).toEqual([{ title: 'b', done: true }, tasks[0]]);
		list.splice(0, 1);
		second.title = 'gone';
		expect(one.edytor.dispatcher.last?.status).toBe('refused');
		expect(dataOf(one.edytor)?.tasks).toEqual([tasks[0]]);
	});
});

describe('admission', () => {
	it('a veto refuses an array op and writes nothing', async () => {
		const frozen: Plugin = () => ({
			onBeforeOperation: ({ operation, payload, prevent }) => {
				const ops = (payload as { ops: { path: string[] }[] }).ops;
				if (operation === 'patchData' && ops.some((op) => op.path[0] === 'tags')) prevent();
			}
		});
		const { edytor } = await renderDomEdytor(<root />, { value, plugins: [frozen, ...plugins] });
		const tags = edytor.idToBlock.block('t').data.tags;
		for (const write of [() => tags.push('x'), () => tags.sort(), () => (tags[0] = 'x')]) {
			write();
			expect(edytor.dispatcher.last?.status).toBe('refused');
		}
		expect(dataOf(edytor)?.tags).toEqual(['p', 'q']);
	});

	it('a readonly view refuses every array write and writes nothing', async () => {
		const { edytor } = await renderDomEdytor(<root />, { value, plugins, readonly: true });
		let bytes = 0;
		edytor.doc.on('update', () => bytes++);
		const list = edytor.idToBlock.block('t').data.tasks;
		for (const write of [
			() => list.push({ title: 'x', done: false }),
			() => list.splice(0, 1),
			() => list.reverse(),
			() => (list[0].done = true),
			() => (list.length = 0)
		]) {
			write();
			expect(edytor.dispatcher.last?.status).toBe('refused');
		}
		expect(bytes).toBe(0);
		expect(dataOf(edytor)?.tasks).toEqual(tasks);
	});
});

describe('an item held past its removal writes nothing (2026-10-01 review)', () => {
	// `const t = tasks[i]; await upload(); t.src = url`: meanwhile a peer
	// deleted, replaced or emptied the array, or removed the item. The write is
	// refused, the data is unchanged and no `~` id reads as an object key.
	const cards = {
		children: [{ id: 'c', type: 'card', data: { tasks }, content: [{ text: 'body' }] }]
	};
	const itemKey = (v: unknown) => /"~[a-z]/.test(JSON.stringify(v));
	const removals: [string, (data: Record<string, unknown>) => void][] = [
		['deletes the array', (d) => delete d.tasks],
		['replaces it with a string', (d) => (d.tasks = 'none')],
		['replaces it with an object', (d) => (d.tasks = { k: 1 })],
		['empties it', (d) => (d.tasks = [])],
		['removes the item', (d) => (d.tasks as unknown[]).splice(0, 1)],
		[
			'deletes it and pushes a new one',
			(d) => {
				delete d.tasks;
				d.tasks = [{ title: 'n', done: false }];
			}
		]
	];

	it.each(removals)('block data: a peer %s', async (_, remove) => {
		const [a, b, deliver] = held(cards);
		const one = await renderDomEdytor(<root />, { document: a, value: cards, plugins });
		const two = await renderDomEdytor(<root />, { document: b, value: cards, plugins });
		const t = one.edytor.idToBlock.block('c').data.tasks[0];
		remove(two.edytor.idToBlock.block('c').data);
		deliver();
		await flushDomUpdates();
		const before = JSON.stringify(one.edytor.facade.blockDataOf('c'));
		t.title = 'x';
		expect(one.edytor.dispatcher.last?.status).toBe('refused');
		t.done = true;
		delete (t as { title?: string }).title;
		expect(one.edytor.dispatcher.last?.status).not.toBe('applied');
		deliver();
		await flushDomUpdates();
		for (const { edytor } of [one, two]) {
			expect(JSON.stringify(edytor.facade.blockDataOf('c'))).toBe(before);
			expect(itemKey(edytor.facade.blockDataOf('c'))).toBe(false);
		}
	});

	it('document data: a peer deletes the array, then the held item writes nothing', async () => {
		const [a, b, deliver] = held(cards);
		const one = await renderDomEdytor(<root />, { document: a, value: cards, plugins });
		const two = await renderDomEdytor(<root />, { document: b, value: cards, plugins });
		one.edytor.data.tasks = tasks;
		deliver();
		await flushDomUpdates();
		const t = (one.edytor.data.tasks as typeof tasks)[1]!;
		delete two.edytor.data.tasks;
		deliver();
		await flushDomUpdates();
		t.title = 'x';
		expect(one.edytor.dispatcher.last?.status).toBe('refused');
		for (const { edytor } of [one, two]) {
			expect(edytor.facade.docData()).toEqual({});
			expect(itemKey(edytor.facade.docData())).toBe(false);
		}
	});

	it('a key that starts with `~` set through the proxy is a key, read back as itself', async () => {
		const { edytor } = await renderDomEdytor(<root />, { value: cards, plugins });
		const data = edytor.idToBlock.block('c').data as Record<string, any>;
		data['~abc'] = 1;
		data['~x'] = { '~y': [{ '~z': 1 }] };
		data['~x']['~y'][0]['~z'] = 2;
		data['~x']['~y'].push('n');
		expect(edytor.dispatcher.last?.status).toBe('applied');
		expect(data['~abc']).toBe(1);
		expect(JSON.parse(JSON.stringify(data['~x']))).toEqual({ '~y': [{ '~z': 2 }, 'n'] });
		delete data['~abc'];
		expect(edytor.facade.blockDataOf('c')).toEqual({ tasks, '~x': { '~y': [{ '~z': 2 }, 'n'] } });
	});
});
