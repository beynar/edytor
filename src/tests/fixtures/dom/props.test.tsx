/** @jsxImportSource ../../jsx */
/**
 * Properties: `block.data`, `atom.data` and `edytor.data` read the
 * document (reactively); a write is the view's `patchData` (readonly
 * admission, hooks and veto, `dispatcher.last`, one undo step; rapid writes
 * of the same paths group like typing); reads re-render snippets on local
 * and remote changes; function bindings edit synced data. Expected values
 * come from the properties page, never from running the code.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/svelte';
import { snapshot } from '../../dom/snapshot.svelte.js';
import { Y } from '$lib/crdt/engine.js';
import { createDocument, loadDocument, type EdytorDocument } from '$lib/crdt/index.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { DataTarget } from '$lib/crdt/index.js';
import type { Plugin } from '$lib/plugins.js';
import { mentionPlugin } from '../../atMention.svelte';
import { propsPlugin } from '../../dom/PropsKind.svelte';
import {
	dispatchClipboardPaste,
	dispatchCopy,
	dispatchCut,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';
import { selectBlocks } from '../../selection.js';
import { richTextPlugin } from '$registry/edytor/chrome/plugins.js';

const value = {
	children: [
		{ id: 'c', type: 'card', data: { title: 'One', tags: ['a'] }, content: [{ text: 'body' }] },
		{
			id: 'p',
			type: 'paragraph',
			content: [{ text: 'hi ' }, { id: 'm', type: 'mention', data: { name: 'ann' } }]
		}
	]
};
const plugins = [propsPlugin, richTextPlugin, mentionPlugin];

const RELAY = Symbol('relay');
/** Two replicas of `value`, each update relayed to the other at once. */
const pair = (captureTimeout = 0): [EdytorDocument, EdytorDocument] => {
	const a = createDocument({ value, history: { captureTimeout } });
	const b = loadDocument(a.encode(), { history: { captureTimeout } });
	const relay = (from: EdytorDocument, to: EdytorDocument) =>
		from.doc.on('update', (update: Uint8Array, origin: unknown) => {
			if (origin !== RELAY) Y.applyUpdate(to.doc as never, update, RELAY);
		});
	relay(a, b);
	relay(b, a);
	return [a, b];
};
const bytesOf = (edytor: Edytor) => {
	let n = 0;
	edytor.doc.on('update', () => n++);
	return () => n;
};
const q = (root: ParentNode, selector: string) => root.querySelector<HTMLInputElement>(selector)!;
/** Set (or, with `undefined`, delete) data key `key` of `target` through the view. */
const set = (edytor: Edytor, target: DataTarget, key: string, value?: unknown) =>
	edytor.patchData(target, [{ path: [key], ...(value !== undefined && { value }) }]);

describe('block.data: read from the document, written with patchData', () => {
	it('a set is one command, one undo step; undo and redo restore it', async () => {
		const { edytor } = await renderDomEdytor(<root />, { value, plugins });
		const block = edytor.idToBlock.block('c');
		set(edytor, 'c', 'title', 'Two');
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'patchData', status: 'applied' });
		expect(block.data.title).toBe('Two');
		expect(edytor.value.children![0]!.data).toEqual({ title: 'Two', tags: ['a'] });
		edytor.historyUndo();
		expect(block.data.title).toBe('One');
		edytor.historyRedo();
		expect(block.data.title).toBe('Two');
	});

	it('rapid writes of the same key are one undo step; another key starts its own', async () => {
		const [document] = pair(60_000);
		const { edytor } = await renderDomEdytor(<root />, { document, value, plugins });
		const block = edytor.idToBlock.block('c');
		for (const title of ['T', 'Ti', 'Tit']) set(edytor, 'c', 'title', title);
		set(edytor, 'c', 'done', true);
		edytor.historyUndo();
		expect({ ...block.data }).toEqual({ title: 'Tit', tags: ['a'] });
		edytor.historyUndo();
		expect({ ...block.data }).toEqual({ title: 'One', tags: ['a'] });
	});

	it('a flag flipped twice is two undo steps, however fast (DR-props-3)', async () => {
		const [document] = pair(60_000);
		const { edytor, editor } = await renderDomEdytor(<root />, { document, value, plugins });
		const done = q(editor, '[data-card-done]');
		await fireEvent.click(done);
		await fireEvent.click(done);
		await flushDomUpdates();
		expect(edytor.facade.blockDataOf('c')?.done).toBe(false);
		edytor.historyUndo();
		expect(edytor.facade.blockDataOf('c')?.done).toBe(true);
		edytor.historyUndo();
		expect(edytor.facade.blockDataOf('c')).toEqual({ title: 'One', tags: ['a'] });
		// The same through the view: a number, a delete and an object are their own steps too.
		const block = edytor.idToBlock.block('c');
		set(edytor, 'c', 'n', 1);
		set(edytor, 'c', 'n', 2);
		edytor.historyUndo();
		expect(block.data.n).toBe(1);
	});

	it('a discrete string value changed twice is two undo steps, however fast', async () => {
		const [document] = pair(60_000);
		const { edytor, editor } = await renderDomEdytor(<root />, { document, value, plugins });
		const status = editor.querySelector<HTMLSelectElement>('[data-card-status]')!;
		for (const next of ['done', 'todo']) {
			status.value = next;
			await fireEvent.change(status);
		}
		await flushDomUpdates();
		expect(edytor.facade.blockDataOf('c')?.status).toBe('todo');
		edytor.historyUndo();
		expect(edytor.facade.blockDataOf('c')?.status).toBe('done');
		edytor.historyUndo();
		expect(edytor.facade.blockDataOf('c')).toEqual({ title: 'One', tags: ['a'] });
		// Through the view: a value sharing only a prefix is another value, not an edit of it.
		const block = edytor.idToBlock.block('c');
		set(edytor, 'c', 'status', 'doing');
		set(edytor, 'c', 'status', 'done');
		edytor.historyUndo();
		expect(block.data.status).toBe('doing');
	});

	it('a patch of an atom writes the atom; a patch of the root replaces the block data', async () => {
		const { edytor } = await renderDomEdytor(<root />, { value, plugins });
		const atom = edytor.atomAt('p', 'm')!;
		set(edytor, { block: 'p', atom: 'm' }, 'name', 'bob');
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'patchData', status: 'applied' });
		expect(atom.data.name).toBe('bob');
		expect(atom.value).toEqual({ id: 'm', type: 'mention', data: { name: 'bob' } });
		edytor.patchData('c', [{ path: [], value: { fresh: true } }]);
		expect({ ...edytor.idToBlock.block('c').data }).toEqual({ fresh: true });
	});

	it('a write to the virtual paragraph of an empty document creates it with that data', async () => {
		const { edytor } = await renderDomEdytor(<root />, { value, plugins });
		edytor.document.facade.deleteBlocks(['c', 'p']);
		await flushDomUpdates();
		const block = edytor.root!.children[0]!;
		expect(edytor.facade.virtual()).toBe(block.id);
		set(edytor, block.id, 'title', 'first');
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'patchData', status: 'applied' });
		expect(edytor.facade.virtual()).toBeNull();
		expect(edytor.document.facade.blockDataOf(block.id)).toEqual({ title: 'first' });
		// The document's own data writes no block.
		edytor.historyUndo();
		set(edytor, null, 'title', 'Doc');
		expect(edytor.facade.virtual()).not.toBeNull();
		expect(edytor.facade.toJSON()).toEqual({ data: { title: 'Doc' }, children: [] });
	});

	it('a patch that fits no value refuses on the virtual paragraph too, and creates nothing (DR-arrays-5)', async () => {
		const { edytor } = await renderDomEdytor(<root />, { value, plugins });
		edytor.document.facade.deleteBlocks(['c', 'p']);
		await flushDomUpdates();
		const block = edytor.root!.children[0]!;
		edytor.patchData(block.id, [{ path: ['tags'], splice: [0, 0, 'x'] }]);
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'patchData', status: 'refused' });
		expect(edytor.facade.virtual()).toBe(block.id);
		expect(edytor.document.facade.toJSON()).toEqual({ children: [] });
	});

	it('a readonly view refuses a write and writes nothing', async () => {
		const { edytor } = await renderDomEdytor(<root />, { value, plugins, readonly: true });
		const bytes = bytesOf(edytor);
		const block = edytor.idToBlock.block('c');
		set(edytor, 'c', 'title', 'x');
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'patchData', status: 'refused' });
		set(edytor, null, 'title', 'x');
		edytor.patchData('c', [{ path: ['tags'], splice: [1, 0, 'b'] }]);
		expect(bytes()).toBe(0);
		expect(block.data.title).toBe('One');
		expect(edytor.data.title).toBeUndefined();
	});

	it('an extension sees the patch and may veto it', async () => {
		const seen: unknown[] = [];
		const lock: Plugin = () => ({
			onBeforeOperation: ({ operation, payload, prevent }) => {
				if (operation !== 'patchData') return;
				seen.push(payload);
				if (payload[1][0]!.path[0] === 'locked') prevent();
			}
		});
		const { edytor } = await renderDomEdytor(<root />, { value, plugins: [lock, ...plugins] });
		const block = edytor.idToBlock.block('c');
		set(edytor, 'c', 'locked', true);
		expect(edytor.dispatcher.last?.status).toBe('refused');
		expect(block.data.locked).toBeUndefined();
		set(edytor, 'c', 'title', 'ok');
		expect(block.data.title).toBe('ok');
		expect(seen).toEqual([
			['c', [{ path: ['locked'], value: true }]],
			['c', [{ path: ['title'], value: 'ok' }]]
		]);
	});
});

describe('the properties page’s validation hook (DR-props-4)', () => {
	// Copied from site/content/docs/concepts/properties.mdx (`src/lib/locked.ts`).
	const locked: Plugin = () => ({
		onBeforeOperation: ({ operation, payload, block, prevent }) => {
			if (operation !== 'patchData' || typeof payload[0] !== 'string') return;
			const was = block.data.locked;
			const changes = (op: (typeof payload)[1][number]) =>
				op.path.length === 0
					? (op.value as { locked?: unknown } | undefined)?.locked !== was
					: op.path[0] === 'locked';
			if (payload[1].some(changes)) prevent();
		}
	});

	it('refuses every write that changes `locked`: a set, a delete, a replacement, setBlock', async () => {
		const locking = { children: [{ ...value.children[0]!, data: { title: 'One', locked: 1 } }] };
		const { edytor } = await renderDomEdytor(<root />, {
			value: locking,
			plugins: [locked, ...plugins]
		});
		const block = edytor.idToBlock.block('c');
		const refused = (write: () => void) => {
			write();
			return edytor.dispatcher.last?.status;
		};
		const replace = (data: Record<string, unknown>) =>
			edytor.patchData('c', [{ path: [], value: data }]);
		expect(refused(() => set(edytor, 'c', 'locked', 2))).toBe('refused');
		expect(refused(() => set(edytor, 'c', 'locked'))).toBe('refused');
		expect(refused(() => replace({ title: 'Two' }))).toBe('refused');
		expect(refused(() => replace({ title: 'Two', locked: 3 }))).toBe('refused');
		expect(refused(() => edytor.setBlock('c', { data: { locked: 4 } }))).toBe('refused');
		expect(edytor.facade.blockDataOf('c')).toEqual({ title: 'One', locked: 1 });
		// A write that keeps it applies.
		expect(refused(() => replace({ title: 'Two', locked: 1 }))).toBe('applied');
		expect(refused(() => set(edytor, 'c', 'title', 'Three'))).toBe('applied');
		expect(edytor.facade.blockDataOf('c')).toEqual({ title: 'Three', locked: 1 });
	});
});

describe('creations carry their properties in insertBlocks (DR-props-4)', () => {
	it('Duplicate and a block paste show the new blocks’ data to hooks', async () => {
		const seen: unknown[] = [];
		const spy: Plugin = () => ({
			onBeforeOperation: ({ operation, payload }) => {
				if (operation === 'insertBlocks') seen.push(...payload[1].map((b) => b.data));
			}
		});
		const { edytor, editor } = await renderDomEdytor(<root />, {
			value,
			plugins: [spy, ...plugins]
		});
		edytor.duplicateBlock('c');
		expect(seen).toEqual([{ title: 'One', tags: ['a'] }]);
		selectBlocks(edytor, edytor.idToBlock.block('c'));
		await flushDomUpdates();
		const copied = await dispatchCopy(editor);
		seen.length = 0;
		await dispatchClipboardPaste(editor, copied.clipboardData);
		expect(seen).toContainEqual({ title: 'One', tags: ['a'] });
	});
});

describe('the snippet re-renders and bound inputs edit synced data', () => {
	it('a peer’s change re-renders the snippet; bind:value and bind:checked write across views', async () => {
		const [a, b] = pair();
		const one = await renderDomEdytor(<root />, { document: a, value, plugins });
		const two = await renderDomEdytor(<root />, { document: b, value, plugins });
		expect(q(two.editor, '[data-card-title]').value).toBe('One');

		// A peer's patch re-renders this view's snippet.
		b.facade.patchData('c', [{ path: ['tags'], value: ['a', 'b'] }]);
		await flushDomUpdates();
		expect(q(one.editor, '[data-card-tags]').textContent).toBe('a,b');

		// Typing into view one's bound field patches the block; view two shows it.
		const title = q(one.editor, '[data-card-title]');
		title.value = 'Typed';
		await fireEvent.input(title);
		await flushDomUpdates();
		expect(one.edytor.dispatcher.last).toMatchObject({ operation: 'patchData', status: 'applied' });
		expect(q(two.editor, '[data-card-title]').value).toBe('Typed');
		expect(b.facade.blockDataOf('c')).toEqual({ title: 'Typed', tags: ['a', 'b'] });

		const done = q(two.editor, '[data-card-done]');
		await fireEvent.click(done);
		await flushDomUpdates();
		expect(q(one.editor, '[data-card-done]').checked).toBe(true);
		expect(a.facade.blockDataOf('c')?.done).toBe(true);
	});

	it('edytor.data is reactive across views and exported with the value', async () => {
		const [a, b] = pair();
		const one = await renderDomEdytor(<root />, { document: a, value, plugins });
		const two = await renderDomEdytor(<root />, { document: b, value, plugins });
		set(one.edytor, null, 'title', 'Notes');
		expect(one.edytor.dispatcher.last).toMatchObject({ operation: 'patchData', status: 'applied' });
		await flushDomUpdates();
		expect(q(two.editor, '[data-card-doc]').textContent).toBe('Notes');
		expect(two.edytor.data.title).toBe('Notes');
		expect(two.edytor.root!.data).toEqual(two.edytor.data);
		expect(two.edytor.value.data).toEqual({ title: 'Notes' });
		one.edytor.historyUndo();
		await flushDomUpdates();
		expect(q(two.editor, '[data-card-doc]').textContent).toBe('');
	});
});

describe('a field in a kind owns its clipboard and drops (DR-props-2)', () => {
	/** An editor range over `bo` of the card's body, then focus in its title field. */
	const inField = async () => {
		const rendered = await renderDomEdytor(<root />, { value, plugins });
		const body = rendered.edytor.idToBlock.block('c').content[0] as never;
		await setNativeSelection(rendered.edytor, body, 0, body, 2);
		const title = q(rendered.editor, '[data-card-title]');
		title.focus();
		await flushDomUpdates();
		return { ...rendered, title, before: rendered.edytor.value };
	};

	it('a paste in the field is the browser’s: the document is unchanged', async () => {
		const { edytor, title, before } = await inField();
		const pasted = await dispatchClipboardPaste(title, { 'text/plain': 'PASTED' });
		expect(pasted.defaultPrevented).toBe(false);
		expect(edytor.value).toEqual(before);
	});

	it('a copy or a cut in the field leaves the clipboard and the document to it', async () => {
		const { edytor, title, before } = await inField();
		const copied = await dispatchCopy(title);
		expect(copied).toEqual({ defaultPrevented: false, clipboardData: {} });
		const cut = await dispatchCut(title);
		expect(cut).toEqual({ defaultPrevented: false, clipboardData: {} });
		expect(edytor.value).toEqual(before);
	});

	it('over a block selection, the field’s keys and paste never act on the selected blocks', async () => {
		const { edytor, editor } = await renderDomEdytor(<root />, { value, plugins });
		selectBlocks(edytor, edytor.idToBlock.block('p'));
		await flushDomUpdates();
		const title = q(editor, '[data-card-title]');
		title.focus();
		const before = edytor.value;
		for (const key of ['Backspace', 'Delete', 'Enter', 'a'])
			expect((await dispatchDomKeyDown(title, { key })).defaultPrevented, key).toBe(false);
		expect((await dispatchClipboardPaste(title, { 'text/plain': 'x' })).defaultPrevented).toBe(
			false
		);
		expect((await dispatchCut(title)).defaultPrevented).toBe(false);
		expect(edytor.value).toEqual(before);
		expect(edytor.selection.value.kind).toBe('blocks');
	});

	it('a foreign text drop on the field is the browser’s; a file drop is swallowed', async () => {
		const { edytor, title, before } = await inField();
		const drop = (types: string[]) => {
			const event = new Event('drop', { bubbles: true, cancelable: true });
			Object.defineProperty(event, 'dataTransfer', {
				value: { types, getData: () => 'DROPPED', files: [] }
			});
			title.dispatchEvent(event);
			return event.defaultPrevented;
		};
		expect(drop(['text/plain'])).toBe(false);
		expect(drop(['Files'])).toBe(true);
		await flushDomUpdates();
		expect(edytor.value).toEqual(before);
	});
});

describe('any control of a kind owns its events, whatever its type (DR-props-2)', () => {
	const controls = ['[data-card-due]', '[data-card-status]', '[data-card-done]'];
	const settle = async () => {
		await flushDomUpdates();
		await new Promise((resolve) => setTimeout(resolve, 60));
		await flushDomUpdates();
	};

	it.each(controls)(
		'%s: with an editor range, a paste, a copy, a cut and Enter or Tab are the control’s',
		async (selector) => {
			const { edytor, editor } = await renderDomEdytor(<root />, { value, plugins });
			const body = edytor.idToBlock.block('c').content[0] as never;
			await setNativeSelection(edytor, body, 0, body, 2);
			const control = editor.querySelector<HTMLElement>(selector)!;
			control.focus();
			await flushDomUpdates();
			const before = edytor.value;
			expect(
				(await dispatchClipboardPaste(control, { 'text/plain': '2026-10-01' })).defaultPrevented
			).toBe(false);
			expect((await dispatchCopy(control)).defaultPrevented).toBe(false);
			expect((await dispatchCut(control)).defaultPrevented).toBe(false);
			for (const key of ['Enter', 'Tab'])
				expect((await dispatchDomKeyDown(control, { key })).defaultPrevented, key).toBe(false);
			await settle();
			expect(edytor.value).toEqual(before);
		}
	);

	it.each(controls)(
		'%s over a block selection: its keys and paste never act on the selected blocks',
		async (selector) => {
			const { edytor, editor } = await renderDomEdytor(<root />, { value, plugins });
			selectBlocks(edytor, edytor.idToBlock.block('p'));
			await flushDomUpdates();
			const control = editor.querySelector<HTMLElement>(selector)!;
			control.focus();
			const before = edytor.value;
			for (const key of ['Enter', 'Tab', 'a'])
				expect((await dispatchDomKeyDown(control, { key })).defaultPrevented, key).toBe(false);
			// Backspace and Delete delete nothing (a select or a button keeps its old guard
			// against the browser deleting around it, which writes nothing either).
			for (const key of ['Backspace', 'Delete']) await dispatchDomKeyDown(control, { key });
			expect((await dispatchClipboardPaste(control, { 'text/plain': 'x' })).defaultPrevented).toBe(
				false
			);
			expect((await dispatchCut(control)).defaultPrevented).toBe(false);
			await settle();
			expect(edytor.value).toEqual(before);
			expect(edytor.selection.value.kind).toBe('blocks');
		}
	);

	it('the date field takes Backspace and Delete over a block selection as its own keys', async () => {
		const { edytor, editor } = await renderDomEdytor(<root />, { value, plugins });
		selectBlocks(edytor, edytor.idToBlock.block('p'));
		await flushDomUpdates();
		const due = q(editor, '[data-card-due]');
		due.focus();
		for (const key of ['Backspace', 'Delete'])
			expect((await dispatchDomKeyDown(due, { key })).defaultPrevented, key).toBe(false);
	});

	it('the editor’s own text and atoms still take their keys and paste', async () => {
		const { edytor } = await renderDomEdytor(<root />, { value, plugins });
		const text = edytor.idToBlock.block('p').content[0] as never;
		await setNativeSelection(edytor, text, 0, text, 2);
		const node = (edytor.idToBlock.block('p').content[0] as { node: HTMLElement }).node;
		expect((await dispatchClipboardPaste(node, { 'text/plain': 'X' })).defaultPrevented).toBe(true);
		await flushDomUpdates();
		expect(edytor.value.children![1]!.content![0]).toEqual({ text: 'X ' });
		// A selected atom: Backspace removes it.
		edytor.selection.selectInlineBlock(edytor.idToBlock.atom('p', 'm'));
		await flushDomUpdates();
		await dispatchDomKeyDown(edytor.node!, { key: 'Backspace' });
		await settle();
		expect(edytor.value.children![1]!.content).toEqual([{ text: 'X ' }]);
	});
});
