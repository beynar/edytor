/** @jsxImportSource ../../jsx */
/**
 * Editing lows from the 2026-09-30 re-score: Tab over a text range spanning
 * blocks, the row naming a clamped heading, the block-menu caret after
 * Delete beside a void, and Mod+D over a block selection. Re-score 2: Tab
 * over a range across nesting levels (RW-13) and a refused block-menu Delete
 * (RW-11). Expected states are hand-authored from Notion's behavior.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { rowOf } from '$lib/kinds.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import {
	canonicalTree,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	type CanonicalBlock
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const render = (plugins: Plugin[], children: JSONBlock[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin, mentionPlugin, ...plugins], value: { children } }
	);

const p = (id: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text: id }],
	...(children && { children })
});

/** Blocks as `[text, children]`. */
type Shape = [string, Shape[]];
const shape = (block: CanonicalBlock): Shape => [
	(block.content?.[0] as { text?: string } | undefined)?.text ?? '',
	(block.children ?? []).map(shape)
];

describe('Tab over a text range spanning blocks moves every block it touches', () => {
	it('Tab nests them into the block before; Shift+Tab moves them back out', async () => {
		const { edytor } = await render([], [p('zero'), p('one'), p('two', [p('sub')]), p('three')]);
		const [one, three] = [edytor.idToBlock.get('one')!, edytor.idToBlock.get('three')!];
		edytor.selection.setAtRange(one.firstText!, 1, three.firstText!, 2);
		await flushDomUpdates();

		await dispatchDomKeyDown(document, { key: 'Tab' });
		expect(canonicalTree(edytor).map(shape)).toEqual([
			[
				'zero',
				[
					['one', []],
					['two', [['sub', []]]],
					['three', []]
				]
			]
		]);
		// The text range stays.
		const { startText, endText, yStart, yEnd } = edytor.selection.state;
		expect([startText?.parent.id, yStart, endText?.parent.id, yEnd]).toEqual([
			'one',
			1,
			'three',
			2
		]);

		await dispatchDomKeyDown(document, { key: 'Tab', shiftKey: true });
		expect(canonicalTree(edytor).map(shape)).toEqual([
			['zero', []],
			['one', []],
			['two', [['sub', []]]],
			['three', []]
		]);
	});

	// RW-13: [a, b→[b1, b2], c], a range from b2 to c (the start block deeper).
	const spanning = async () => {
		const rendered = await render([], [p('a'), p('b', [p('b1'), p('b2')]), p('c')]);
		const { edytor } = rendered;
		const [b2, c] = [edytor.idToBlock.get('b2')!, edytor.idToBlock.get('c')!];
		edytor.selection.setAtRange(b2.firstText!, 1, c.firstText!, 1);
		await flushDomUpdates();
		edytor.undoManager.stopCapturing();
		return rendered;
	};
	const original: Shape[] = [
		['a', []],
		[
			'b',
			[
				['b1', []],
				['b2', []]
			]
		],
		['c', []]
	];

	it('Tab over levels nests each touched block one level, as one undo step', async () => {
		const { edytor } = await spanning();
		await dispatchDomKeyDown(document, { key: 'Tab' });
		expect(canonicalTree(edytor).map(shape)).toEqual([
			['a', []],
			[
				'b',
				[
					['b1', [['b2', []]]],
					['c', []]
				]
			]
		]);
		const { startText, endText, yStart, yEnd } = edytor.selection.state;
		expect([startText?.parent.id, yStart, endText?.parent.id, yEnd]).toEqual(['b2', 1, 'c', 1]);
		await dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
		expect(canonicalTree(edytor).map(shape)).toEqual(original);
	});

	it('Shift+Tab over levels unnests the nested block; the top-level one stays', async () => {
		const { edytor } = await spanning();
		await dispatchDomKeyDown(document, { key: 'Tab', shiftKey: true });
		expect(canonicalTree(edytor).map(shape)).toEqual([
			['a', []],
			['b', [['b1', []]]],
			['b2', []],
			['c', []]
		]);
		await dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
		expect(canonicalTree(edytor).map(shape)).toEqual(original);
	});
});

describe('the row naming a block', () => {
	it('labels a stored h5 heading by the level it is drawn at (Heading 3)', async () => {
		const { edytor } = await render(
			[],
			[
				{ id: 'h5', type: 'heading', data: { level: 'h5' }, content: [{ text: 'deep' }] },
				{ id: 'h2', type: 'heading', data: { level: 'h2' }, content: [{ text: 'two' }] }
			]
		);
		const label = (id: string) => rowOf(edytor, edytor.idToBlock.get(id))?.label;
		expect([label('h5'), label('h2')]).toEqual(['Heading 3', 'Heading 2']);
	});
});

describe('the block menu caret after Delete', () => {
	const openAndDelete = async (
		edytor: Awaited<ReturnType<typeof render>>['edytor'],
		editor: HTMLElement,
		id: string
	) => {
		const block = edytor.idToBlock.get(id)!;
		editor.dispatchEvent(
			new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
		);
		await flushDomUpdates();
		const button = document.querySelector('[data-testid="block-menu-delete"]')!;
		button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();
	};
	const caret = (edytor: Awaited<ReturnType<typeof render>>['edytor']) => {
		const { startBlock, yStart } = edytor.selection.state;
		return [startBlock?.id, yStart];
	};

	it('skips a void block after it to the next text', async () => {
		const { edytor, editor } = await render(
			[blockMenuPlugin],
			[p('one'), { id: 'rule', type: 'divider' }, p('three')]
		);
		await openAndDelete(edytor, editor, 'one');
		expect(canonicalTree(edytor).map((b) => b.type)).toEqual(['divider', 'paragraph']);
		expect(caret(edytor)).toEqual(['three', 0]);
	});

	it('with no text after it, lands at the end of the text before it, past a void', async () => {
		const { edytor, editor } = await render(
			[blockMenuPlugin],
			[p('one'), { id: 'rule', type: 'divider' }, p('three')]
		);
		await openAndDelete(edytor, editor, 'three');
		expect(caret(edytor)).toEqual(['one', 3]);
	});

	it('refused by an extension, the block stays and the caret returns to it (RW-11)', async () => {
		const keep: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				if (operation === 'removeBlock') prevent();
			}
		});
		const { edytor, editor } = await render([blockMenuPlugin, keep], [p('one'), p('two')]);
		await openAndDelete(edytor, editor, 'one');
		expect(canonicalTree(edytor).map((b) => shape(b)[0])).toEqual(['one', 'two']);
		expect(caret(edytor)).toEqual(['one', 0]);
	});
});

describe('Mod+D over a block selection', () => {
	it('duplicates every selected block, each after itself, as one undo step', async () => {
		const { edytor } = await render([blockMenuPlugin], [p('a'), p('b'), p('c')]);
		edytor.selection.selectBlocks(edytor.idToBlock.get('a')!, edytor.idToBlock.get('b')!);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'd', ctrlKey: true });
		const texts = () => canonicalTree(edytor).map((b) => shape(b)[0]);
		expect(texts()).toEqual(['a', 'a', 'b', 'b', 'c']);
		// The copies are selected.
		const selected = [...edytor.selection.selectedBlocks].map((b) => [b.index, b.id]);
		expect(selected.map(([index]) => index)).toEqual([1, 3]);
		expect(selected.every(([, id]) => id !== 'a' && id !== 'b')).toBe(true);
		await dispatchDomKeyDown(document, { key: 'z', ctrlKey: true });
		expect(texts()).toEqual(['a', 'b', 'c']);
	});
});
