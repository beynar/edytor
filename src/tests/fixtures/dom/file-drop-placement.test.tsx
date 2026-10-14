/** @jsxImportSource ../../jsx */
/**
 * Files dropped from outside at a place (`drop.files.place`, Notion): while
 * they are dragged over the view, the block drag's indicator shows where
 * they land (the same placement rules: the lower half of a block's own row
 * is after it); dropped, they become one block per file, each of the kind
 * that takes it, there, as one command (one undo step). A read-only view
 * shows no indicator and takes no drop. Without the block handles plugin.
 * Without a media plugin given an `upload` the view takes no file drop
 * (the media plugins install it): the drop is swallowed, nothing shows.
 *
 * The drag is Pragmatic's external adapter's: a `dragenter` from outside the
 * window starts it, the host is its drop target, a `dragleave` out of the
 * window ends it. jsdom has no layout: the rows' boxes and the hit test are
 * stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';
import {
	file as createFilePlugin,
	image as createImagePlugin,
	richTextPlugin,
	mediaEmptyPlugin
} from '$registry/edytor/chrome/plugins.js';

afterEach(() => {
	// No drag outlives its row (the adapter allows one at a time).
	window.dispatchEvent(new Event('dragend'));
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

const file = (name: string, type: string) => new File([new Uint8Array(4)], name, { type });

const mount = (readonly = false, media = true) =>
	renderDomEdytor(
		<root>
			<paragraph>one</paragraph>
			<paragraph>two</paragraph>
		</root>,
		{
			plugins: [
				richTextPlugin,
				...(media
					? [
							mediaEmptyPlugin,
							createImagePlugin({ upload: () => new Promise<string>(() => {}) }),
							createFilePlugin({ upload: () => new Promise<string>(() => {}) })
						]
					: [])
			],
			readonly
		}
	);

const rect = (top: number, height: number) =>
	({
		left: 100,
		right: 700,
		width: 600,
		top,
		bottom: top + height,
		height,
		x: 100,
		y: top,
		toJSON: () => ({})
	}) as DOMRect;

/** Lay out the root and its blocks as 40px rows, and hit-test by those rows. */
const layOut = (edytor: Edytor) => {
	const root = edytor.node!;
	const rows = [...root.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')];
	vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, rows.length * 40));
	rows.forEach((row, index) =>
		vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect(index * 40, 40))
	);
	document.elementsFromPoint = (_x: number, y: number) => {
		const row = rows[Math.floor(y / 40)];
		return row ? [row, root] : [root];
	};
};

const transfer = (files: File[]) =>
	({
		types: ['Files'],
		files,
		// The adapter reads the files at the drop only (an engine lists none before it).
		items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
		getData: () => '',
		setDragImage: () => {},
		dropEffect: 'none'
	}) as unknown as DataTransfer;

const dragEvent = (type: string, dataTransfer: DataTransfer, clientY: number) => {
	const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperties(event, {
		dataTransfer: { value: dataTransfer },
		clientX: { value: 110 },
		clientY: { value: clientY }
	});
	return event;
};

const types = (edytor: Edytor) => (edytor.value.children ?? []).map((block) => block.type);
const indicator = () => document.querySelector<HTMLElement>('[data-edytor-drop-indicator]');

describe('drop.files.place', () => {
	it('files dropped on the lower half of a block land after it, each its kind, one undo step', async () => {
		const { edytor, editor } = await mount();
		layOut(edytor);
		const files = [file('photo.png', 'image/png'), file('notes.pdf', 'application/pdf')];
		const data = transfer(files);
		editor.dispatchEvent(dragEvent('dragenter', data, 30));
		const over = dragEvent('dragover', data, 30);
		editor.dispatchEvent(over);
		expect(over.defaultPrevented).toBe(true);
		expect(indicator()?.dataset.position).toBe('after');
		expect(editor.querySelector('[data-edytor-block-drop-position="after"]')?.textContent).toBe(
			'one'
		);

		const drop = dragEvent('drop', data, 30);
		editor.dispatchEvent(drop);
		await flushDomUpdates();
		expect(drop.defaultPrevented).toBe(true);
		expect(indicator()).toBeNull();
		expect(types(edytor)).toEqual(['paragraph', 'image', 'file', 'paragraph']);

		edytor.historyUndo();
		await flushDomUpdates();
		expect(types(edytor)).toEqual(['paragraph', 'paragraph']);
	});

	it('the upper half of a block is before it', async () => {
		const { edytor, editor } = await mount();
		layOut(edytor);
		const data = transfer([file('photo.png', 'image/png')]);
		editor.dispatchEvent(dragEvent('dragenter', data, 45));
		editor.dispatchEvent(dragEvent('dragover', data, 45));
		expect(indicator()?.dataset.position).toBe('before');
		editor.dispatchEvent(dragEvent('drop', data, 45));
		await flushDomUpdates();
		expect(types(edytor)).toEqual(['paragraph', 'image', 'paragraph']);
	});

	it('a drag moving off the view, to the page around it, clears the indicator', async () => {
		const { edytor, editor } = await mount();
		layOut(edytor);
		const data = transfer([file('photo.png', 'image/png')]);
		editor.dispatchEvent(dragEvent('dragenter', data, 30));
		editor.dispatchEvent(dragEvent('dragover', data, 30));
		expect(indicator()).not.toBeNull();
		document.body.dispatchEvent(dragEvent('dragenter', data, 30));
		document.body.dispatchEvent(dragEvent('dragover', data, 30));
		expect(indicator()).toBeNull();
		expect(editor.querySelector('[data-edytor-block-drop-position]')).toBeNull();
		// Back over the view: it shows again.
		editor.dispatchEvent(dragEvent('dragover', data, 30));
		expect(indicator()?.dataset.position).toBe('after');
	});

	it('a drag leaving the window clears the indicator and ends the drag', async () => {
		const { edytor, editor } = await mount();
		layOut(edytor);
		const data = transfer([file('photo.png', 'image/png')]);
		editor.dispatchEvent(dragEvent('dragenter', data, 30));
		editor.dispatchEvent(dragEvent('dragover', data, 30));
		expect(indicator()).not.toBeNull();
		// Out of the window: no element it enters (`relatedTarget` none).
		editor.dispatchEvent(dragEvent('dragleave', data, 30));
		expect(indicator()).toBeNull();
		// A drag coming back in is a new one, shown again.
		editor.dispatchEvent(dragEvent('dragenter', data, 45));
		editor.dispatchEvent(dragEvent('dragover', data, 45));
		expect(indicator()?.dataset.position).toBe('before');
	});

	it('a read-only view shows no indicator and takes no drop', async () => {
		const { edytor, editor } = await mount(true);
		layOut(edytor);
		const data = transfer([file('photo.png', 'image/png')]);
		editor.dispatchEvent(dragEvent('dragenter', data, 30));
		editor.dispatchEvent(dragEvent('dragover', data, 30));
		expect(indicator()).toBeNull();
		const drop = dragEvent('drop', data, 30);
		editor.dispatchEvent(drop);
		await flushDomUpdates();
		// Swallowed: the browser must not open the file in place of the page.
		expect(drop.defaultPrevented).toBe(true);
		expect(types(edytor)).toEqual(['paragraph', 'paragraph']);
	});

	it('without a media plugin given an upload, a file drop is ignored: no indicator, no block, no navigation', async () => {
		const { edytor, editor } = await mount(false, false);
		layOut(edytor);
		const data = transfer([file('photo.png', 'image/png')]);
		editor.dispatchEvent(dragEvent('dragenter', data, 30));
		const over = dragEvent('dragover', data, 30);
		editor.dispatchEvent(over);
		expect(over.defaultPrevented).toBe(true);
		expect(data.dropEffect).toBe('none');
		expect(indicator()).toBeNull();
		const drop = dragEvent('drop', data, 30);
		editor.dispatchEvent(drop);
		await flushDomUpdates();
		// Swallowed: the browser must not open the file in place of the page.
		expect(drop.defaultPrevented).toBe(true);
		expect(types(edytor)).toEqual(['paragraph', 'paragraph']);
	});
});
