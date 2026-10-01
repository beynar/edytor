/** @jsxImportSource ../../jsx */
/**
 * Adversarial review 2026-09-29, core API units (dom lane). Expected values
 * come from the report's "Done when" rows and the docs, never from running
 * the code:
 *
 * - UW-17 — one definition lookup: a block of a kind the view does not
 *   register renders as a plain block (its text and its children), on mount
 *   and when a peer inserts it; nothing throws.
 * - UW-22 — `block.setData`, `block.type =` and `atom.setData` are commands
 *   (`patchData`, `setBlock`, `patchData` with `atom`):
 *   a readonly view refuses them (no write) and records the refusal in
 *   `dispatcher.last`; on an editable view extensions see them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => vi.restoreAllMocks());

const unknownKind = {
	children: [
		{ id: 'p', type: 'paragraph', content: [{ text: 'before' }] },
		{
			id: 'w',
			type: 'widget',
			content: [{ text: 'unknown kind' }],
			children: [{ id: 'c', type: 'paragraph', content: [{ text: 'nested' }] }]
		}
	]
};

const blockElement = (editor: HTMLElement, id: string) =>
	editor.querySelector<HTMLElement>(`[data-edytor-id="${id}"][data-edytor-block]`);

describe('UW-17 · a kind the view does not register renders as a plain block', () => {
	it('on mount: its text and its children render, one DEV warning, no throw', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { editor } = await renderDomEdytor(<root />, { value: unknownKind });
		const widget = blockElement(editor, 'w');
		expect(widget?.getAttribute('data-edytor-type')).toBe('widget');
		expect(widget?.querySelector('[data-edytor-text]')?.textContent).toBe('unknown kind');
		expect(blockElement(widget!, 'c')?.textContent?.trim()).toBe('nested');
		expect(blockElement(editor, 'p')?.textContent?.trim()).toBe('before');
		const warnings = warn.mock.calls.filter(([m]) => String(m).includes('"widget"'));
		expect(warnings).toHaveLength(1);
	});

	it('inserted by a peer: it renders with its text, no throw', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>local</paragraph>
			</root>
		);
		const remoteDoc = new Y.Doc();
		Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(edytor.doc));
		const remote = attachDocument(remoteDoc);
		remote.facade.insertBlock(
			{ parent: null, index: 1 },
			{ id: 'peer', type: 'widget', content: [{ kind: 'text', text: 'from a peer' }] }
		);
		Y.applyUpdate(edytor.doc, Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(edytor.doc)));
		await flushDomUpdates();
		expect(blockElement(editor, 'peer')?.textContent).toBe('from a peer');
		expect(blockElement(editor, 'peer')?.getAttribute('data-edytor-type')).toBe('widget');
		expect(editor.textContent).toContain('local');
		remote.destroy();
	});
});

const withAtom = {
	children: [
		{
			id: 'todo',
			type: 'todo-item',
			data: { checked: false },
			content: [{ text: 'a ' }, { type: 'mention', id: 'm', data: { name: 'ann' } }, { text: ' b' }]
		}
	]
};

const bytesOf = (edytor: Edytor) => {
	let bytes = 0;
	const count = (update: Uint8Array) => void (bytes += update.length);
	edytor.doc.on('update', count);
	return () => bytes;
};

describe('UW-22 · data and type setters are commands', () => {
	it('a readonly view refuses setData, the type setter and atom setData', async () => {
		const { edytor } = await renderDomEdytor(<root />, {
			value: withAtom,
			readonly: true,
			plugins: [richTextPlugin, mentionPlugin]
		});
		const bytes = bytesOf(edytor);
		const block = edytor.idToBlock.block('todo');
		// Read through a call: a direct read after `last = null` narrows to null.
		const last = () => edytor.dispatcher.last?.status;

		block.setData({ checked: true });
		expect(last()).toBe('refused');
		edytor.dispatcher.last = null;

		block.type = 'paragraph';
		expect(last()).toBe('refused');
		edytor.dispatcher.last = null;

		edytor.atomAt('todo', 'm').setData({ name: 'bob' });
		expect(last()).toBe('refused');

		expect(bytes()).toBe(0);
		expect(block.type).toBe('todo-item');
		expect(block.data).toEqual({ checked: false });
		expect(edytor.atomAt('todo', 'm').data).toEqual({ name: 'ann' });
	});

	it('on an editable view extensions see them and may veto them', async () => {
		const seen: string[] = [];
		const locked: Plugin = () => ({
			onBeforeOperation: (change) => {
				seen.push(change.operation);
				const atom = change.operation === 'patchData' && change.payload.atom;
				if (atom) change.prevent();
			}
		});
		const { edytor } = await renderDomEdytor(<root />, {
			value: withAtom,
			plugins: [locked, richTextPlugin, mentionPlugin]
		});
		const block = edytor.idToBlock.block('todo');

		block.setData({ checked: true });
		expect(edytor.dispatcher.last?.status).toBe('applied');
		expect(block.data).toEqual({ checked: true });

		block.type = 'paragraph';
		expect(block.type).toBe('paragraph');

		edytor.atomAt('todo', 'm').setData({ name: 'bob' });
		expect(edytor.dispatcher.last?.status).toBe('refused');
		expect(edytor.atomAt('todo', 'm').data).toEqual({ name: 'ann' });

		expect(seen.filter((op) => op !== 'normalizeContent' && op !== 'normalizeChildren')).toEqual([
			'patchData',
			'setBlock',
			'patchData'
		]);
	});
});

describe('UW-41 · attach hooks may return a cleanup, or nothing', () => {
	it('hooks returning nothing or a non-function mount and unmount without a throw', async () => {
		const attached: string[] = [];
		const hooks: Plugin = () => ({
			onEdytorAttached: () => void attached.push('editor'),
			// An async hook answers a promise, not a cleanup: it is not called on unmount.
			onBlockAttached: (async () => void attached.push('block')) as unknown as () => void,
			onTextAttached: () => void attached.push('text')
		});
		const { unmount } = await renderDomEdytor(
			<root>
				<paragraph>one</paragraph>
			</root>,
			{ plugins: [hooks, richTextPlugin] }
		);
		expect(attached).toEqual(expect.arrayContaining(['editor', 'block', 'text']));
		expect(() => unmount()).not.toThrow();
	});
});
