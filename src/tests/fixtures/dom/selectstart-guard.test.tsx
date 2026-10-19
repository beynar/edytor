/** @jsxImportSource ../../jsx */
/**
 * `selectstart` guard on non-editable chrome.
 *
 * `selectstart` is the only event fired before a drag-selection begins.
 * Letting one start on `contenteditable=false` chrome (inline atoms,
 * void/island chrome, block handles, placeholders) anchors the DOM
 * selection on nodes the model cannot represent — the editor prevents
 * it there, while native controls (todo checkboxes) and editable text
 * (including void captions that re-enable contenteditable) keep theirs.
 */
import { describe, expect, test } from 'vitest';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';
import { image as createImagePlugin, richTextPlugin } from '$registry/edytor/chrome/plugins.js';

const dispatchSelectStart = (target: Element) => {
	const event = new Event('selectstart', { bubbles: true, cancelable: true });
	target.dispatchEvent(event);
	return event.defaultPrevented;
};

describe('selectstart guard', () => {
	test('prevents selection start on inline atoms and chrome, allows text and native controls', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<todo-item checked={false}>task text</todo-item>
				<paragraph>
					he
					<mention />
					llo
				</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { editor } = rendered;

		// Inline atom — contenteditable=false chrome → prevented.
		const atom = editor.querySelector('[data-edytor-inline-block]');
		expect(atom).not.toBeNull();
		expect(dispatchSelectStart(atom!)).toBe(true);

		// Render anchor — non-editable utility span → prevented.
		const anchor = editor.querySelector('[data-edytor-render-anchor]');
		expect(anchor).not.toBeNull();
		expect(dispatchSelectStart(anchor!)).toBe(true);

		// Native control inside a todo-item → keeps native selection.
		const checkbox = editor.querySelector('input[type="checkbox"]');
		expect(checkbox).not.toBeNull();
		expect(dispatchSelectStart(checkbox!)).toBe(false);

		// Editable text → allowed.
		const text = editor.querySelector('[data-edytor-text="true"]');
		expect(text).not.toBeNull();
		expect(dispatchSelectStart(text!)).toBe(false);
	});
});

describe('a press in a nested editable (sel.press.nested-editable)', () => {
	const src =
		'data:image/svg+xml,' +
		encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>');
	const mount = () =>
		renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [richTextPlugin, createImagePlugin({})],
				value: {
					children: [
						{ id: 'p', type: 'paragraph', content: [{ text: 'before' }] },
						{ id: 'img', type: 'image', data: { src }, content: [{ text: 'a caption' }] }
					]
				},
				autoSelectFixture: false
			}
		);
	const press = (target: Element) => {
		const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
		target.dispatchEvent(event);
		return event.defaultPrevented;
	};
	const caret = (edytor: Awaited<ReturnType<typeof mount>>['edytor']) => {
		const at = edytor.selection.caret;
		return at && [at.block.id, at.offset];
	};

	test('the caption is no chrome: its press and its drag are the browser’s; the image’s are chrome', async () => {
		const { edytor, editor } = await mount();
		edytor.selection.setCaret({ block: edytor.idToBlock.get('p')!, offset: 2 });
		await flushDomUpdates();
		const caption = editor.querySelector('[data-edytor-type="image"] [data-edytor-text="true"]')!;
		const wrapper = editor.querySelector('[data-edytor-image]')!;
		// The nearest boundary of the caption is its own editable span, inside the void's chrome.
		expect(caption.closest('[contenteditable="false"]')).not.toBeNull();
		expect(press(caption)).toBe(false);
		await flushDomUpdates();
		expect(caret(edytor)).toEqual(['p', 2]);
		expect(dispatchSelectStart(caption)).toBe(false);
		// The image: chrome. The model answers, the caret at the caption's start.
		expect(press(wrapper)).toBe(true);
		await flushDomUpdates();
		expect(caret(edytor)).toEqual(['img', 0]);
		expect(dispatchSelectStart(wrapper)).toBe(true);
	});
});
