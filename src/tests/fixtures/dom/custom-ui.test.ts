/**
 * Default plugins, and the UI plugins' snippets: a slash row, the toolbar,
 * the block handle and the block menu each render your markup while the
 * plugins keep the behavior (commands, marks, grips, block actions).
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import CustomUi from '../../dom/CustomUi.svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import { dispatchDomBeforeInput, flushDomUpdates } from '../../dom/test.utils.js';

const setup = async (children = [{ id: 'a', type: 'paragraph', content: [{ text: 'hello' }] }]) => {
	let edytor: Edytor | undefined;
	render(CustomUi, {
		props: {
			value: { children },
			get edytor() {
				return edytor;
			},
			set edytor(value) {
				edytor = value;
			}
		}
	});
	await flushDomUpdates();
	return { edytor: edytor!, editor: document.querySelector<HTMLElement>('[data-edytor]')! };
};

const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = async (element: Element) => {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};

describe('default plugins', () => {
	it('rich text, images and block moves come without listing them', async () => {
		const { edytor } = await setup();
		expect(edytor.blocks.has('heading')).toBe(true);
		expect(edytor.blocks.has('image')).toBe(true);
		expect(edytor.commands.has('block.image')).toBe(true);
	});
});

describe('UI snippets', () => {
	it('a slash row snippet renders the commands and runs them', async () => {
		const { edytor, editor } = await setup([
			{ id: 'a', type: 'paragraph', content: [{ text: '' }] }
		]);
		edytor.selection.setAtTextOffset(edytor.root!.children[0]!.firstText!, 0);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '/' });
		const rows = all('custom-slash');
		expect(rows.map((r) => r.textContent)).toContain('Heading 1');
		expect(rows[0]!.dataset.selected).toBe('true');
		await click(rows.find((r) => r.textContent === 'Heading 1')!);
		expect(edytor.value.children?.[0]).toMatchObject({ type: 'heading', data: { level: 'h1' } });
	});

	it('a toolbar snippet shows over a selection and formats it', async () => {
		const { edytor } = await setup();
		const text = edytor.root!.children[0]!.firstText!;
		edytor.selection.setAtRange(text, 0, text, 5);
		await flushDomUpdates();
		await click(all('custom-toolbar')[0]!.querySelector('button')!);
		expect(edytor.value.children?.[0]?.content).toEqual([{ text: 'hello', marks: { bold: true } }]);
	});

	it('a handle snippet grips its block: the click opens the block menu snippet', async () => {
		const { edytor } = await setup([
			{ id: 'a', type: 'paragraph', content: [{ text: 'one' }] },
			{ id: 'b', type: 'quote', content: [{ text: 'two' }] }
		]);
		await click(all('custom-grip').find((g) => g.dataset.id === 'b')!);
		const menu = all('custom-block-menu')[0]!;
		expect(menu.textContent).toContain('quote');
		await click(menu.querySelector('button')!);
		expect(edytor.value.children?.map((b) => b.id)).toEqual(['a']);
	});

	it("the handle snippet's add opens the slash menu on a new block", async () => {
		const { edytor } = await setup();
		await click(all('custom-add')[0]!);
		await flushDomUpdates();
		expect(edytor.value.children).toHaveLength(2);
		expect(all('custom-slash').length).toBeGreaterThan(0);
	});
});
