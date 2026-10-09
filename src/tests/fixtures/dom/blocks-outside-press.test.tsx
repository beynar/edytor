/** @jsxImportSource ../../jsx */
/**
 * `sel.blocks.outside` (docs/editor-delete-contract.md): a press outside the
 * view and its overlay ends a block selection, however it was made (here:
 * `selectBlocks`, as the handles' Shift-click and Mod+A do; the marquee's
 * browser rows are `tests/editor-dom/marquee.spec.ts`). Shift or Mod, and an
 * app element marked `data-edytor-keep-selection`, keep it; a press in the
 * overlay (a menu, a handle) keeps it; a text selection is not touched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const render = () =>
	renderDomEdytor(
		<root>
			<paragraph>a|</paragraph>
			<paragraph>b</paragraph>
			<paragraph>c</paragraph>
		</root>
	);

const press = async (target: Element, init: MouseEventInit = {}) => {
	target.dispatchEvent(
		new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, button: 0, ...init })
	);
	await flushDomUpdates();
};

const outsideButton = (keep = false) => {
	const button = document.createElement('button');
	if (keep) button.dataset.edytorKeepSelection = '';
	document.body.append(button);
	return button;
};

describe('sel.blocks.outside — a press outside the view ends its block selection', () => {
	it('a press on the page outside the editor: the selection is none', async () => {
		const { edytor } = await render();
		const [a, b] = edytor.root!.children;
		edytor.selection.selectBlocks(a!, b!);
		await flushDomUpdates();
		expect(edytor.selection.selectedBlocks.size).toBe(2);
		await press(outsideButton());
		expect(edytor.selection.value.kind).toBe('none');
		expect(edytor.selection.selectedBlocks.size).toBe(0);
	});

	it('Shift, Mod, a keep-selection element and the overlay keep it', async () => {
		const { edytor } = await render();
		const [a, b] = edytor.root!.children;
		edytor.selection.selectBlocks(a!, b!);
		await flushDomUpdates();
		await press(outsideButton(), { shiftKey: true });
		await press(outsideButton(), { metaKey: true });
		await press(outsideButton(), { ctrlKey: true });
		await press(outsideButton(true));
		const inLayer = document.createElement('div');
		edytor.overlay.layer!.append(inLayer);
		await press(inLayer);
		expect(edytor.selection.value.kind).toBe('blocks');
		expect(edytor.selection.selectedBlocks.size).toBe(2);
	});

	it('a text selection is left to the browser', async () => {
		const { edytor } = await render();
		const before = edytor.selection.value;
		expect(before.kind).toBe('text');
		await press(outsideButton());
		expect(edytor.selection.value).toBe(before);
	});
});
