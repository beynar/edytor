/** @jsxImportSource ../../jsx */
/**
 * A press on an inline atom selects it (`InlineBlock.attach`), and the caret
 * the browser parks for that press is its own (`projector.parked`): Chromium
 * places one at the host's start after the atom's `pointerdown` cleared the
 * DOM selection, and reports it a frame later, after the release marked a
 * gesture. That `selectionchange` is drift (displayed over: the atom stays
 * selected and the host shows no range), never adopted as a text caret. The
 * next press inside the host is the user's again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import { flushDomUpdates, renderDomEdytor, textNodeOf } from '../../dom/test.utils.js';

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

const render = () =>
	renderDomEdytor(<root></root>, {
		value: {
			children: [
				{ type: 'paragraph', content: [{ text: 'first' }] },
				{
					type: 'paragraph',
					content: [{ text: 'lead ' }, { type: 'mention', data: {} }, { text: ' end' }]
				}
			]
		},
		autoSelectFixture: false
	});

type Rendered = Awaited<ReturnType<typeof render>>;

const leafOf = (node: HTMLElement) =>
	document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode() ?? node;

const pointer = (type: string, target: Element, clientX: number) =>
	target.dispatchEvent(
		new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 5 })
	);

/** A press in the middle of the atom (jsdom lays nothing out: the atom gets a box). */
const pressAtom = async ({ edytor }: Rendered) => {
	const atom = edytor.idToBlock.block(edytor.facade.order()[1]!).content[1] as InlineBlock;
	const node = atom.node!;
	vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({
		left: 100,
		right: 140,
		top: 0,
		bottom: 20,
		width: 40,
		height: 20,
		x: 100,
		y: 0,
		toJSON: () => ({})
	});
	pointer('pointerdown', node, 120);
	await flushDomUpdates();
	return { atom, node };
};

/** The browser parks its caret at the host's start; the release; then its late `selectionchange`. */
const parkAndRelease = async ({ edytor }: Rendered, node: Element) => {
	const first = edytor.idToBlock.block(edytor.facade.order()[0]!).content[0];
	window.getSelection()!.collapse(leafOf(await textNodeOf(first as never)), 0);
	pointer('pointerup', node, 120);
	pointer('click', node, 120);
	document.dispatchEvent(new Event('selectionchange'));
	await flushDomUpdates();
};

describe('a press on an inline atom', () => {
	it('keeps the atom selected over the caret the browser parks for the press', async () => {
		const rendered = await render();
		const { edytor } = rendered;
		const { atom, node } = await pressAtom(rendered);
		expect(edytor.selection.value).toMatchObject({ kind: 'atom', atomId: atom.id });

		await parkAndRelease(rendered, node);

		expect(edytor.selection.value).toMatchObject({ kind: 'atom', atomId: atom.id });
		expect(edytor.selection.selectedInlineBlock.has(atom)).toBe(true);
		// Displayed over: the host shows no range for an atom selection.
		const anchor = window.getSelection()!.anchorNode;
		expect(anchor !== null && edytor.node!.contains(anchor)).toBe(false);
	});

	it('gives the next press inside the host its caret', async () => {
		const rendered = await render();
		const { edytor } = rendered;
		const { node } = await pressAtom(rendered);
		await parkAndRelease(rendered, node);

		const last = edytor.idToBlock.block(edytor.facade.order()[1]!).content[2];
		const element = await textNodeOf(last as never);
		pointer('pointerdown', element, 200);
		window.getSelection()!.collapse(leafOf(element), 2);
		pointer('pointerup', element, 200);
		document.dispatchEvent(new Event('selectionchange'));
		await flushDomUpdates();

		const { start, isCollapsed } = edytor.selection.projection;
		expect(edytor.selection.value.kind).toBe('text');
		expect({ block: start?.block, offset: start?.offset, isCollapsed }).toEqual({
			block: edytor.facade.order()[1],
			offset: 'lead '.length + 1 + 2,
			isCollapsed: true
		});
	});
});
