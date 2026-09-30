/** @jsxImportSource ../../jsx */
/**
 * Dragging several blocks by one handle (Notion): a block selection, or a
 * text range across blocks, moves every block it covers (the outermost
 * ones, `getSelectionBlocks` — Tab's and Turn into's resolver) when the
 * dragged handle belongs to one of them, as ONE move and ONE undo step
 * through `edytor.moveBlocks`; a handle outside the selection drags its
 * block alone. Driven through the real drag library (Pragmatic drag and
 * drop's native events) over a laid-out block stack. Expected states are
 * hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { blockHandlesPlugin } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { HIDDEN } from '$lib/selection/visibility.js';
import { dispatchDomKeyDown, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const ROW = 24;

const p = (id: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text: id }],
	...(children && { children })
});

const render = (children: JSONBlock[], plugins: Plugin[] = []) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [richTextPlugin, mentionPlugin, blockHandlesPlugin, ...plugins],
			value: { children }
		}
	);

/**
 * Lay the shown blocks out as a stack of 24px rows (jsdom has no layout):
 * a block's box runs from its own row to the end of its shown descendants,
 * indented 24px per level; a hidden block has an empty box.
 */
const layout = () => {
	const blocks = [...document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')];
	const shown = blocks.filter((node) => !node.closest(HIDDEN));
	for (const node of blocks) {
		const index = shown.indexOf(node);
		let depth = 0;
		for (let up = node.parentElement?.closest('[data-edytor-block="true"]'); up; )
			[depth, up] = [depth + 1, up.parentElement?.closest('[data-edytor-block="true"]')];
		const inner = shown.filter((other) => other !== node && node.contains(other)).length;
		const rect =
			index < 0
				? new DOMRect(0, 0, 0, 0)
				: new DOMRect(depth * ROW, index * ROW, 600 - depth * ROW, (inner + 1) * ROW);
		node.getBoundingClientRect = () => rect;
	}
};

/** A native drag event carrying a data transfer that records the drag image. */
const fire = (
	target: EventTarget,
	type: string,
	at: { clientX?: number; clientY?: number } = {}
) => {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...at });
	const store: Record<string, string> = {};
	Object.defineProperty(event, 'dataTransfer', {
		value: {
			setData: (key: string, value: string) => (store[key] = value),
			getData: (key: string) => store[key] ?? '',
			get types() {
				return Object.keys(store);
			},
			setDragImage: (image: Element) => (dragImage = image.cloneNode(true) as HTMLElement),
			dropEffect: 'move',
			effectAllowed: 'all',
			items: [],
			files: []
		}
	});
	target.dispatchEvent(event);
};
let dragImage: HTMLElement | null = null;
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

type Drag = { indicator: HTMLElement | null; image: HTMLElement | null };

/**
 * Drag `source`'s handle onto the row of `target` (`at`: 0 top … 1 bottom),
 * then drop: before in the top half, after in the bottom half. The pointer is
 * 22px right of the target's left edge: past a nested block's 20px outdent
 * gutter, left of the nest threshold (one 24px step past the text start;
 * jsdom has no text rects: the left edge), so a bottom-half drop is a sibling.
 */
const drag = async (edytor: Edytor, source: string, target: string, at: number): Promise<Drag> => {
	await flushDomUpdates();
	layout();
	dragImage = null;
	const handle = document.querySelector<HTMLElement>(
		`[data-testid="block-handle"][data-block-id="${source}"]`
	)!;
	fire(handle, 'dragstart');
	await frame();
	const node = edytor.idToBlock.get(target)!.node!;
	const rect = node.getBoundingClientRect();
	const point = { clientX: rect.left + 22, clientY: rect.top + at * ROW };
	fire(node, 'dragenter', point);
	fire(node, 'dragover', point);
	await frame();
	const indicator = document.querySelector<HTMLElement>('[data-edytor-drop-indicator]');
	// Set by the data transfer's `setDragImage`, which the drag library calls.
	const recorded = dragImage as HTMLElement | null;
	const image = recorded?.querySelector<HTMLElement>('[data-edytor-drag-preview]') ?? null;
	const shown: Drag = { indicator: indicator?.cloneNode(true) as HTMLElement, image };
	fire(node, 'drop', point);
	await flushDomUpdates();
	await frame();
	return shown;
};

const tree = (edytor: Edytor) => {
	const walk = (children: JSONBlock[] = []): unknown[] =>
		children.map((block) => (block.children?.length ? [block.id, walk(block.children)] : block.id));
	return walk(edytor.value.children);
};
const selected = (edytor: Edytor) =>
	[...edytor.selection.selectedBlocks].sort(edytor.compareBlocks).map((block) => block.id);
const block = (edytor: Edytor, id: string) => edytor.idToBlock.get(id)!;

describe('dragging a block selection by one of its handles', () => {
	it('moves the three selected blocks together, shows the count, one undo step', async () => {
		const { edytor } = await render([p('a'), p('b'), p('c'), p('d'), p('e')]);
		edytor.selection.selectBlocks(block(edytor, 'a'), block(edytor, 'b'), block(edytor, 'c'));
		const shown = await drag(edytor, 'b', 'e', 0.95);

		expect(tree(edytor)).toEqual(['d', 'e', 'a', 'b', 'c']);
		expect(selected(edytor)).toEqual(['a', 'b', 'c']);
		expect(shown.indicator?.dataset.position).toBe('after');
		expect(shown.indicator?.dataset.count).toBe('3');
		expect(shown.image?.dataset.count).toBe('3');
		expect(shown.image?.textContent).toContain('a');
		expect(shown.image?.textContent).toContain('c');
		expect(edytor.undoManager!.undoStack.length).toBe(1);

		edytor.history.undo();
		await flushDomUpdates();
		expect(tree(edytor)).toEqual(['a', 'b', 'c', 'd', 'e']);
	});

	it('a handle outside the selection drags its block alone and selects it', async () => {
		const { edytor } = await render([p('a'), p('b'), p('c'), p('d'), p('e')]);
		edytor.selection.selectBlocks(block(edytor, 'a'), block(edytor, 'b'));
		const shown = await drag(edytor, 'd', 'a', 0.05);

		expect(tree(edytor)).toEqual(['d', 'a', 'b', 'c', 'e']);
		expect(selected(edytor)).toEqual(['d']);
		expect(shown.indicator?.dataset.count).toBeUndefined();
		// The ghost of the one block, without a count; gone once the drag started.
		expect(shown.image?.dataset.count).toBe('1');
		expect(shown.image?.textContent).toContain('d');
		expect(shown.image?.querySelector('[data-edytor-drag-count]')).toBeNull();
		expect(document.querySelector('[data-edytor-drag-preview]')).toBeNull();
	});

	it("carries a moved block's children, and a closed toggle's hidden body", async () => {
		const { edytor } = await render([
			p('a', [p('a1')]),
			{ id: 't', type: 'toggle', content: [{ text: 't' }], children: [p('t1')] },
			p('c'),
			p('d')
		]);
		await flushDomUpdates();
		(block(edytor, 't').node as HTMLDetailsElement).open = false;
		edytor.selection.selectBlocks(block(edytor, 'a'), block(edytor, 't'));
		await drag(edytor, 't', 'd', 0.95);

		expect(tree(edytor)).toEqual(['c', 'd', ['a', ['a1']], ['t', ['t1']]]);
		expect(selected(edytor)).toEqual(['a', 't']);
	});

	it('refuses the whole group when a plugin vetoes the move', async () => {
		const veto: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				if (operation === 'moveBlocks') prevent();
			}
		});
		const { edytor } = await render([p('a'), p('b'), p('c'), p('d')], [veto]);
		edytor.selection.selectBlocks(block(edytor, 'a'), block(edytor, 'b'));
		await drag(edytor, 'a', 'd', 0.95);

		expect(tree(edytor)).toEqual(['a', 'b', 'c', 'd']);
		expect(selected(edytor)).toEqual(['a', 'b']);
		expect(edytor.undoManager!.undoStack.length).toBe(0);
	});

	it('refuses a group one member of which does not fit the destination', async () => {
		const { edytor } = await render([
			{
				id: 'L',
				type: 'unordered-list',
				children: [{ id: 'one', type: 'list-item', content: [{ text: 'one' }] }]
			},
			p('x'),
			{
				id: 'M',
				type: 'unordered-list',
				children: [{ id: 'm1', type: 'list-item', content: [{ text: 'm1' }] }]
			}
		]);
		const [one, x, m1] = ['one', 'x', 'm1'].map((id) => block(edytor, id));
		// An item alone may go beside m1; a paragraph may not sit directly in a list.
		expect(edytor.canMoveBlocks({ blocks: [one!], target: m1!, position: 'before' })).toBe(true);
		expect(edytor.canMoveBlocks({ blocks: [one!, x!], target: m1!, position: 'before' })).toBe(
			false
		);
		expect(edytor.moveBlocks({ blocks: [one!, x!], target: m1!, position: 'before' })).toEqual([]);
		expect(tree(edytor)).toEqual([['L', ['one']], 'x', ['M', ['m1']]]);
	});
});

describe('dragging a text range across blocks by one of their handles', () => {
	it('moves the three blocks the range covers and block-selects them', async () => {
		const { edytor } = await render([p('a'), p('b'), p('c'), p('d'), p('e')]);
		edytor.selection.setAtRange(block(edytor, 'a').firstText!, 1, block(edytor, 'c').firstText!, 1);
		const shown = await drag(edytor, 'a', 'e', 0.95);

		expect(tree(edytor)).toEqual(['d', 'e', 'a', 'b', 'c']);
		expect(selected(edytor)).toEqual(['a', 'b', 'c']);
		expect(shown.indicator?.dataset.count).toBe('3');

		edytor.history.undo();
		await flushDomUpdates();
		expect(tree(edytor)).toEqual(['a', 'b', 'c', 'd', 'e']);
	});

	it('moves blocks from different levels together, in document order', async () => {
		const { edytor } = await render([p('a', [p('a1')]), p('b'), p('c')]);
		edytor.selection.setAtRange(
			block(edytor, 'a1').firstText!,
			0,
			block(edytor, 'b').firstText!,
			1
		);
		await drag(edytor, 'a1', 'c', 0.95);

		expect(tree(edytor)).toEqual(['a', 'c', 'a1', 'b']);
		expect(selected(edytor)).toEqual(['a1', 'b']);
	});

	it('a range from inside a code block moves the code block with the blocks after it', async () => {
		const { edytor } = await render(
			[
				p('x'),
				{
					id: 'k',
					type: 'code',
					children: [
						{ id: 'l1', type: 'codeLine', content: [{ text: 'one' }] },
						{ id: 'l2', type: 'codeLine', content: [{ text: 'two' }] }
					]
				},
				p('y')
			],
			[codePlugin]
		);
		edytor.selection.setAtRange(
			block(edytor, 'l2').firstText!,
			1,
			block(edytor, 'y').firstText!,
			1
		);
		await drag(edytor, 'y', 'x', 0.05);

		expect(tree(edytor)).toEqual([['k', ['l1', 'l2']], 'y', 'x']);
		expect(selected(edytor)).toEqual(['k', 'y']);
	});

	it('a handle outside the range drags its block alone', async () => {
		const { edytor } = await render([p('a'), p('b'), p('c'), p('d')]);
		edytor.selection.setAtRange(block(edytor, 'a').firstText!, 0, block(edytor, 'b').firstText!, 1);
		await drag(edytor, 'd', 'a', 0.05);

		expect(tree(edytor)).toEqual(['d', 'a', 'b', 'c']);
		expect(selected(edytor)).toEqual(['d']);
	});
});

describe('the handle keyboard moves the same group', () => {
	it('Alt+ArrowDown on a selected block moves the whole selection', async () => {
		const { edytor } = await render([p('a'), p('b'), p('c'), p('d')]);
		edytor.selection.selectBlocks(block(edytor, 'a'), block(edytor, 'b'));
		await flushDomUpdates();
		const handle = document.querySelector<HTMLElement>(
			'[data-testid="block-handle"][data-block-id="b"]'
		)!;
		handle.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'ArrowDown',
				altKey: true,
				bubbles: true,
				cancelable: true
			})
		);
		await flushDomUpdates();
		expect(tree(edytor)).toEqual(['c', 'a', 'b', 'd']);
		expect(selected(edytor)).toEqual(['a', 'b']);
	});
});

describe('the other gestures over a text range across blocks take the same blocks', () => {
	it('a grip click on a child the range covers selects every block it covers, the child too', async () => {
		const { edytor } = await render([p('a', [p('a1')]), p('b'), p('c')], [blockMenuPlugin]);
		edytor.selection.setAtRange(block(edytor, 'a').firstText!, 0, block(edytor, 'b').firstText!, 1);
		await flushDomUpdates();
		const grip = document.querySelector<HTMLElement>(
			'[data-testid="block-handle"][data-block-id="a1"]'
		)!;
		grip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();

		// The same blocks Turn into and Tab take over that range; the menu acts on all of them.
		expect(selected(edytor)).toEqual(['a', 'a1', 'b']);
	});

	it('Mod+Shift+ArrowDown moves the blocks the range covers, the range kept', async () => {
		const { edytor } = await render([p('a'), p('b'), p('c'), p('d')], [arrowMovePlugin]);
		edytor.selection.setAtRange(block(edytor, 'a').firstText!, 1, block(edytor, 'c').firstText!, 1);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'ArrowDown', ctrlKey: true, shiftKey: true });

		expect(tree(edytor)).toEqual(['d', 'a', 'b', 'c']);
		const { startText, yStart, endText, yEnd } = edytor.selection.state;
		expect([startText?.parent.id, yStart, endText?.parent.id, yEnd]).toEqual(['a', 1, 'c', 1]);
	});

	it("a grip click block-selects the range's blocks for its menu", async () => {
		const { edytor } = await render([p('a'), p('b'), p('c'), p('d')], [blockMenuPlugin]);
		edytor.selection.setAtRange(block(edytor, 'a').firstText!, 1, block(edytor, 'c').firstText!, 1);
		await flushDomUpdates();
		const grip = document.querySelector<HTMLElement>(
			'[data-testid="block-handle"][data-block-id="b"]'
		)!;
		grip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();

		expect(selected(edytor)).toEqual(['a', 'b', 'c']);
		expect(document.querySelector('[data-testid="block-menu"]')).not.toBeNull();
	});
});

describe('Mod+Shift+arrows in a code block', () => {
	it('a caret in a code line moves the code block, the caret riding along', async () => {
		const { edytor } = await render(
			[
				p('x'),
				{
					id: 'k',
					type: 'code',
					children: [{ id: 'l1', type: 'codeLine', content: [{ text: 'one' }] }]
				}
			],
			[codePlugin, arrowMovePlugin]
		);
		edytor.selection.setAtTextOffset(block(edytor, 'l1').firstText!, 2);
		await flushDomUpdates();
		await dispatchDomKeyDown(document, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });

		expect(tree(edytor)).toEqual([['k', ['l1']], 'x']);
		const { startText, yStart } = edytor.selection.state;
		expect([startText?.parent.id, yStart]).toEqual(['l1', 2]);
	});
});

describe('a selected list: its items are not selected (DR-handles)', () => {
	const list = () => [
		p('x'),
		{
			id: 'L',
			type: 'unordered-list',
			children: ['one', 'two', 'three'].map((id) => ({
				id,
				type: 'list-item',
				content: [{ text: id }]
			}))
		},
		p('y')
	];
	const altKey = (id: string, key: string) =>
		document
			.querySelector<HTMLElement>(`[data-testid="block-handle"][data-block-id="${id}"]`)!
			.dispatchEvent(
				new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true })
			);

	it("dragging an item's handle reorders the item inside the list", async () => {
		const { edytor } = await render(list());
		edytor.selection.selectBlocks(block(edytor, 'L'));
		const shown = await drag(edytor, 'three', 'one', 0.05);

		expect(tree(edytor)).toEqual(['x', ['L', ['three', 'one', 'two']], 'y']);
		expect(selected(edytor)).toEqual(['three']);
		expect(shown.indicator?.dataset.count).toBeUndefined();
	});

	it("dragging an item's handle past the list moves the item alone", async () => {
		const { edytor } = await render(list());
		edytor.selection.selectBlocks(block(edytor, 'L'));
		await drag(edytor, 'three', 'y', 0.95);

		expect(tree(edytor)).toEqual(['x', ['L', ['one', 'two']], 'y', 'three']);
	});

	it("Alt+ArrowUp on an item's handle moves the item", async () => {
		const { edytor } = await render(list());
		edytor.selection.selectBlocks(block(edytor, 'L'));
		await flushDomUpdates();
		altKey('three', 'ArrowUp');
		await flushDomUpdates();

		expect(tree(edytor)).toEqual(['x', ['L', ['one', 'three', 'two']], 'y']);
		expect(selected(edytor)).toEqual(['three']);
	});

	it("the list's own handle still drags the whole list", async () => {
		const { edytor } = await render(list());
		edytor.selection.selectBlocks(block(edytor, 'L'));
		await drag(edytor, 'L', 'x', 0.05);

		expect(tree(edytor)).toEqual([['L', ['one', 'two', 'three']], 'x', 'y']);
		expect(selected(edytor)).toEqual(['L']);
	});
});

describe('Mod+Shift+arrows on the block selection a grip click makes (DR-handles)', () => {
	it('moves a parent and its selected child as one group', async () => {
		const { edytor } = await render(
			[p('a', [p('a1')]), p('b'), p('c')],
			[arrowMovePlugin, blockMenuPlugin]
		);
		edytor.selection.setAtRange(block(edytor, 'a').firstText!, 0, block(edytor, 'b').firstText!, 1);
		await flushDomUpdates();
		document
			.querySelector<HTMLElement>('[data-testid="block-handle"][data-block-id="a"]')!
			.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();
		expect(selected(edytor)).toEqual(['a', 'a1', 'b']);
		await dispatchDomKeyDown(document.activeElement as HTMLElement, { key: 'Escape' });
		await flushDomUpdates();
		expect(document.querySelector('[data-testid="block-menu"]')).toBeNull();
		expect(selected(edytor)).toEqual(['a', 'a1', 'b']);

		await dispatchDomKeyDown(document, { key: 'ArrowDown', ctrlKey: true, shiftKey: true });
		expect(tree(edytor)).toEqual(['c', ['a', ['a1']], 'b']);
		// Selected blocks stay selected, so the key can be pressed again.
		expect(selected(edytor)).toEqual(['a', 'a1', 'b']);
		await dispatchDomKeyDown(document, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
		expect(tree(edytor)).toEqual([['a', ['a1']], 'b', 'c']);

		// The handle's Alt+arrow moves the same group and keeps the same selection.
		document
			.querySelector<HTMLElement>('[data-testid="block-handle"][data-block-id="a1"]')!
			.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'ArrowDown',
					altKey: true,
					bubbles: true,
					cancelable: true
				})
			);
		await flushDomUpdates();
		expect(tree(edytor)).toEqual(['c', ['a', ['a1']], 'b']);
		expect(selected(edytor)).toEqual(['a', 'a1', 'b']);
	});
});

describe('a handle gesture over a text range, and its undo (wave-18 lows)', () => {
	const altKey = (id: string, key: string) =>
		document
			.querySelector<HTMLElement>(`[data-testid="block-handle"][data-block-id="${id}"]`)!
			.dispatchEvent(
				new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true })
			);
	const range = (edytor: Edytor) => {
		const { startText, yStart, endText, yEnd, isCollapsed } = edytor.selection.state;
		return [startText?.parent.id, yStart, endText?.parent.id, yEnd, isCollapsed];
	};

	it('undo after a text-range drag restores the range the user had; redo its blocks', async () => {
		const { edytor } = await render([p('a'), p('b'), p('c'), p('d'), p('e')]);
		edytor.selection.setAtRange(block(edytor, 'a').firstText!, 1, block(edytor, 'c').firstText!, 1);
		await drag(edytor, 'a', 'e', 0.95);
		expect(selected(edytor)).toEqual(['a', 'b', 'c']);

		edytor.historyUndo();
		await flushDomUpdates();
		expect(tree(edytor)).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(selected(edytor)).toEqual([]);
		expect(range(edytor)).toEqual(['a', 1, 'c', 1, false]);

		edytor.historyRedo();
		await flushDomUpdates();
		expect(tree(edytor)).toEqual(['d', 'e', 'a', 'b', 'c']);
		expect(selected(edytor)).toEqual(['a', 'b', 'c']);
	});

	it("undo after a drag outside the selection restores the caret the user had, as Alt+arrow's does", async () => {
		const { edytor } = await render([p('a'), p('b'), p('c')]);
		edytor.selection.setAtTextOffset(block(edytor, 'a').firstText!, 1);
		await drag(edytor, 'c', 'a', 0.05);
		expect(selected(edytor)).toEqual(['c']);

		edytor.historyUndo();
		await flushDomUpdates();
		expect(tree(edytor)).toEqual(['a', 'b', 'c']);
		expect(range(edytor)).toEqual(['a', 1, 'a', 1, true]);
	});

	it('Alt+arrow over a text range keeps the range, as Mod+Shift+arrow does', async () => {
		const { edytor } = await render([p('a'), p('b'), p('c'), p('d')], [arrowMovePlugin]);
		edytor.selection.setAtRange(block(edytor, 'a').firstText!, 1, block(edytor, 'c').firstText!, 1);
		await flushDomUpdates();
		altKey('b', 'ArrowDown');
		await flushDomUpdates();

		expect(tree(edytor)).toEqual(['d', 'a', 'b', 'c']);
		expect(selected(edytor)).toEqual([]);
		expect(range(edytor)).toEqual(['a', 1, 'c', 1, false]);

		await dispatchDomKeyDown(document, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
		expect(tree(edytor)).toEqual(['a', 'b', 'c', 'd']);
		expect(range(edytor)).toEqual(['a', 1, 'c', 1, false]);

		edytor.historyUndo();
		await flushDomUpdates();
		edytor.historyUndo();
		await flushDomUpdates();
		expect(tree(edytor)).toEqual(['a', 'b', 'c', 'd']);
		expect(range(edytor)).toEqual(['a', 1, 'c', 1, false]);
	});

	it("Alt+arrow on a parent's handle while only its child is selected selects the parent alone, as a drag does", async () => {
		const { edytor } = await render([p('a', [p('a1')]), p('b'), p('c')]);
		edytor.selection.selectBlocks(block(edytor, 'a1'));
		await flushDomUpdates();
		altKey('a', 'ArrowDown');
		await flushDomUpdates();
		expect(tree(edytor)).toEqual(['b', ['a', ['a1']], 'c']);
		expect(selected(edytor)).toEqual(['a']);

		edytor.selection.selectBlocks(block(edytor, 'a1'));
		await drag(edytor, 'a', 'c', 0.95);
		expect(tree(edytor)).toEqual(['b', 'c', ['a', ['a1']]]);
		expect(selected(edytor)).toEqual(['a']);
	});
});
