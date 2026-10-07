/** @jsxImportSource ../../jsx */
/**
 * WU-21 — image completion (Notion's image block):
 *
 * - With `upload`, the image plugin claims a pasted or dropped image file:
 *   the image block is placed as a paste places an image line (`flow.apart`)
 *   at once, showing an uploading placeholder; the URL `upload` answers
 *   fills its `src`. The paste is ONE undo step whatever the upload's delay
 *   (the URL's write is kept out of the history: `dispatcher.outside`). A
 *   failed upload leaves the empty block with its error; a file that is no
 *   image, or a view without `upload`, claims nothing.
 * - HTML import reads a bare `<img>` (with its `alt` and `width`): a void
 *   kind's element inside a line ends the line (`flow.html.void`).
 * - `data.alt` is the image's `alt`; `data.width` (px) and `data.align`
 *   (`left`, `center`, `right`) size and place it, read back from HTML.
 * - The chrome in the overlay (hover): alignment buttons and an alt field.
 *
 * Expected values come from the plan (WU-21), Notion and the `flow.*`
 * contract rows, never from running the code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { BlockDefinition } from '$lib/plugins.js';
import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { attemptOf } from '$lib/session/attempt.js';
import { createImagePlugin, imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { flowOfHtml } from '$lib/clipboard/htmlFlow.js';
import {
	canonicalTree,
	dispatchClipboardPaste,
	dispatchCopy,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const png = (name = 'photo.png') =>
	new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

/** An upload the test settles. */
const deferred = () => {
	const calls: { file: File; resolve: (url: string) => void; reject: (error: unknown) => void }[] =
		[];
	const upload = vi.fn(
		(file: File) => new Promise<string>((resolve, reject) => calls.push({ file, resolve, reject }))
	);
	return { upload, calls };
};

const mount = (upload?: (file: File) => Promise<string>) =>
	renderDomEdytor(
		<root>
			<paragraph>hello|</paragraph>
			<paragraph>after</paragraph>
		</root>,
		{ plugins: [richTextPlugin, createImagePlugin({ upload })] }
	);

const shape = (edytor: Edytor) =>
	(edytor.value.children ?? []).map((block) => ({
		type: block.type,
		...(block.data && Object.keys(block.data).length ? { data: block.data } : {}),
		text: (block.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('')
	}));

/** A paste carrying `files` (and no text), as a browser sends a copied image. */
const pasteFiles = async (target: HTMLElement, files: File[]) => {
	const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
	Object.defineProperty(event, 'clipboardData', {
		value: { getData: () => '', files, types: ['Files'] },
		configurable: true
	});
	target.dispatchEvent(event);
	await flushDomUpdates();
	return event.defaultPrevented;
};

const settle = async () => {
	for (let i = 0; i < 3; i++) {
		await Promise.resolve();
		await flushDomUpdates();
	}
};

describe('a pasted image file goes through `upload` (WU-21)', () => {
	it('places the image at once with a placeholder, then fills its src: one undo step', async () => {
		const { upload, calls } = deferred();
		const { edytor, editor } = await mount(upload);
		const before = edytor.value;
		expect(await pasteFiles(editor, [png()])).toBe(true);
		expect(upload).toHaveBeenCalledTimes(1);
		expect(calls[0]!.file.name).toBe('photo.png');
		// `flow.apart`: an image never joins the text; at the end of `hello` it goes after it,
		// and the caret, which no image line takes, gets a fresh line after it.
		expect(shape(edytor)).toEqual([
			{ type: 'paragraph', text: 'hello' },
			{ type: 'image', text: '' },
			{ type: 'paragraph', text: '' },
			{ type: 'paragraph', text: 'after' }
		]);
		expect(editor.querySelector('[data-edytor-image-uploading]')).not.toBeNull();
		expect(editor.querySelector('[data-edytor-image-add]')).toBeNull();

		calls[0]!.resolve('https://cdn.example.com/photo.png');
		await settle();
		expect(shape(edytor)[1]).toEqual({
			type: 'image',
			data: { src: 'https://cdn.example.com/photo.png' },
			text: ''
		});
		expect(editor.querySelector('[data-edytor-image-uploading]')).toBeNull();
		expect(editor.querySelector('[data-edytor-image] img')?.getAttribute('src')).toBe(
			'https://cdn.example.com/photo.png'
		);

		// One step: the undo takes the image back, src and all; the redo gives it back whole.
		edytor.historyUndo();
		await flushDomUpdates();
		expect(edytor.value).toEqual(before);
		edytor.historyRedo();
		await flushDomUpdates();
		expect(shape(edytor)[1]).toEqual({
			type: 'image',
			data: { src: 'https://cdn.example.com/photo.png' },
			text: ''
		});
	});

	it('the upload landing does not split the typing around it into extra steps', async () => {
		const { upload, calls } = deferred();
		const { edytor, editor } = await mount(upload);
		const before = edytor.value;
		await pasteFiles(editor, [png()]);
		calls[0]!.resolve('https://cdn.example.com/photo.png');
		await settle();
		// The step under the paste is still the paste.
		expect(edytor.undoManager.undoStack.length).toBe(1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(edytor.value).toEqual(before);
		expect(edytor.undoManager.undoStack.length).toBe(0);
	});

	it('several files are one step, each filled by its own upload', async () => {
		const { upload, calls } = deferred();
		const { edytor, editor } = await mount(upload);
		await pasteFiles(editor, [png('a.png'), png('b.png')]);
		expect(upload).toHaveBeenCalledTimes(2);
		calls[1]!.resolve('https://cdn.example.com/b.png');
		calls[0]!.resolve('https://cdn.example.com/a.png');
		await settle();
		expect(shape(edytor)).toEqual([
			{ type: 'paragraph', text: 'hello' },
			{ type: 'image', data: { src: 'https://cdn.example.com/a.png' }, text: '' },
			{ type: 'image', data: { src: 'https://cdn.example.com/b.png' }, text: '' },
			{ type: 'paragraph', text: '' },
			{ type: 'paragraph', text: 'after' }
		]);
		expect(edytor.undoManager.undoStack.length).toBe(1);
	});

	it('a failed upload leaves the empty block with its error and the panel', async () => {
		const { upload, calls } = deferred();
		const { edytor, editor } = await mount(upload);
		await pasteFiles(editor, [png()]);
		calls[0]!.reject(new Error('quota'));
		await settle();
		expect(shape(edytor)[1]).toEqual({ type: 'image', text: '' });
		expect(editor.querySelector('[data-edytor-image-uploading]')).toBeNull();
		expect(
			editor.querySelector('[data-edytor-image-error]')?.getAttribute('data-edytor-image-error')
		).toBe('upload');
	});

	it('an answer that is no image source is not stored', async () => {
		const { upload, calls } = deferred();
		const { edytor, editor } = await mount(upload);
		await pasteFiles(editor, [png()]);
		calls[0]!.resolve('javascript:alert(1)');
		await settle();
		expect(shape(edytor)[1]).toEqual({ type: 'image', text: '' });
		expect(editor.querySelector('[data-edytor-image-error="upload"]')).not.toBeNull();
	});

	it('an image undone before its upload lands stays gone', async () => {
		const { upload, calls } = deferred();
		const { edytor, editor } = await mount(upload);
		const before = edytor.value;
		await pasteFiles(editor, [png()]);
		edytor.historyUndo();
		await flushDomUpdates();
		calls[0]!.resolve('https://cdn.example.com/photo.png');
		await settle();
		expect(edytor.value).toEqual(before);
	});

	it('a file that is no image, or a view without upload, claims nothing', async () => {
		const { upload } = deferred();
		const { edytor, editor } = await mount(upload);
		const before = edytor.value;
		const pdf = new File(['%PDF'], 'a.pdf', { type: 'application/pdf' });
		await pasteFiles(editor, [pdf]);
		expect(upload).not.toHaveBeenCalled();
		expect(edytor.value).toEqual(before);
		document.body.innerHTML = '';

		const plain = await renderDomEdytor(
			<root>
				<paragraph>hello|</paragraph>
			</root>,
			{ plugins: [richTextPlugin, imagePlugin] }
		);
		const was = plain.edytor.value;
		await pasteFiles(plain.editor, [png()]);
		expect(plain.edytor.value).toEqual(was);
	});

	it('a readonly view claims nothing', async () => {
		const { upload } = deferred();
		const { edytor, editor } = await mount(upload);
		edytor.readonly = true;
		await flushDomUpdates();
		const before = edytor.value;
		await pasteFiles(editor, [png()]);
		expect(upload).not.toHaveBeenCalled();
		expect(edytor.value).toEqual(before);
	});
});

describe('a dropped image file goes through `upload` (WU-21)', () => {
	const drop = (edytor: Edytor, files: File[]) =>
		runBeforeInputCommand(
			edytor,
			attemptOf(edytor, {
				inputType: 'insertFromDrop',
				data: null,
				dataTransfer: {
					types: ['Files'],
					files,
					getData: () => ''
				} as unknown as DataTransfer,
				cancelable: true
			})
		);

	it('is placed at the drop point, one step', async () => {
		const { upload, calls } = deferred();
		const { edytor } = await mount(upload);
		const before = edytor.value;
		// The drop point: inside `hello`, after `he`.
		await setNativeSelection(edytor, edytor.root!.children[0]!.firstText!, 2);
		await drop(edytor, [png()]);
		await settle();
		expect(upload).toHaveBeenCalledTimes(1);
		// `flow.apart`: the text after the point stays in a shown line after the image.
		expect(shape(edytor)).toEqual([
			{ type: 'paragraph', text: 'he' },
			{ type: 'image', text: '' },
			{ type: 'paragraph', text: 'llo' },
			{ type: 'paragraph', text: 'after' }
		]);
		calls[0]!.resolve('https://cdn.example.com/photo.png');
		await settle();
		expect(shape(edytor)[1]!.data).toEqual({ src: 'https://cdn.example.com/photo.png' });
		edytor.historyUndo();
		await flushDomUpdates();
		expect(edytor.value).toEqual(before);
	});

	it('over a block selection, lands at the drop point and replaces nothing', async () => {
		const { upload } = deferred();
		const { edytor } = await mount(upload);
		const [hello, after] = edytor.root!.children;
		edytor.selection.selectBlocks(hello!);
		await flushDomUpdates();
		// Dropped inside `after`, after `af`.
		const element = after!.firstText!.node!;
		const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
		await runBeforeInputCommand(
			edytor,
			attemptOf(edytor, {
				inputType: 'insertFromDrop',
				data: null,
				dataTransfer: {
					types: ['Files'],
					files: [png()],
					getData: () => ''
				} as unknown as DataTransfer,
				declared: {
					startContainer: node,
					startOffset: 2,
					endContainer: node,
					endOffset: 2,
					collapsed: true
				} as StaticRange,
				cancelable: true
			})
		);
		await settle();
		expect(upload).toHaveBeenCalledTimes(1);
		expect(shape(edytor)).toEqual([
			{ type: 'paragraph', text: 'hello' },
			{ type: 'paragraph', text: 'af' },
			{ type: 'image', text: '' },
			{ type: 'paragraph', text: 'ter' }
		]);
	});
});

describe('HTML import reads a bare <img> (WU-21, flow.html.void)', () => {
	const kinds = async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: [richTextPlugin, imagePlugin] }
		);
		return edytor;
	};
	const lines = async (html: string) =>
		(flowOfHtml(await kinds(), html)?.lines ?? []).map((line) => ({
			// A line without a kind is an inline run (`flow.shape`).
			type: line.type ?? 'run',
			...(line.data && Object.keys(line.data).length ? { data: line.data } : {}),
			text: (line.content ?? []).map((item) => (item.kind === 'text' ? item.text : '@')).join('')
		}));
	const src = 'https://example.com/a.png';

	it('a bare <img> is an image block, with its alt and width', async () => {
		expect(await lines(`<img src="${src}" alt="A cat" width="320">`)).toEqual([
			{ type: 'image', data: { src, alt: 'A cat', width: 320 }, text: '' }
		]);
	});

	it('an <img> inside a line ends it: the text around it stays on both sides', async () => {
		expect(await lines(`<p>before <img src="${src}"> after</p>`)).toEqual([
			{ type: 'run', text: 'before' },
			{ type: 'image', data: { src }, text: '' },
			{ type: 'run', text: 'after' }
		]);
	});

	it('an <img> wrapped in inline markup (Google Docs) is found; no empty line is left', async () => {
		expect(await lines(`<p dir="ltr"><span><img src="${src}"></span></p><p>next</p>`)).toEqual([
			{ type: 'image', data: { src }, text: '' },
			{ type: 'run', text: 'next' }
		]);
	});

	it('a <figure> stays one image, its caption the text, its alt kept', async () => {
		expect(
			await lines(`<figure><img src="${src}" alt="Alt"><figcaption>Caption</figcaption></figure>`)
		).toEqual([{ type: 'image', data: { src, alt: 'Alt' }, text: 'Caption' }]);
	});

	it('an <img> with no accepted source is still dropped', async () => {
		expect(await lines('<p>x<img src="javascript:alert(1)">y</p>')).toEqual([
			{ type: 'run', text: 'xy' }
		]);
	});

	it('a pasted <img> lands as an image block', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>hello|</paragraph>
			</root>,
			{ plugins: [richTextPlugin, imagePlugin] }
		);
		await dispatchClipboardPaste(editor, { 'text/html': `<img src="${src}" alt="A">` });
		expect(canonicalTree(edytor).map((block) => block.type)).toEqual([
			'paragraph',
			'image',
			'paragraph'
		]);
		expect(edytor.value.children?.[1]?.data).toEqual({ src, alt: 'A' });
	});
});

describe('alt, width and alignment (WU-21)', () => {
	const src = 'https://example.com/a.png';
	const withImage = (data: Record<string, unknown>) =>
		renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [richTextPlugin, imagePlugin],
				value: {
					children: [
						{ id: 'img', type: 'image', data: { src, ...data }, content: [{ text: 'cap' }] },
						{ id: 'p', type: 'paragraph', content: [{ text: 'after' }] }
					]
				}
			}
		);

	it('renders data.alt as the image alt, and no alt as an empty one', async () => {
		const { editor, edytor } = await withImage({ alt: 'A red barn' });
		expect(editor.querySelector('[data-edytor-image] img')?.getAttribute('alt')).toBe('A red barn');
		edytor.idToBlock.get('img')!.setData({ src });
		await flushDomUpdates();
		expect(editor.querySelector('[data-edytor-image] img')?.getAttribute('alt')).toBe('');
	});

	it('renders data.width in px and data.align on the wrapper (center by default)', async () => {
		const { editor, edytor } = await withImage({ width: 240, align: 'right' });
		const wrapper = editor.querySelector<HTMLElement>('[data-edytor-image]')!;
		expect(wrapper.getAttribute('data-align')).toBe('right');
		expect(wrapper.querySelector('img')!.style.width).toBe('240px');
		edytor.idToBlock.get('img')!.setData({ src, align: 'sideways', width: -3 });
		await flushDomUpdates();
		expect(wrapper.getAttribute('data-align')).toBe('center');
		expect(wrapper.querySelector('img')!.style.width).toBe('');
	});

	it('exports alt, width and alignment, and imports them back', async () => {
		const { edytor } = await withImage({ alt: 'Barn "red"', width: 240, align: 'left' });
		const record = edytor.blocks.get('image') as BlockDefinition;
		const html = record.html as (block: unknown, caption: string, children: string) => string;
		const out = html(
			{ type: 'image', data: { src, alt: 'Barn "red"', width: 240, align: 'left' } },
			'cap',
			''
		);
		const figure = new DOMParser().parseFromString(out, 'text/html').querySelector('figure')!;
		expect(figure.querySelector('img')!.getAttribute('alt')).toBe('Barn "red"');
		expect(figure.querySelector('img')!.getAttribute('width')).toBe('240');
		expect(record.parse!(figure)).toEqual({ src, alt: 'Barn "red"', width: 240, align: 'left' });
	});

	it('a copied image carries its alt in the HTML flavour', async () => {
		const { edytor } = await withImage({ alt: 'Barn' });
		edytor.selection.selectBlocks(edytor.idToBlock.get('img')!);
		await flushDomUpdates();
		const { clipboardData } = await dispatchCopy(edytor.node!);
		expect(clipboardData['text/html']).toContain('alt="Barn"');
	});
});

describe('the image chrome in the overlay (WU-21)', () => {
	const src = 'https://example.com/a.png';
	const mountImage = (data: Record<string, unknown> = {}, readonly = false) =>
		renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [richTextPlugin, imagePlugin],
				readonly,
				value: {
					children: [
						{ id: 'img', type: 'image', data: { src, ...data }, content: [{ text: '' }] },
						{ id: 'p', type: 'paragraph', content: [{ text: 'after' }] }
					]
				}
			}
		);
	const hover = async (editor: HTMLElement) => {
		editor
			.querySelector('[data-edytor-image] img')!
			.dispatchEvent(new Event('pointerover', { bubbles: true }));
		await settle();
		await new Promise((resolve) => setTimeout(resolve, 20));
		await flushDomUpdates();
	};
	const chrome = () => document.querySelector<HTMLElement>('[data-edytor-image-toolbar]');

	it('hovering an image shows its alignment buttons; each sets data.align, one step', async () => {
		const { edytor, editor } = await mountImage();
		expect(chrome()).toBeNull();
		await hover(editor);
		expect(chrome()).not.toBeNull();
		const pressed = () =>
			[...chrome()!.querySelectorAll('[data-edytor-image-align]')]
				.filter((button) => button.getAttribute('aria-pressed') === 'true')
				.map((button) => button.getAttribute('data-edytor-image-align'));
		expect(pressed()).toEqual(['center']);
		chrome()!.querySelector<HTMLButtonElement>('[data-edytor-image-align="left"]')!.click();
		await flushDomUpdates();
		expect(edytor.facade.blockDataOf('img')).toEqual({ src, align: 'left' });
		// The chrome reads the image's place in the overlay's next measure.
		await new Promise((resolve) => setTimeout(resolve, 20));
		await flushDomUpdates();
		expect(pressed()).toEqual(['left']);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(edytor.facade.blockDataOf('img')).toEqual({ src });
	});

	it('the alt field writes data.alt as you type, one step', async () => {
		const { edytor, editor } = await mountImage({ alt: 'old' });
		await hover(editor);
		chrome()!.querySelector<HTMLButtonElement>('[data-edytor-image-alt-toggle]')!.click();
		await flushDomUpdates();
		const field = document.querySelector<HTMLInputElement>('[data-edytor-image-alt]')!;
		expect(field.value).toBe('old');
		for (const value of ['ol', 'o', 'a', 'a b']) {
			field.value = value;
			field.dispatchEvent(new Event('input', { bubbles: true }));
			await flushDomUpdates();
		}
		expect(edytor.facade.blockDataOf('img')).toEqual({ src, alt: 'a b' });
		expect(editor.querySelector('[data-edytor-image] img')?.getAttribute('alt')).toBe('a b');
	});

	it('a readonly view shows no chrome', async () => {
		const { editor } = await mountImage({}, true);
		await hover(editor);
		expect(chrome()).toBeNull();
		expect(document.querySelector('[data-edytor-image-resize]')).toBeNull();
	});

	it('shows two resize handles on the hovered image', async () => {
		const { editor } = await mountImage();
		await hover(editor);
		expect(
			[...document.querySelectorAll('[data-edytor-image-resize]')].map((handle) =>
				handle.getAttribute('data-edytor-image-resize')
			)
		).toEqual(['left', 'right']);
	});
});
