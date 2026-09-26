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
import { renderDomEdytor } from '../../dom/test.utils.js';

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
