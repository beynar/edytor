/** @jsxImportSource ../../jsx */
/**
 * The block-selection arrows over a layout (as Notion): Shift+↑/↓ extends a
 * block selection to the next shown block in reading order and ArrowUp/Down
 * moves a single one there, never onto a layout or a column, which show no
 * line of their own and no highlight; a selection holding every block of
 * every column stands for the layout (`liftLayouts`), so Backspace deletes
 * exactly what is highlighted. A grip click no menu answers puts the
 * keyboard in the editor, so those keys act on the block it selected.
 *
 * `P "p", C[K1[A "a", A2 "a2"], K2[B "b"]], Z "z"`. Expected states are
 * hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { blockHandlesPlugin } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { dispatchDomKeyDown, flushDomUpdates } from '../../dom/test.utils.js';
import { block, contractDoc, renderColumns, selected, tree } from './columns.helpers.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const key = (key: string, shiftKey = false) => dispatchDomKeyDown(document, { key, shiftKey });

const start = async (...ids: string[]) => {
	const view = await renderColumns(contractDoc());
	view.edytor.selection.selectBlocks(...ids.map((id) => block(view.edytor, id)));
	await flushDomUpdates();
	return view;
};

describe('Shift+↑/↓ over a block selection never selects a layout or a column', () => {
	it("from column 1's last block: the next column's first block", async () => {
		const { edytor } = await start('A2');
		await key('ArrowDown', true);
		expect(selected(edytor)).toEqual(['A2', 'B']);
		await key('ArrowDown', true);
		expect(selected(edytor)).toEqual(['A2', 'B', 'Z']);
	});

	it('from the block before the layout: column 1’s first block', async () => {
		const { edytor } = await start('P');
		await key('ArrowDown', true);
		expect(selected(edytor)).toEqual(['P', 'A']);
		await key('ArrowDown', true);
		await key('ArrowDown', true);
		await key('ArrowDown', true);
		expect(selected(edytor)).toEqual(['P', 'A', 'A2', 'B', 'Z']);
	});

	it('upward: the previous column’s last block, then the block before the layout', async () => {
		const { edytor } = await start('Z');
		await key('ArrowUp', true);
		expect(selected(edytor)).toEqual(['B', 'Z']);
		await key('ArrowUp', true);
		expect(selected(edytor)).toEqual(['A2', 'B', 'Z']);
		await key('ArrowUp', true);
		await key('ArrowUp', true);
		expect(selected(edytor)).toEqual(['P', 'A', 'A2', 'B', 'Z']);
		// Back toward the anchor shrinks it, one block at a time.
		await key('ArrowDown', true);
		expect(selected(edytor)).toEqual(['A', 'A2', 'B', 'Z']);
	});

	it('Backspace after extending deletes exactly the highlighted blocks', async () => {
		const { edytor } = await start('A2');
		await key('ArrowDown', true);
		await key('Backspace');
		// B was its column's only block: the column goes, the layout dissolves.
		expect(tree(edytor)).toEqual(['P', 'A', 'Z']);
	});
});

describe('ArrowUp/Down over a single selected block never lands on a layout or a column', () => {
	it('down from column 1’s last block: column 2’s first; up from it: back', async () => {
		const { edytor } = await start('A2');
		await key('ArrowDown');
		expect(selected(edytor)).toEqual(['B']);
		await key('ArrowUp');
		expect(selected(edytor)).toEqual(['A2']);
	});

	it('down from the block before the layout: column 1’s first; up from it: back', async () => {
		const { edytor } = await start('P');
		await key('ArrowDown');
		expect(selected(edytor)).toEqual(['A']);
		await key('ArrowUp');
		expect(selected(edytor)).toEqual(['P']);
	});

	it('up from the block after the layout: the last column’s last block', async () => {
		const { edytor } = await start('Z');
		await key('ArrowUp');
		expect(selected(edytor)).toEqual(['B']);
	});
});

describe('a grip click with no menu answering: the keys act on the selected block (Notion)', () => {
	const gripOf = (id: string) =>
		document.querySelector<HTMLElement>(`[data-testid="block-handle"][data-block-id="${id}"]`)!;
	const press = async (node: HTMLElement) => {
		node.focus();
		node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();
	};

	it('focus moves to the editor: Shift+↓ extends, Backspace deletes the selection', async () => {
		const { edytor, editor } = await renderColumns(contractDoc(), [blockHandlesPlugin]);
		await flushDomUpdates();
		await press(gripOf('P'));
		expect(selected(edytor)).toEqual(['P']);
		expect(document.activeElement).toBe(editor);
		await dispatchDomKeyDown(document.activeElement as HTMLElement, {
			key: 'ArrowDown',
			shiftKey: true
		});
		expect(selected(edytor)).toEqual(['P', 'A']);
		await dispatchDomKeyDown(document.activeElement as HTMLElement, { key: 'Backspace' });
		expect(edytor.idToBlock.get('P')?.isInTree ?? false).toBe(false);
		expect(edytor.idToBlock.get('A')?.isInTree ?? false).toBe(false);
	});

	it('a block menu answering keeps the keyboard (its search field)', async () => {
		const { edytor, editor } = await renderColumns(contractDoc(), [
			blockHandlesPlugin,
			blockMenuPlugin
		]);
		await flushDomUpdates();
		await press(gripOf('P'));
		expect(selected(edytor)).toEqual(['P']);
		expect(document.activeElement).not.toBe(editor);
		expect(document.querySelector('[data-testid="block-menu"]')).not.toBeNull();
	});
});
