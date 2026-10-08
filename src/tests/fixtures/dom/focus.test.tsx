/** @jsxImportSource ../../jsx */
/**
 * `edytor.focus()` (`api.focus`): focuses the view's host keeping its
 * selection, or with no selection puts the caret at the start of the
 * first text; on a readonly view it focuses and selects nothing new.
 */
import { describe, expect, it } from 'vitest';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

describe('api.focus', () => {
	it('with no selection: focuses the host and puts the caret at the start of the first text', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>first</paragraph>
				<paragraph>second</paragraph>
			</root>
		);
		edytor.selection.select({ kind: 'none' });
		(document.activeElement as HTMLElement | null)?.blur();
		edytor.focus();
		await flushDomUpdates();
		expect(document.activeElement).toBe(editor);
		const caret = edytor.selection.caret;
		expect([caret?.block.id, caret?.offset]).toEqual([edytor.root!.children[0].id, 0]);
	});

	it('keeps the selection it has', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>first</paragraph>
				<paragraph>second</paragraph>
			</root>
		);
		const second = edytor.root!.children[1];
		edytor.selection.setCaret({ block: second, offset: 3 });
		const outside = document.body.appendChild(document.createElement('button'));
		outside.focus();
		edytor.focus();
		await flushDomUpdates();
		expect(document.activeElement).toBe(editor);
		const caret = edytor.selection.caret;
		expect([caret?.block.id, caret?.offset]).toEqual([second.id, 3]);
		outside.remove();
	});
});
