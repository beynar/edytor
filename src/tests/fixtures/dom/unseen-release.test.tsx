/** @jsxImportSource ../../jsx */
/**
 * A release the page never sees (`sel.drag.unseen-release`): a pointer drag
 * released over a frame of another origin, or outside the window, sends the
 * page no `pointerup`. The projector does not display under a drag, so the
 * next pointer move with no button down ends it; a move with a button down
 * is the drag going on.
 */
import { describe, expect, it } from 'vitest';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

describe('sel.drag.unseen-release', () => {
	it('a move with no button down ends a drag whose release never came', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>alpha|</paragraph>
				<paragraph>bravo</paragraph>
			</root>
		);
		const text = edytor.root!.children[0]!.firstText!.node!;
		const leaf = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode()!;
		Object.assign(document, { caretPositionFromPoint: () => ({ offsetNode: leaf, offset: 2 }) });
		text.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				button: 0,
				buttons: 1,
				clientX: 5,
				clientY: 5
			})
		);
		await flushDomUpdates();
		expect(edytor.selection.dragging).toBe(true);
		document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1 }));
		expect(edytor.selection.dragging).toBe(true);
		document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 0 }));
		expect(edytor.selection.dragging).toBe(false);
	});
});
