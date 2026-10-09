/** @jsxImportSource ../../jsx */
/**
 * The marquee (`sel.marquee`, `sel.marquee.blocks`, `sel.marquee.cost` in
 * docs/editor-delete-contract.md; Notion's rubber band): a press in the
 * editor's empty area and a drag past 4px select, live, the blocks the
 * rectangle meets.
 *
 * jsdom lays nothing out: each test gives the host and every block a box
 * (`layout`, a row of 30px per block, a nested block indented 24px, columns
 * side by side, a closed toggle's body none). Expected selections are
 * written from the rows, never from a run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRawSnippet } from 'svelte';
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock, JSONDoc } from '$lib/utils/json.js';
import type { Plugin } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { columnsPlugin } from '$lib/plugins/columns/ColumnsPlugin.svelte';
import { createMarqueePlugin, marqueePlugin } from '$lib/plugins/marquee/marqueePlugin.js';
import type { MarqueeBoxPayload } from '$lib/plugins/marquee/MarqueeController.svelte.js';
import { dispatchDomKeyDown, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const ROW = 30;
const LEFT = 100;
const WIDTH = 600;
const INDENT = 24;

const p = (id: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text: id.toLowerCase() }],
	...(children && { children })
});
const toggle = (id: string, children: JSONBlock[]): JSONBlock => ({
	id,
	type: 'toggle',
	content: [{ text: id.toLowerCase() }],
	children
});
const columns = (id: string, ...cols: JSONBlock[][]): JSONBlock => ({
	id,
	type: 'columns',
	children: cols.map((children, i) => ({ id: `${id}${i + 1}`, type: 'column', children }))
});

/** Layout reads, counted (`sel.marquee.cost`). */
let reads = 0;

const box = (node: Element, left: number, top: number, width: number, height: number) => {
	const rect = new DOMRect(left, top, width, height);
	(node as HTMLElement).getBoundingClientRect = () => (reads++, rect);
};

/** Boxes for the host and every block, from the view's tree. */
const layout = (edytor: Edytor) => {
	const { facade } = edytor;
	const hide = (block: Block) => {
		if (block.node) box(block.node, 0, 0, 0, 0);
		block.children.forEach(hide);
	};
	const place = (block: Block, left: number, width: number, top: number): number => {
		const node = block.node!;
		let bottom = top;
		if (facade.isLayout(block.id)) {
			const items = block.children;
			items.forEach((item, i) => {
				const w = width / items.length;
				bottom = Math.max(bottom, place(item, left + i * w, w, top));
			});
		} else if (facade.isLayoutItem(block.id)) {
			for (const child of block.children) bottom = place(child, left, width, bottom);
		} else {
			bottom = top + ROW;
			const closed = node.tagName === 'DETAILS' && !(node as HTMLDetailsElement).open;
			for (const child of block.children)
				if (closed) hide(child);
				else bottom = place(child, left + INDENT, width - INDENT, bottom);
		}
		box(node, left, top, width, bottom - top);
		return bottom;
	};
	let y = 0;
	for (const block of edytor.root!.children) y = place(block, LEFT, WIDTH, y);
	box(edytor.node!, 0, 0, LEFT * 2 + WIDTH, y + 60);
};

const render = async (children: JSONBlock[], plugins: Plugin[] = [], readonly = false) => {
	const rendered = await renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [...plugins, columnsPlugin, richTextPlugin],
			value: { children },
			autoSelectFixture: false,
			blockHandles: false,
			readonly
		}
	);
	layout(rendered.edytor);
	return rendered;
};

const pointer = (type: string, x: number, y: number, init: PointerEventInit = {}) =>
	new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		button: 0,
		buttons: type === 'pointerup' ? 0 : 1,
		isPrimary: true,
		pointerType: 'mouse',
		clientX: x,
		clientY: y,
		...init
	});

/** A press at `(x, y)` on `target` (default: the host's own area). Answers whether it was cancelled. */
const press = (edytor: Edytor, x: number, y: number, init?: PointerEventInit, target?: Element) =>
	!(target ?? edytor.node!).dispatchEvent(pointer('pointerdown', x, y, init));
const move = async (x: number, y: number) => {
	document.dispatchEvent(pointer('pointermove', x, y));
	await flushDomUpdates();
};
const release = async (x: number, y: number) => {
	document.dispatchEvent(pointer('pointerup', x, y));
	await flushDomUpdates();
};
const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));

/** The selected block ids, in document order. */
const selected = (edytor: Edytor) =>
	[...edytor.selection.selectedBlocks].sort(edytor.compareBlocks).map((block) => block.id);

/** The y of the middle of the `n`-th row (0-based) of the page. */
const row = (n: number) => n * ROW + ROW / 2;

describe('which blocks a rectangle selects (sel.marquee.blocks)', () => {
	it('top-level blocks the rectangle meets, live while it grows and shrinks', async () => {
		const { edytor } = await render([p('A'), p('B'), p('C'), p('D')], [marqueePlugin]);
		press(edytor, 40, row(0));
		await move(150, row(1));
		expect(selected(edytor)).toEqual(['A', 'B']);
		await move(150, row(2));
		expect(selected(edytor)).toEqual(['A', 'B', 'C']);
		await move(150, row(1));
		expect(selected(edytor)).toEqual(['A', 'B']);
		await release(150, row(1));
		expect(edytor.selection.value).toMatchObject({ kind: 'blocks' });
		expect(selected(edytor)).toEqual(['A', 'B']);
	});

	it('nothing before the pointer moves 4px: a shorter drag is a click', async () => {
		const { edytor } = await render([p('A'), p('B')], [marqueePlugin]);
		press(edytor, 40, row(0));
		await move(42, row(0) + 2);
		expect(selected(edytor)).toEqual([]);
		await move(150, row(1));
		expect(selected(edytor)).toEqual(['A', 'B']);
		await release(150, row(1));
	});

	it('a rectangle that meets no block selects nothing', async () => {
		const { edytor } = await render([p('A'), p('B')], [marqueePlugin]);
		press(edytor, 10, row(0));
		await move(60, row(1));
		expect(selected(edytor)).toEqual([]);
		await release(60, row(1));
	});

	it("a block's own row selects it with its shown subtree; a child's row, the child alone", async () => {
		const { edytor } = await render([p('P', [p('P1'), p('P2')]), p('Q')], [marqueePlugin]);
		press(edytor, 40, row(0));
		await move(150, row(0) + 5);
		expect(selected(edytor)).toEqual(['P', 'P1', 'P2']);
		await release(150, row(0) + 5);

		// From P2's row (inside P's box, below its own row) to Q's.
		press(edytor, 40, row(2));
		await move(LEFT + INDENT + 20, row(2) + 5);
		expect(selected(edytor)).toEqual(['P2']);
		await move(LEFT + INDENT + 20, row(3));
		expect(selected(edytor)).toEqual(['P2', 'Q']);
		await release(LEFT + INDENT + 20, row(3));
	});

	it('a rectangle over the indent alone reaches no nested block', async () => {
		const { edytor } = await render([p('P', [p('P1')]), p('Q')], [marqueePlugin]);
		press(edytor, 40, row(1));
		await move(LEFT + 10, row(1) + 5);
		expect(selected(edytor)).toEqual([]);
		await release(LEFT + 10, row(1) + 5);
	});

	it('a closed toggle is selected without its hidden body; an open one with it', async () => {
		const { edytor } = await render([toggle('T', [p('T1')]), p('Q')], [marqueePlugin]);
		const details = edytor.idToBlock.get('T')!.node as HTMLDetailsElement;
		details.open = false;
		await flushDomUpdates();
		layout(edytor);
		press(edytor, 40, row(0));
		await move(150, row(1));
		expect(selected(edytor)).toEqual(['T', 'Q']);
		await release(150, row(1));

		details.open = true;
		await flushDomUpdates();
		layout(edytor);
		press(edytor, 40, row(0));
		await move(150, row(2));
		expect(selected(edytor)).toEqual(['T', 'T1', 'Q']);
		await release(150, row(2));
	});

	it('in a layout, the blocks of the columns the rectangle crosses; never the layout or a column', async () => {
		const { edytor } = await render(
			[columns('L', [p('A'), p('A2')], [p('B'), p('B2')]), p('Q')],
			[marqueePlugin]
		);
		// The first column spans x 100–400, the second 400–700.
		press(edytor, 40, row(0));
		await move(250, row(1));
		expect(selected(edytor)).toEqual(['A', 'A2']);
		await move(550, row(1));
		expect(selected(edytor)).toEqual(['A', 'A2', 'B', 'B2']);
		await move(550, row(0) + 5);
		expect(selected(edytor)).toEqual(['A', 'B']);
		await release(550, row(0) + 5);
		expect(edytor.selection.value.kind === 'blocks' && edytor.selection.value.ids).not.toContain(
			'L'
		);
	});

	it('from the right margin, leftwards', async () => {
		const { edytor } = await render([p('A'), p('B'), p('C')], [marqueePlugin]);
		press(edytor, LEFT + WIDTH + 40, row(2));
		await move(LEFT + WIDTH - 50, row(1));
		expect(selected(edytor)).toEqual(['B', 'C']);
		await release(LEFT + WIDTH - 50, row(1));
	});
});

describe('the gesture (sel.marquee)', () => {
	it('Shift or Mod at the press adds to the block selection there was', async () => {
		const { edytor } = await render([p('A'), p('B'), p('C'), p('D')], [marqueePlugin]);
		edytor.selection.selectBlocks(edytor.idToBlock.get('A')!);
		press(edytor, 40, row(2), { shiftKey: true });
		await move(150, row(3));
		expect(selected(edytor)).toEqual(['A', 'C', 'D']);
		await release(150, row(3));

		const mod = edytor.keymap.isMac ? { metaKey: true } : { ctrlKey: true };
		press(edytor, 40, row(1), mod);
		await move(150, row(1) + 5);
		expect(selected(edytor)).toEqual(['A', 'B', 'C', 'D']);
		await release(150, row(1) + 5);
	});

	it('without a modifier the rectangle replaces the selection', async () => {
		const { edytor } = await render([p('A'), p('B'), p('C')], [marqueePlugin]);
		edytor.selection.selectBlocks(edytor.idToBlock.get('A')!);
		press(edytor, 40, row(2));
		await move(150, row(2) + 5);
		expect(selected(edytor)).toEqual(['C']);
		await release(150, row(2) + 5);
	});

	it('Escape mid-drag gives back the selection from before the press and ends the gesture', async () => {
		const { edytor } = await render([p('A'), p('B'), p('C')], [marqueePlugin]);
		const b = edytor.idToBlock.get('B')!;
		edytor.selection.setCaret({ block: b, offset: 1 });
		await flushDomUpdates();
		press(edytor, 40, row(0));
		await move(150, row(2));
		expect(selected(edytor)).toEqual(['A', 'B', 'C']);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await flushDomUpdates();
		expect(selected(edytor)).toEqual([]);
		expect(edytor.selection.caret).toEqual({ block: b, offset: 1 });
		// The rest of the drag selects nothing.
		await move(150, row(1));
		await release(150, row(1));
		expect(edytor.selection.caret).toEqual({ block: b, offset: 1 });
	});

	it('on release the selection stays, the editor has the keys, and Delete removes the blocks', async () => {
		const { edytor } = await render([p('A'), p('B'), p('C'), p('D')], [marqueePlugin]);
		press(edytor, 40, row(1));
		await move(150, row(2));
		await release(150, row(2));
		expect(selected(edytor)).toEqual(['B', 'C']);
		expect(document.activeElement).toBe(edytor.node);
		await dispatchDomKeyDown(edytor.node!, { key: 'Delete' });
		await flushDomUpdates();
		expect(edytor.value.children.map((block) => block.id)).toEqual(['A', 'D']);
	});

	it('the rectangle shows in the overlay while it drags, sized to the drag', async () => {
		const { edytor } = await render([p('A'), p('B')], [marqueePlugin]);
		press(edytor, 40, row(0));
		await move(150, row(1));
		await frame();
		const host = document.querySelector<HTMLElement>('[data-edytor-marquee-host]')!;
		expect(host.querySelector('[data-edytor-marquee]')).not.toBeNull();
		expect(host.style.display).toBe('');
		expect([host.style.left, host.style.top]).toEqual(['40px', `${row(0)}px`]);
		expect([host.style.width, host.style.height]).toEqual(['110px', `${ROW}px`]);
		await release(150, row(1));
		await frame();
		expect(host.querySelector('[data-edytor-marquee]')).toBeNull();
		expect(host.style.display).toBe('none');
	});

	it('a `box` snippet replaces the rectangle and reads its payload', async () => {
		const box = createRawSnippet((payload: () => MarqueeBoxPayload) => ({
			render: () =>
				`<div data-testid="custom-marquee" data-count="${payload().count}" data-adding="${payload().adding}"></div>`
		}));
		const { edytor } = await render([p('A'), p('B')], [createMarqueePlugin({ box })]);
		press(edytor, 40, row(0));
		await move(150, row(1));
		await frame();
		const custom = document.querySelector<HTMLElement>('[data-testid="custom-marquee"]')!;
		expect([custom.dataset.count, custom.dataset.adding]).toEqual(['2', 'false']);
		expect(document.querySelector('[data-edytor-marquee]')).toBeNull();
		await release(150, row(1));
		expect(document.querySelector('[data-testid="custom-marquee"]')).toBeNull();
	});

	it("the press's mousedown is cancelled: no native caret, focus or selection", async () => {
		const { edytor } = await render([p('A'), p('B')], [marqueePlugin]);
		press(edytor, 40, row(0));
		const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
		edytor.node!.dispatchEvent(mousedown);
		expect(mousedown.defaultPrevented).toBe(true);
		const start = new Event('selectstart', { bubbles: true, cancelable: true });
		edytor.node!.dispatchEvent(start);
		expect(start.defaultPrevented).toBe(true);
		await release(40, row(0));
	});

	it('a click below the last block still makes the trailing paragraph (nav.trailing.press)', async () => {
		const { edytor } = await render([p('A'), toggle('T', [])], [marqueePlugin]);
		press(edytor, 300, row(2) + 20);
		await release(300, row(2) + 20);
		expect(edytor.value.children.map((block) => block.type)).toEqual([
			'paragraph',
			'toggle',
			'paragraph'
		]);
		expect(edytor.selection.caret?.block.id).toBe(edytor.value.children[2]!.id);
	});

	it('a drag from below the last block selects instead, writing nothing', async () => {
		const { edytor } = await render([p('A'), p('B')], [marqueePlugin]);
		press(edytor, 300, row(2) + 20);
		await move(250, row(1));
		await release(250, row(1));
		expect(selected(edytor)).toEqual(['B']);
		expect(edytor.value.children.map((block) => block.id)).toEqual(['A', 'B']);
	});

	it('a press on a block or its text starts none', async () => {
		const { edytor } = await render([p('A'), p('B')], [marqueePlugin]);
		press(edytor, 150, row(0), {}, edytor.idToBlock.get('A')!.firstText!.node!);
		await move(150, row(1));
		await release(150, row(1));
		expect(selected(edytor)).toEqual([]);
	});

	it('a touch starts none (it scrolls)', async () => {
		const { edytor } = await render([p('A'), p('B')], [marqueePlugin]);
		press(edytor, 40, row(0), { pointerType: 'touch' });
		await move(150, row(1));
		await release(150, row(1));
		expect(selected(edytor)).toEqual([]);
	});

	it('without the plugin a press in the margin starts none', async () => {
		const { edytor } = await render([p('A'), p('B')]);
		press(edytor, 40, row(0));
		await move(150, row(1));
		await release(150, row(1));
		expect(selected(edytor)).toEqual([]);
	});

	it('a readonly view selects too (copy reads it), and writes nothing', async () => {
		const { edytor } = await render([p('A'), p('B')], [marqueePlugin], true);
		press(edytor, 40, row(0));
		await move(150, row(1));
		await release(150, row(1));
		expect(selected(edytor)).toEqual(['A', 'B']);
		press(edytor, 300, row(2) + 20);
		await release(300, row(2) + 20);
		expect(edytor.value.children.map((block) => block.id)).toEqual(['A', 'B']);
	});

	it("the app's container: a press on it or on a wrapper of the editor starts one, its content's never", async () => {
		const { edytor } = await render(
			[p('A'), p('B')],
			[createMarqueePlugin({ container: (editor) => editor.parentElement })]
		);
		const page = edytor.node!.parentElement!;
		press(edytor, 20, row(0), {}, page);
		await move(150, row(1));
		await release(150, row(1));
		expect(selected(edytor)).toEqual(['A', 'B']);

		edytor.selection.select({ kind: 'none' });
		const title = document.createElement('h1');
		page.prepend(title);
		press(edytor, 20, row(0), {}, title);
		await move(150, row(1));
		await release(150, row(1));
		expect(selected(edytor)).toEqual([]);
	});

	it("the handle gutter: a press on a handle's own box starts one, on its buttons never", async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [marqueePlugin, columnsPlugin, richTextPlugin],
				value: { children: [p('A'), p('B')] },
				autoSelectFixture: false
			}
		);
		const { edytor } = rendered;
		layout(edytor);
		await frame();
		const gutter = document.querySelector<HTMLElement>(
			'[data-edytor-block-handle-host][data-block-id="A"]'
		)!;
		press(edytor, 60, row(0), {}, gutter.querySelector('button')!);
		await move(150, row(1));
		await release(150, row(1));
		expect(selected(edytor)).toEqual([]);
		press(edytor, 60, row(0), {}, gutter);
		await move(150, row(1));
		await release(150, row(1));
		expect(selected(edytor)).toEqual(['A', 'B']);
	});
});

describe("a move's work does not grow with the page (sel.marquee.cost)", () => {
	const page = (blocks: number): JSONDoc => ({
		children: Array.from({ length: blocks }, (_, i) => p(`b${i}`))
	});

	/** One move of a running marquee in the middle of the page: its layout reads and handles. */
	const measure = async (blocks: number) => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>x</paragraph>
			</root>,
			{
				value: page(blocks),
				autoSelectFixture: false,
				plugins: [marqueePlugin, richTextPlugin],
				blockHandles: false
			}
		);
		layout(edytor);
		const middle = Math.floor(blocks / 2);
		press(edytor, 40, row(middle));
		await move(150, row(middle + 1));
		let handles = 0;
		const block = edytor.idToBlock.block;
		edytor.idToBlock.block = (id) => (handles++, block(id));
		reads = 0;
		document.dispatchEvent(pointer('pointermove', 150, row(middle + 3)));
		const counts = { layout: reads, handles };
		edytor.idToBlock.block = block;
		await flushDomUpdates();
		expect(selected(edytor)).toEqual([0, 1, 2, 3].map((i) => `b${middle + i}`));
		await release(150, row(middle + 3));
		return counts;
	};

	it('the same layout reads and handles at 1,000 and 5,000 blocks, within a binary search', async () => {
		const small = await measure(1_000);
		document.body.innerHTML = '';
		const large = await measure(5_000);
		// A binary search over 5,000 boxes reads at most 3 more per bound than over 1,000.
		expect(small.layout).toBeLessThan(60);
		expect(large.layout).toBeLessThanOrEqual(small.layout + 6);
		expect(large.handles).toBeLessThanOrEqual(small.handles + 6);
	});
});
