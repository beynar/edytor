/** @jsxImportSource ../../jsx */
/**
 * Pasted and dropped files (`media.files`): every kind given an `upload`
 * (image, video, audio, file) claims the files it takes, and the view
 * places one block per file, in the clipboard's order, each of its own
 * kind, as one paste (one undo step): a video or audio file to its kind, an
 * image to the image kind, any other file to the file kind, which takes a
 * file only no other kind takes. Each block shows its upload (its progress
 * when `upload` reports one) until the URL fills it outside the history; a
 * failed upload leaves the empty block with its error. A kind with no
 * `upload`, or a readonly view, claims nothing.
 *
 * Expected values come from Notion and the image block's rows (WU-21).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { createImagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
import { createVideoPlugin } from '$lib/plugins/media/VideoPlugin.svelte';
import { createAudioPlugin } from '$lib/plugins/media/AudioPlugin.svelte';
import { createFilePlugin } from '$lib/plugins/media/FilePlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const file = (name: string, type: string, bytes = 4) =>
	new File([new Uint8Array(bytes)], name, { type });

type Report = { progress(fraction: number): void };
/** An upload the test settles, with its progress report. */
const deferred = () => {
	const calls: {
		file: File;
		report?: Report;
		resolve: (url: string) => void;
		reject: (error: unknown) => void;
	}[] = [];
	const upload = vi.fn(
		(file: File, report?: Report) =>
			new Promise<string>((resolve, reject) => calls.push({ file, report, resolve, reject }))
	);
	return { upload, calls };
};

const mount = (plugins: Plugin[], readonly = false) =>
	renderDomEdytor(
		<root>
			<paragraph>hello|</paragraph>
		</root>,
		{ plugins: [richTextPlugin, ...plugins], readonly }
	);

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

const shape = (edytor: Edytor) =>
	(edytor.value.children ?? []).map((block) => ({
		type: block.type,
		...(block.data && Object.keys(block.data).length ? { data: block.data } : {})
	}));

describe('media.files', () => {
	it('a video file becomes a video block that uploads, then plays its URL: one undo step', async () => {
		const { upload, calls } = deferred();
		const { edytor, editor } = await mount([createVideoPlugin({ upload })]);
		expect(await pasteFiles(editor, [file('clip.mp4', 'video/mp4')])).toBe(true);
		expect(calls.map((call) => call.file.name)).toEqual(['clip.mp4']);
		expect(shape(edytor).map((block) => block.type)).toEqual(['paragraph', 'video', 'paragraph']);
		expect(editor.querySelector('[data-edytor-media-uploading]')).not.toBeNull();
		expect(editor.querySelector('[data-edytor-media-add]')).toBeNull();

		calls[0]!.resolve('https://cdn.example.com/clip.mp4');
		await settle();
		expect(shape(edytor)[1]).toEqual({
			type: 'video',
			data: { src: 'https://cdn.example.com/clip.mp4' }
		});
		expect(editor.querySelector('video')?.getAttribute('src')).toBe(
			'https://cdn.example.com/clip.mp4'
		);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(shape(edytor).map((block) => block.type)).toEqual(['paragraph']);
	});

	it('a file of no other kind becomes a file block with its name and size', async () => {
		const { upload, calls } = deferred();
		const { edytor, editor } = await mount([createFilePlugin({ upload })]);
		expect(await pasteFiles(editor, [file('notes.pdf', 'application/pdf', 10)])).toBe(true);
		calls[0]!.resolve('https://cdn.example.com/notes.pdf');
		await settle();
		expect(shape(edytor)[1]).toEqual({
			type: 'file',
			data: { src: 'https://cdn.example.com/notes.pdf', name: 'notes.pdf', size: 10 }
		});
	});

	it('several files place one block each, in order, each of the kind that takes it', async () => {
		const { upload, calls } = deferred();
		// The file kind is listed first: it still takes only what no other kind takes.
		const { edytor, editor } = await mount([
			createFilePlugin({ upload }),
			createImagePlugin({ upload }),
			createVideoPlugin({ upload }),
			createAudioPlugin({ upload })
		]);
		await pasteFiles(editor, [
			file('a.png', 'image/png'),
			file('b.mp3', 'audio/mpeg'),
			file('c.zip', 'application/zip'),
			file('d.webm', 'video/webm')
		]);
		expect(shape(edytor).map((block) => block.type)).toEqual([
			'paragraph',
			'image',
			'audio',
			'file',
			'video',
			'paragraph'
		]);
		expect(calls.map((call) => call.file.name)).toEqual(['a.png', 'b.mp3', 'c.zip', 'd.webm']);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(shape(edytor).map((block) => block.type)).toEqual(['paragraph']);
	});

	it('the block shows the progress `upload` reports', async () => {
		const { upload, calls } = deferred();
		const { editor } = await mount([createAudioPlugin({ upload })]);
		await pasteFiles(editor, [file('talk.mp3', 'audio/mpeg')]);
		const bar = () =>
			editor.querySelector<HTMLProgressElement>('[data-edytor-media-uploading] progress');
		expect(bar()?.hasAttribute('value')).toBe(false); // no report yet: indeterminate
		calls[0]!.report!.progress(0.4);
		await flushDomUpdates();
		expect(bar()?.value).toBeCloseTo(0.4);
	});

	it('the image block shows its progress too', async () => {
		const { upload, calls } = deferred();
		const { editor } = await mount([createImagePlugin({ upload })]);
		await pasteFiles(editor, [file('a.png', 'image/png')]);
		calls[0]!.report!.progress(0.75);
		await flushDomUpdates();
		expect(
			editor.querySelector<HTMLProgressElement>('[data-edytor-image-uploading] progress')?.value
		).toBeCloseTo(0.75);
	});

	it('a failed upload leaves the empty block with its error', async () => {
		const { upload, calls } = deferred();
		const { edytor, editor } = await mount([createVideoPlugin({ upload })]);
		await pasteFiles(editor, [file('clip.mp4', 'video/mp4')]);
		calls[0]!.reject(new Error('offline'));
		await settle();
		expect(shape(edytor)[1]).toEqual({ type: 'video' });
		expect(editor.querySelector('[data-edytor-media-uploading]')).toBeNull();
		expect(editor.querySelector('[data-edytor-media-error]')).not.toBeNull();
	});

	it('a kind with no upload, or a readonly view, claims nothing', async () => {
		const plain = await mount([createVideoPlugin()]);
		expect(await pasteFiles(plain.editor, [file('clip.mp4', 'video/mp4')])).toBe(true);
		expect(shape(plain.edytor).map((block) => block.type)).toEqual(['paragraph']);
		document.body.innerHTML = '';
		const { upload } = deferred();
		const readonly = await mount([createVideoPlugin({ upload })], true);
		await pasteFiles(readonly.editor, [file('clip.mp4', 'video/mp4')]);
		expect(upload).not.toHaveBeenCalled();
		expect(shape(readonly.edytor).map((block) => block.type)).toEqual(['paragraph']);
	});
});
