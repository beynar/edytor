/** @jsxImportSource ../../jsx */
/**
 * A mouse text selection crossing into another column becomes a block
 * selection (Notion, `sel.drag.across-columns`, round 8): while a pointer
 * drag-selection has its anchor in one column and its focus in another
 * column of the same layout, the value is a block selection of every shown
 * block from the anchor's block to the focus's, in reading order (never the
 * layout or a column); back in the anchor's column it is a text range
 * again; a drag that starts outside the layout, and a range no drag made
 * (a script's, the keyboard's), stay text ranges. The browser lanes
 * (`columns-round8.spec.ts`) drive the real drag; here the press is
 * dispatched and the native range set as the browser would extend it.
 *
 * `P "p", C[K1[A "a", A2 "a2"], K2[B "b"]], Z "z"`. Expected states are
 * hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { acrossColumns, liftLayouts } from '$lib/selection/replaceSelection.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { flushDomUpdates } from '../../dom/test.utils.js';
import { block, contractDoc, renderColumns } from './columns.helpers.js';

afterEach(() => {
	delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
	document.body.innerHTML = '';
});

const ids = (blocks: { id: string }[] | null) => blocks?.map((b) => b.id) ?? null;

describe('acrossColumns: the blocks a drag from one column into another covers', () => {
	it('forward and backward: every shown block between, in reading order, no layout or column', async () => {
		const { edytor } = await renderColumns(contractDoc());
		const at = (id: string) => block(edytor, id);
		expect(ids(acrossColumns(at('A2'), at('B')))).toEqual(['A2', 'B']);
		expect(ids(acrossColumns(at('A'), at('B')))).toEqual(['A', 'A2', 'B']);
		expect(ids(acrossColumns(at('B'), at('A')))).toEqual(['A', 'A2', 'B']);
	});

	it('one column, or a focus outside the layout, or an anchor outside it: none (a text range)', async () => {
		const { edytor } = await renderColumns(contractDoc());
		const at = (id: string) => block(edytor, id);
		expect(acrossColumns(at('A'), at('A2'))).toBeNull();
		expect(acrossColumns(at('A'), at('Z'))).toBeNull();
		expect(acrossColumns(at('P'), at('B'))).toBeNull();
		expect(acrossColumns(at('P'), at('Z'))).toBeNull();
	});

	it('a sweep over every block of every column lifts to the layout (D3)', async () => {
		const { edytor } = await renderColumns(contractDoc());
		const blocks = acrossColumns(block(edytor, 'A'), block(edytor, 'B'))!;
		expect(ids(liftLayouts(blocks))).toEqual(['C']);
	});
});

/** The first text leaf of block `id`. */
const leaf = (edytor: Edytor, id: string) =>
	document.createTreeWalker(block(edytor, id).firstText!.node!, NodeFilter.SHOW_TEXT).nextNode()!;

/** A primary press on `id`'s text at `offset`: a pointer drag-selection begins there. */
const press = async (edytor: Edytor, id: string, offset: number) => {
	const node = leaf(edytor, id);
	Object.assign(document, { caretPositionFromPoint: () => ({ offsetNode: node, offset }) });
	block(edytor, id).firstText!.node!.dispatchEvent(
		new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 })
	);
	const selection = getSelection()!;
	selection.removeAllRanges();
	selection.collapse(node, offset);
	document.dispatchEvent(new Event('selectionchange'));
	await flushDomUpdates();
	return { node, offset };
};

/** The native range extended from the press to `id`'s text at `offset`, as the browser does. */
const extend = async (
	from: { node: Node; offset: number },
	edytor: Edytor,
	id: string,
	offset: number
) => {
	getSelection()!.setBaseAndExtent(from.node, from.offset, leaf(edytor, id), offset);
	document.dispatchEvent(new Event('selectionchange'));
	await flushDomUpdates();
};

const mark = (edytor: Edytor) => edytor.node!.getAttribute('data-edytor-selection');

describe('a pointer drag-selection crossing into another column', () => {
	it('selects blocks while it is in the other column, a text range back in its own; released, the blocks stay', async () => {
		const { edytor } = await renderColumns(contractDoc());
		const from = await press(edytor, 'A', 1);
		expect(edytor.selection.dragging).toBe(true);
		await extend(from, edytor, 'A2', 1);
		expect(edytor.selection.value).toMatchObject({ kind: 'text' });
		expect(mark(edytor)).toBeNull();
		await extend(from, edytor, 'B', 1);
		expect(edytor.selection.value).toMatchObject({ kind: 'blocks', ids: ['A', 'A2', 'B'] });
		expect(mark(edytor)).toBe('blocks');
		// Back into column 1, the same drag: a text range from the press.
		await extend(from, edytor, 'A2', 2);
		expect(edytor.selection.value.kind).toBe('text');
		expect(edytor.selection.state).toMatchObject({
			startBlock: block(edytor, 'A'),
			yStart: 1,
			endBlock: block(edytor, 'A2'),
			yEnd: 2
		});
		expect(mark(edytor)).toBeNull();
		await extend(from, edytor, 'B', 1);
		expect(edytor.selection.value).toMatchObject({ kind: 'blocks', ids: ['A', 'A2', 'B'] });
		// Released: the block selection stays, the native range it ignored goes.
		edytor.node!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
		await flushDomUpdates();
		expect(edytor.selection.dragging).toBe(false);
		expect(edytor.selection.value).toMatchObject({ kind: 'blocks', ids: ['A', 'A2', 'B'] });
		const dom = getSelection()!;
		expect(dom.rangeCount === 0 || !edytor.node!.contains(dom.anchorNode)).toBe(true);
	});

	it('a drag that starts outside the layout stays a text range in it', async () => {
		const { edytor } = await renderColumns(contractDoc());
		const from = await press(edytor, 'P', 0);
		await extend(from, edytor, 'B', 1);
		expect(edytor.selection.value.kind).toBe('text');
		expect(edytor.selection.state).toMatchObject({
			startBlock: block(edytor, 'P'),
			endBlock: block(edytor, 'B')
		});
		document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
	});

	it('a Shift+click in another column (the range anchored before the press) stays a text range', async () => {
		const { edytor } = await renderColumns(contractDoc());
		const caret = await press(edytor, 'A', 1);
		edytor.node!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
		await flushDomUpdates();
		// The press lands in B; the browser extends the range from A's caret.
		await press(edytor, 'B', 1);
		await extend(caret, edytor, 'B', 1);
		expect(edytor.selection.value.kind).toBe('text');
		expect(edytor.selection.state).toMatchObject({
			startBlock: block(edytor, 'A'),
			endBlock: block(edytor, 'B')
		});
		document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
	});

	it('a range across columns no drag made (a script’s) stays a text range in document order', async () => {
		const { edytor } = await renderColumns(contractDoc());
		getSelection()!.setBaseAndExtent(leaf(edytor, 'A'), 1, leaf(edytor, 'B'), 1);
		document.dispatchEvent(new Event('selectionchange'));
		await flushDomUpdates();
		expect(edytor.selection.dragging).toBe(false);
		expect(edytor.selection.value.kind).toBe('text');
		expect(edytor.selection.state).toMatchObject({
			startBlock: block(edytor, 'A'),
			endBlock: block(edytor, 'B')
		});
	});
});
