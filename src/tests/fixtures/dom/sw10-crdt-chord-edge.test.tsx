/** @jsxImportSource ../../jsx */
/**
 * SW10-crdt-1 (found by the DST list shape, AW-09): a word or line delete
 * chord (Option/Ctrl+Backspace, Cmd+Backspace) at the start of a block
 * deletes the neighbour like a character (`deleteCollapsedUnit`). WebKit
 * announces no `beforeinput` for it at the document's first text, so
 * Option+Backspace at the start of an empty first list item did nothing in
 * Safari while Backspace lifted it out. The keydown fallback now covers
 * the chords at a block's edge, as it covers Backspace and Delete. Expected
 * states are hand-authored.
 */
import { describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

const empty = (
	<root>
		<paragraph>|</paragraph>
	</root>
);

const render = (children: JSONBlock[]) =>
	renderDomEdytor(empty, { plugins: [richTextPlugin, mentionPlugin], value: { children } });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const keydown = (target: EventTarget, init: KeyboardEventInit & { key: string }) => {
	const event = new KeyboardEvent('keydown', {
		code: init.key,
		...init,
		bubbles: true,
		cancelable: true
	});
	target.dispatchEvent(event);
	return event;
};

const types = (children: JSONBlock[] | undefined): unknown =>
	(children ?? []).map((b) => (b.children?.length ? [b.type, types(b.children)] : b.type));

describe('SW10-crdt-1: a word or line chord at a block edge with no beforeinput', () => {
	it.each([
		['Option+Backspace', { altKey: true }],
		['Cmd+Backspace', { metaKey: true }],
		['Ctrl+Backspace', { ctrlKey: true }]
	])(
		'%s at the start of the only (empty) item lifts it out, as Backspace does',
		async (_, mods) => {
			const { edytor, editor } = await render([
				{ type: 'unordered-list', children: [{ type: 'list-item' }] }
			]);
			const item = edytor.root!.children[0]!.children[0]!;
			edytor.selection.setAtTextOffset(item.firstText!, 0);
			await flushDomUpdates();
			keydown(item.firstText!.node ?? editor, { key: 'Backspace', ...mods });
			await flushDomUpdates();
			await wait(60);
			await flushDomUpdates();
			expect(types(edytor.value.children)).toEqual(['paragraph']);
		}
	);

	it('Option+Delete at the end of the block above a list pulls the first item up', async () => {
		const { edytor, editor } = await render([
			{ type: 'paragraph', content: [{ text: 'p' }] },
			{
				type: 'unordered-list',
				children: [{ type: 'list-item', content: [{ text: 'a' }] }]
			}
		]);
		const p = edytor.root!.children[0]!;
		edytor.selection.setAtTextOffset(p.firstText!, 1);
		await flushDomUpdates();
		keydown(p.firstText!.node ?? editor, { key: 'Delete', altKey: true });
		await flushDomUpdates();
		await wait(60);
		await flushDomUpdates();
		expect(edytor.value.children).toMatchObject([{ type: 'paragraph', content: [{ text: 'pa' }] }]);
		expect(edytor.value.children).toHaveLength(1);
	});

	it('mid-text the chord stays the browser’s: no fallback runs without a beforeinput', async () => {
		const { edytor, editor } = await render([{ type: 'paragraph', content: [{ text: 'hello' }] }]);
		const p = edytor.root!.children[0]!;
		edytor.selection.setAtTextOffset(p.firstText!, 3);
		await flushDomUpdates();
		keydown(p.firstText!.node ?? editor, { key: 'Backspace', altKey: true });
		await flushDomUpdates();
		await wait(60);
		await flushDomUpdates();
		expect(p.firstText!.stringContent).toBe('hello');
	});
});
