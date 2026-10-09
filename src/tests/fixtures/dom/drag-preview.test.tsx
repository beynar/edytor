/** @jsxImportSource ../../jsx */
/**
 * The drag ghost (Notion): while a handle drags, a copy of the dragged
 * blocks, rendered as they look in the editor and only scaled down (no card,
 * background, shadow, opacity or fade), follows the pointer — for every
 * drag, one block and several. Each dragged block's element is cloned with
 * its whole subtree, stripped of everything editable, view-only or findable
 * as a live node, inside a wrapper carrying the editor root's classes (and
 * its ancestors', where a theme's class usually sits), so the theme applies.
 * Driven through the real drag library; the picture is what the data
 * transfer's `setDragImage` receives. Expected states are hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { blockHandlesPlugin } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
import { HIDDEN } from '$lib/selection/visibility.js';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const ROW = 24;

const p = (id: string, children?: JSONBlock[]): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text: `${id} ` }, { text: 'bold', marks: { bold: true } }],
	...(children && { children })
});

const render = async (children: JSONBlock[]) => {
	const rendered = await renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin, mentionPlugin, blockHandlesPlugin], value: { children } }
	);
	// The theme's class on an element around the editor, the page's on the root.
	rendered.editor.parentElement!.classList.add('edytor-notion');
	rendered.editor.classList.add('my-editor');
	return rendered;
};

/** 24px rows, indented per level (jsdom has no layout). */
const layout = () => {
	const blocks = [...document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')];
	const shown = blocks.filter((node) => !node.closest(HIDDEN));
	for (const node of blocks) {
		const index = shown.indexOf(node);
		let depth = 0;
		for (let up = node.parentElement?.closest('[data-edytor-block="true"]'); up; )
			[depth, up] = [depth + 1, up.parentElement?.closest('[data-edytor-block="true"]')];
		const inner = shown.filter((other) => other !== node && node.contains(other)).length;
		const rect =
			index < 0
				? new DOMRect(0, 0, 0, 0)
				: new DOMRect(depth * ROW, index * ROW, 600 - depth * ROW, (inner + 1) * ROW);
		node.getBoundingClientRect = () => rect;
	}
};

let dragImage: HTMLElement | null = null;
const fire = (
	target: EventTarget,
	type: string,
	at: { clientX?: number; clientY?: number } = {}
) => {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...at });
	const store: Record<string, string> = {};
	Object.defineProperty(event, 'dataTransfer', {
		value: {
			setData: (key: string, value: string) => (store[key] = value),
			getData: (key: string) => store[key] ?? '',
			get types() {
				return Object.keys(store);
			},
			setDragImage: (image: Element) => (dragImage = image.cloneNode(true) as HTMLElement),
			dropEffect: 'move',
			effectAllowed: 'all',
			items: [],
			files: []
		}
	});
	target.dispatchEvent(event);
};
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** Start dragging `source`'s handle; answer the ghost the browser was given, then end the drag. */
const ghostOf = async (edytor: Edytor, source: string) => {
	await flushDomUpdates();
	layout();
	dragImage = null;
	const handle = document.querySelector<HTMLElement>(
		`[data-testid="block-handle"][data-block-id="${source}"]`
	)!;
	fire(handle, 'dragstart', { clientX: -12, clientY: 12 });
	await frame();
	const image = (dragImage as HTMLElement | null)?.querySelector<HTMLElement>(
		'[data-edytor-drag-preview]'
	);
	const mounted = document.querySelector('[data-edytor-drag-preview]');
	const node = edytor.idToBlock.get(source)!.node!;
	fire(node, 'drop', { clientX: 100, clientY: 1 });
	await flushDomUpdates();
	await frame();
	return { image: image ?? null, mounted };
};

/** The clones: the direct children of the list inside the root-like wrapper. */
const clonesOf = (image: HTMLElement) =>
	[...image.querySelector<HTMLElement>('[data-edytor] > div')!.children] as HTMLElement[];

/** Nothing editable, focusable, view-only or findable as a live node. */
const LIVE = [
	'[contenteditable]',
	'[id]',
	'[tabindex]',
	'[data-edytor-id]',
	'[data-edytor-block]',
	'[data-edytor-text]',
	'[data-edytor-inline-block]',
	'[data-edytor-mark]',
	'[data-edytor-void]',
	'[data-edytor-selected]',
	'[data-edytor-focused]',
	'[data-placeholder]',
	'[data-edytor-render-anchor]',
	'[data-edytor-block-handle-host]'
].join(', ');

/** The blocks' own look, only scaled: no card, background, shadow, opacity or fade is added. */
const expectUnstyled = (image: HTMLElement) => {
	const added = [image, ...image.querySelectorAll<HTMLElement>('[style]')].filter(
		(element) => !element.closest('[data-edytor] > div > *') && !element.dataset.edytorDragCount
	);
	expect(added.length).toBeGreaterThan(2);
	for (const { style } of added) {
		expect(['', 'none']).toContain(style.boxShadow);
		expect(['', 'none']).toContain(style.backgroundImage || style.background);
		expect(['', 'transparent']).toContain(style.backgroundColor);
		expect(['', '1']).toContain(style.opacity);
		expect(style.borderRadius).toBe('');
		expect(style.getPropertyValue('mask-image')).toBe('');
	}
	const scaled = image.querySelector<HTMLElement>('[style*="scale"]')!;
	expect(scaled.style.transform).toBe('scale(0.8)');
	expect(scaled.style.transformOrigin).toBe('top left');
	expect(scaled.querySelector('[data-edytor]')).not.toBeNull();
};

describe('the drag ghost', () => {
	it('one block: a clone of its rendered element with its children, no badge', async () => {
		const { edytor, editor } = await render([p('a', [p('a1')]), p('b')]);
		const liveIds = editor.querySelectorAll('[data-edytor-id]').length;
		const { image, mounted } = await ghostOf(edytor, 'a');

		expect(image).not.toBeNull();
		expect(image!.dataset.count).toBe('1');
		expect(image!.querySelector('[data-edytor-drag-count]')).toBeNull();
		// The wrapper: the root's classes and root attribute, inside the ancestors' (the theme's).
		const root = image!.querySelector<HTMLElement>('[data-edytor]')!;
		expect(root.classList.contains('my-editor')).toBe(true);
		expect(root.closest('.edytor-notion')).not.toBeNull();
		const clones = clonesOf(image!);
		expect(clones.map((clone) => clone.dataset.edytorType)).toEqual(['paragraph']);
		const [clone] = clones;
		// Its text and its child's (the markup holds no whitespace between blocks).
		const texts = [...clone!.querySelectorAll('p')].map((text) =>
			text.textContent?.replace(/[\s\u200B]+/g, ' ').trim()
		);
		expect(texts).toEqual(['a bold', 'a1 bold']);
		expect(clone!.querySelector('strong')?.textContent).toBe('bold');
		expect(clone!.querySelector('[data-edytor-children] [data-edytor-type="paragraph"]')).not.toBe(
			null
		);
		expect(image!.querySelectorAll(LIVE)).toHaveLength(0);
		expectUnstyled(image!);
		// The editor's live nodes untouched; the ghost was removed after.
		expect(editor.querySelectorAll('[data-edytor-id]')).toHaveLength(liveIds);
		expect(mounted).toBeNull();
		expect(document.querySelector('[data-edytor-drag-preview]')).toBeNull();
	});

	it('several blocks: a clone of each in document order, no count badge', async () => {
		const { edytor } = await render([
			p('a'),
			{ id: 'todo', type: 'todo-item', data: { checked: true }, content: [{ text: 'done' }] },
			{ id: 't', type: 'toggle', content: [{ text: 't' }], children: [p('t1')] },
			p('d')
		]);
		const [a, todo, t] = ['a', 'todo', 't'].map((id) => edytor.idToBlock.get(id)!);
		edytor.selection.selectBlocks(t!, a!, todo!);
		await flushDomUpdates();
		const { image } = await ghostOf(edytor, 'todo');

		expect(image!.dataset.count).toBe('3');
		expect(image!.querySelector('[data-edytor-drag-count]')).toBeNull();
		expect(clonesOf(image!).map((clone) => clone.dataset.edytorType)).toEqual([
			'paragraph',
			'todo-item',
			'toggle'
		]);
		// A to-do's check (a property, not an attribute) and a toggle's shown body come along.
		expect(image!.querySelector<HTMLInputElement>('[data-edytor-todo-checkbox]')?.checked).toBe(
			true
		);
		expect(image!.querySelector('details [data-edytor-children]')?.textContent).toContain('t1');
		// The selected-block highlight stays on the live blocks only.
		expect(image!.querySelectorAll(LIVE)).toHaveLength(0);
		expectUnstyled(image!);
		expect(image!.querySelector('[data-edytor-drag-preview] [data-edytor] [data-edytor]')).toBe(
			null
		);
	});
});
