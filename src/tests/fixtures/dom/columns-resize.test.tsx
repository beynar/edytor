/** @jsxImportSource ../../jsx */
/**
 * Resizing columns (docs/columns-plan.md D5 and §5 "Resize", C4):
 *
 * - while the pointer is over a layout, the overlay shows a band in each
 *   gap between two adjacent columns (`cursor: col-resize`), the gap's left
 *   `BAND` px (round 5; round 4: where its guide shows, a press resizes),
 *   above the block handles, never inside the host;
 * - dragging a strip shows a guide line and resizes both columns live, a
 *   view-only preview (round 3), and writes nothing;
 * - the release writes the two neighbours' `data.width` weights, keeping
 *   their sum, as one undo step;
 * - neither neighbour goes under `minWidth` (`createColumnsPlugin`, default
 *   10% of the layout), in the view only;
 * - no strip when the view is readonly or the layout stacks (under 480px).
 *
 * jsdom has no layout: the boxes are hand-laid-out. Expected weights come
 * from D5's arithmetic over those boxes, never from a run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { createColumnsPlugin } from '$lib/plugins/columns/ColumnsPlugin.svelte';
import { BAND } from '$lib/plugins/columns/gaps.js';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';
import { block, column, columns, contractDoc, p } from './columns.helpers.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const ROW = 24;
const GAP = 46;

const render = (
	children: JSONBlock[],
	{ readonly = false, minWidth }: { readonly?: boolean; minWidth?: number } = {}
) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [createColumnsPlugin(minWidth === undefined ? {} : { minWidth }), richTextPlugin],
			value: { children },
			readonly,
			autoSelectFixture: false
		}
	);

/**
 * Root rows of 24px from y 0 in a `width` wide editor; a layout's columns
 * side by side, `GAP` apart, sized by their weights (`flex: <w> 1 0`), its
 * blocks stacked in each column.
 */
const layout = (edytor: Edytor, width = 600) => {
	const set = (node: HTMLElement, rect: DOMRect) => (node.getBoundingClientRect = () => rect);
	let y = 0;
	for (const root of edytor.root!.children) {
		const node = root.node!;
		if (root.type !== 'columns') {
			set(node, new DOMRect(0, y, width, ROW));
			y += ROW;
			continue;
		}
		const items = root.children;
		const weights = items.map((item) => (item.data.width as number | undefined) ?? 1);
		const total = weights.reduce((a, b) => a + b, 0);
		const room = width - GAP * (items.length - 1);
		let x = 0;
		let height = 0;
		items.forEach((item, i) => {
			const w = (room * weights[i]!) / total;
			item.children.forEach((child, row) =>
				set(child.node!, new DOMRect(x, y + row * ROW, w, ROW))
			);
			const h = item.children.length * ROW;
			set(item.node!, new DOMRect(x, y, w, h));
			height = Math.max(height, h);
			x += w + GAP;
		});
		set(node, new DOMRect(0, y, width, height));
		y += height;
	}
};

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const pointer = (
	target: EventTarget,
	type: string,
	at: { clientX?: number; clientY?: number } = {}
) =>
	target.dispatchEvent(
		new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, ...at })
	);

/** Hover block `id` (the editor's delegated listener), then let the overlay measure. */
const hover = async (edytor: Edytor, id: string, width?: number) => {
	await flushDomUpdates();
	layout(edytor, width);
	pointer(block(edytor, id).node!, 'pointerover');
	await flushDomUpdates();
	edytor.overlay.invalidate();
	await frame();
	await flushDomUpdates();
};

const strips = () => [...document.querySelectorAll<HTMLElement>('[data-edytor-column-resize]')];
const boxOf = (node: HTMLElement) => {
	const { left, top, width, height } = node.style;
	return [left, top, width, height].map(parseFloat);
};
const guide = () => document.querySelector<HTMLElement>('[data-edytor-column-resize-guide]');
/** The flex grow a column's element shows (its kind's `element`). */
const flexOf = (edytor: Edytor, id: string) =>
	Number(/flex:\s*([\d.e-]+)/.exec(block(edytor, id).node!.getAttribute('style') ?? '')?.[1]);
const textOf = (edytor: Edytor, id: string) =>
	(block(edytor, id).content as { stringContent?: string }[])
		.map((t) => t.stringContent ?? '')
		.join('');
const weights = (edytor: Edytor, ...ids: string[]) =>
	ids.map((id) => block(edytor, id).data.width as number | undefined);

describe('the resize strips', () => {
	it('one col-resize band at each gap’s left part, in the overlay, while the pointer is over the layout', async () => {
		const { edytor, editor } = await render(contractDoc());
		await hover(edytor, 'P');
		expect(strips()).toEqual([]);
		await hover(edytor, 'A');
		const [strip] = strips();
		expect(strips()).toHaveLength(1);
		// C sits at y 24, 48px tall (column 1's two rows); column 1 ends at (600 - 46) / 2 = 277;
		// the band is the gap's left BAND px (round 5).
		expect(boxOf(strip!)).toEqual([277, 24, BAND, 48]);
		expect(strip!.style.cursor).toBe('col-resize');
		expect(editor.contains(strip!)).toBe(false);
		expect(strip!.closest('[data-edytor-overlay]')).not.toBeNull();
		pointer(editor, 'pointerleave');
		await flushDomUpdates();
		expect(strips()).toEqual([]);
	});

	it('a layout of three columns has two strips', async () => {
		const { edytor } = await render([
			columns('C', column('K1', [p('A')]), column('K2', [p('B')]), column('K3', [p('D')]))
		]);
		await hover(edytor, 'B');
		// Each column (600 - 92) / 3 wide.
		const each = (600 - 2 * GAP) / 3;
		expect(strips().map((strip) => boxOf(strip)[0])).toEqual([each, 2 * each + GAP]);
	});

	it('none when readonly', async () => {
		const { edytor } = await render(contractDoc(), { readonly: true });
		await hover(edytor, 'A');
		expect(strips()).toEqual([]);
	});

	it('none when the layout stacks (under 480px wide)', async () => {
		const { edytor } = await render(contractDoc());
		await hover(edytor, 'A', 400);
		expect(strips()).toEqual([]);
	});
});

describe('dragging a strip', () => {
	it('shows a guide and writes nothing until the release, which writes both weights, keeping their sum, one undo step', async () => {
		const { edytor } = await render(contractDoc());
		await hover(edytor, 'A');
		const [strip] = strips();
		let changes = 0;
		const off = edytor.facade.onChange(() => changes++);
		pointer(strip!, 'pointerdown', { clientX: 281, clientY: 40 });
		pointer(strip!, 'pointermove', { clientX: 331, clientY: 40 });
		pointer(strip!, 'pointermove', { clientX: 381, clientY: 40 });
		await frame();
		await flushDomUpdates();
		// Column 1 grows by 100px (277 → 377): the guide sits in the middle of the gap after it.
		expect(guide()).not.toBeNull();
		expect(boxOf(guide()!).slice(0, 2)).toEqual([377 + GAP / 2 - 1, 24]);
		expect(changes).toBe(0);
		expect(weights(edytor, 'K1', 'K2')).toEqual([undefined, undefined]);
		// Both columns resize live (round 3): the columns' elements show the
		// drag's weights, a preview of this view only.
		expect(flexOf(edytor, 'K1')).toBeCloseTo((2 * 377) / 554, 10);
		expect(flexOf(edytor, 'K2')).toBeCloseTo((2 * 177) / 554, 10);
		pointer(strip!, 'pointerup', { clientX: 381, clientY: 40 });
		await flushDomUpdates();
		off();
		expect(guide()).toBeNull();
		// The stored weights replace the preview: the same widths.
		expect(flexOf(edytor, 'K1')).toBeCloseTo((2 * 377) / 554, 10);
		// The pair's weights (1 + 1) split as 377 : 177.
		const [k1, k2] = weights(edytor, 'K1', 'K2') as number[];
		expect(k1).toBeCloseTo((2 * 377) / 554, 10);
		expect(k2).toBeCloseTo((2 * 177) / 554, 10);
		expect(k1! + k2!).toBeCloseTo(2, 10);
		expect(changes).toBe(1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(weights(edytor, 'K1', 'K2')).toEqual([undefined, undefined]);
	});

	it('Escape mid-drag puts the shown widths back and writes nothing (round 3)', async () => {
		const { edytor } = await render(contractDoc());
		await hover(edytor, 'A');
		const [strip] = strips();
		const before = edytor.facade.version;
		pointer(strip!, 'pointerdown', { clientX: 281, clientY: 40 });
		pointer(strip!, 'pointermove', { clientX: 331, clientY: 40 });
		await flushDomUpdates();
		expect(flexOf(edytor, 'K1')).toBeCloseTo((2 * 327) / 554, 10);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await flushDomUpdates();
		expect([flexOf(edytor, 'K1'), flexOf(edytor, 'K2')]).toEqual([1, 1]);
		pointer(strip!, 'pointerup', { clientX: 331, clientY: 40 });
		await flushDomUpdates();
		expect(edytor.facade.version).toBe(before);
		expect(weights(edytor, 'K1', 'K2')).toEqual([undefined, undefined]);
		expect([flexOf(edytor, 'K1'), flexOf(edytor, 'K2')]).toEqual([1, 1]);
	});

	it('writes only the two neighbours, keeping their sum among other weights', async () => {
		const { edytor } = await render([
			columns('C', column('K1', [p('A')], 2), column('K2', [p('B')], 1), column('K3', [p('D')], 1))
		]);
		await hover(edytor, 'B');
		// Room 508px: K1 254, K2 127, K3 127; the second strip is K2 | K3.
		const strip = strips()[1]!;
		expect(boxOf(strip)[0]).toBe(254 + GAP + 127);
		pointer(strip, 'pointerdown', { clientX: 430, clientY: 10 });
		pointer(strip, 'pointermove', { clientX: 400, clientY: 10 });
		pointer(strip, 'pointerup', { clientX: 400, clientY: 10 });
		await flushDomUpdates();
		const [k1, k2, k3] = weights(edytor, 'K1', 'K2', 'K3') as number[];
		expect(k1).toBe(2);
		expect(k2).toBeCloseTo((2 * 97) / 254, 10);
		expect(k3).toBeCloseTo((2 * 157) / 254, 10);
	});

	it('stops at the minimum width, 10% of the layout by default', async () => {
		const { edytor } = await render(contractDoc());
		await hover(edytor, 'A');
		const [strip] = strips();
		pointer(strip!, 'pointerdown', { clientX: 281, clientY: 40 });
		pointer(strip!, 'pointermove', { clientX: 281 + 250, clientY: 40 });
		pointer(strip!, 'pointerup', { clientX: 281 + 250, clientY: 40 });
		await flushDomUpdates();
		// Column 2 stops at 60px (10% of 600): column 1 at 554 - 60 = 494.
		const [k1, k2] = weights(edytor, 'K1', 'K2') as number[];
		expect(k1).toBeCloseTo((2 * 494) / 554, 10);
		expect(k2).toBeCloseTo((2 * 60) / 554, 10);
	});

	it('takes the minimum from createColumnsPlugin({ minWidth })', async () => {
		const { edytor } = await render(contractDoc(), { minWidth: 0.3 });
		await hover(edytor, 'A');
		const [strip] = strips();
		pointer(strip!, 'pointerdown', { clientX: 281, clientY: 40 });
		pointer(strip!, 'pointermove', { clientX: 381, clientY: 40 });
		pointer(strip!, 'pointerup', { clientX: 381, clientY: 40 });
		await flushDomUpdates();
		// 30% of 600 = 180px: column 2 stops there, column 1 at 374.
		const [k1, k2] = weights(edytor, 'K1', 'K2') as number[];
		expect(k1).toBeCloseTo((2 * 374) / 554, 10);
		expect(k2).toBeCloseTo((2 * 180) / 554, 10);
	});

	it('the release gives the keys to the editor: Mod+Z and Mod+Shift+Z at once, no caret adopted (round 3)', async () => {
		const { edytor, editor } = await render(contractDoc());
		await hover(edytor, 'A');
		const [strip] = strips();
		expect(document.activeElement).not.toBe(editor);
		pointer(strip!, 'pointerdown', { clientX: 281, clientY: 40 });
		pointer(strip!, 'pointermove', { clientX: 331, clientY: 40 });
		pointer(strip!, 'pointerup', { clientX: 331, clientY: 40 });
		await flushDomUpdates();
		const resized = weights(edytor, 'K1', 'K2');
		expect(resized[0]).toBeCloseTo((2 * 327) / 554, 10);
		expect(document.activeElement).toBe(editor);
		expect(edytor.selection.value.kind).toBe('none');
		await dispatchDomKeyDown(document.activeElement as HTMLElement, { key: 'z', ctrlKey: true });
		await flushDomUpdates();
		expect(weights(edytor, 'K1', 'K2')).toEqual([undefined, undefined]);
		await dispatchDomKeyDown(document.activeElement as HTMLElement, {
			key: 'z',
			ctrlKey: true,
			shiftKey: true
		});
		await flushDomUpdates();
		expect(weights(edytor, 'K1', 'K2')).toEqual(resized);
	});

	it('typing right after a resize is a step of its own (round 4, issue 3)', async () => {
		const { edytor, editor } = await render(contractDoc());
		const b = block(edytor, 'B');
		await setNativeSelection(edytor, b.content[0] as never, 1);
		await hover(edytor, 'A');
		const [strip] = strips();
		pointer(strip!, 'pointerdown', { clientX: 281, clientY: 40 });
		pointer(strip!, 'pointermove', { clientX: 331, clientY: 40 });
		pointer(strip!, 'pointerup', { clientX: 331, clientY: 40 });
		await flushDomUpdates();
		const resized = weights(edytor, 'K1', 'K2');
		expect(resized[0]).toBeCloseTo((2 * 327) / 554, 10);
		// The caret stayed at B's end: typing there.
		expect(edytor.selection.value.kind).toBe('text');
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'k' });
		expect(textOf(edytor, 'B')).toBe('bk');
		edytor.historyUndo();
		await flushDomUpdates();
		// One undo takes back the typing alone; the next, the resize.
		expect(textOf(edytor, 'B')).toBe('b');
		expect(weights(edytor, 'K1', 'K2')).toEqual(resized);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(weights(edytor, 'K1', 'K2')).toEqual([undefined, undefined]);
	});

	it('the view turning readonly mid-drag drops the preview at once; moves and the release change nothing (round 4, issue 4)', async () => {
		const { edytor } = await render(contractDoc());
		await hover(edytor, 'A');
		const [strip] = strips();
		pointer(strip!, 'pointerdown', { clientX: 281, clientY: 40 });
		pointer(strip!, 'pointermove', { clientX: 331, clientY: 40 });
		await frame();
		await flushDomUpdates();
		expect(flexOf(edytor, 'K1')).toBeCloseTo((2 * 327) / 554, 10);
		edytor.readonly = true;
		await flushDomUpdates();
		expect([flexOf(edytor, 'K1'), flexOf(edytor, 'K2')]).toEqual([1, 1]);
		expect(guide()).toBeNull();
		pointer(strip!, 'pointermove', { clientX: 381, clientY: 40 });
		await frame();
		await flushDomUpdates();
		expect([flexOf(edytor, 'K1'), flexOf(edytor, 'K2')]).toEqual([1, 1]);
		pointer(strip!, 'pointerup', { clientX: 381, clientY: 40 });
		await flushDomUpdates();
		expect(weights(edytor, 'K1', 'K2')).toEqual([undefined, undefined]);
		// Editable again: no drag survived.
		edytor.readonly = false;
		await flushDomUpdates();
		pointer(document, 'pointermove', { clientX: 431, clientY: 40 });
		await frame();
		await flushDomUpdates();
		expect([flexOf(edytor, 'K1'), flexOf(edytor, 'K2')]).toEqual([1, 1]);
	});

	it('a release where it started writes nothing', async () => {
		const { edytor } = await render(contractDoc());
		await hover(edytor, 'A');
		const [strip] = strips();
		const before = edytor.facade.version;
		pointer(strip!, 'pointerdown', { clientX: 281, clientY: 40 });
		pointer(strip!, 'pointerup', { clientX: 281, clientY: 40 });
		await flushDomUpdates();
		expect(edytor.facade.version).toBe(before);
		expect(weights(edytor, 'K1', 'K2')).toEqual([undefined, undefined]);
	});
});
