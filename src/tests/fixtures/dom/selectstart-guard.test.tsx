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
import type { Plugin } from '$lib/plugins.js';
import { card } from './void-card.svelte';

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
		// The image: a void block's chrome. The model answers: the block is selected, no caret (sel.press.void).
		expect(press(wrapper)).toBe(true);
		await flushDomUpdates();
		expect(caret(edytor)).toBeNull();
		expect(edytor.selection.value).toMatchObject({ kind: 'blocks', ids: ['img'] });
		expect(dispatchSelectStart(wrapper)).toBe(true);
	});
});

describe('a press on a void block (sel.press.void)', () => {
	const kinds = (): Plugin => () => ({
		blocks: {
			card: {
				void: true,
				snippet: card
			}
		}
	});
	const mount = () =>
		renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [kinds(), richTextPlugin],
				value: {
					children: [
						{
							id: 'p',
							type: 'paragraph',
							content: [
								{ text: 'a ' },
								{ text: 'link', marks: { link: { href: 'https://example.com' } } }
							]
						},
						{ id: 'c', type: 'card', content: [{ text: 'caption' }] }
					]
				},
				autoSelectFixture: false
			}
		);
	const press = (target: Element, init: PointerEventInit = {}) => {
		const event = new PointerEvent('pointerdown', {
			bubbles: true,
			cancelable: true,
			button: 0,
			...init
		});
		target.dispatchEvent(event);
		return event.defaultPrevented;
	};

	test('its controls own their whole press; its empty area selects it; Shift adds it', async () => {
		const { edytor, editor } = await mount();
		edytor.selection.setCaret({ block: edytor.idToBlock.get('p')!, offset: 1 });
		await flushDomUpdates();
		const value = () => edytor.selection.value;
		for (const selector of [
			'button',
			'input',
			'[role="button"]',
			'[data-edytor-control]',
			'[tabindex="0"]'
		]) {
			const control = editor.querySelector(`[data-card] ${selector}`)!;
			expect(press(control), selector).toBe(false);
			await flushDomUpdates();
			expect(value().kind, selector).toBe('text');
			expect(edytor.selection.dragging, selector).toBe(false);
			expect(dispatchSelectStart(control), selector).toBe(false);
		}
		// The empty area of the card: the block.
		expect(press(editor.querySelector('[data-card-empty]')!)).toBe(true);
		await flushDomUpdates();
		expect(value()).toMatchObject({ kind: 'blocks', ids: ['c'] });
		expect(edytor.selection.dragging).toBe(false);
		// A link mark in the text is the text's, never a control's press.
		expect(edytor.selection.pointer.ownPress(new PointerEvent('pointerdown'))).toBe(false);
		const link = editor.querySelector('[data-edytor-id="p"] a')!;
		const event = new PointerEvent('pointerdown', { bubbles: true });
		Object.defineProperty(event, 'target', { value: link });
		expect(edytor.selection.pointer.ownPress(event)).toBe(false);
	});
});
