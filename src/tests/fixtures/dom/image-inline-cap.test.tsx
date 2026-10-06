/** @jsxImportSource ../../jsx */
/**
 * Phase 2, H6 — an inline (`data:`) image over 1 MiB is never stored: the
 * link field refuses it and names the way out (the plugin's `upload`, or a
 * hosted link), an HTML paste does not import it, and a smaller one embeds
 * (`net.chunk.outbound` in `docs/editor-delete-contract.md`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createImagePlugin,
	MAX_INLINE_IMAGE_BYTES,
	storableImageSrc
} from '$lib/plugins/image/ImagePlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { BlockDefinition } from '$lib/plugins.js';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const inline = (bytes: number) => {
	const head = 'data:image/png;base64,';
	return head + 'A'.repeat(bytes - head.length);
};

const mount = async (upload?: (file: File) => Promise<string>) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [richTextPlugin, createImagePlugin({ upload })],
			value: { children: [{ id: 'img', type: 'image', content: [{ text: '' }] }] }
		}
	);

/** Paste `src` into the link field and press Enter. */
const embed = async (src: string) => {
	document.querySelector<HTMLButtonElement>('[data-edytor-image-add]')!.click();
	await flushDomUpdates();
	const field = document.querySelector<HTMLInputElement>('[data-edytor-image-form] input')!;
	field.value = src;
	field.dispatchEvent(new Event('input', { bubbles: true }));
	field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	await flushDomUpdates();
};

describe('inline images are capped at 1 MiB (H6)', () => {
	it('the link field refuses a larger one and points to upload', async () => {
		const { edytor } = await mount(vi.fn(async () => 'https://example.com/a.png'));
		await embed(inline(MAX_INLINE_IMAGE_BYTES + 1));
		expect(edytor.facade.blockDataOf('img')?.src).toBeUndefined();
		const error = document.querySelector('[data-edytor-image-error]');
		expect(error?.getAttribute('data-edytor-image-error')).toBe('inline');
		expect(error?.textContent).toContain('upload the file instead');
	});

	it('without upload, it points to a hosted link; a smaller inline image embeds', async () => {
		const { edytor } = await mount();
		await embed(inline(MAX_INLINE_IMAGE_BYTES + 1));
		expect(document.querySelector('[data-edytor-image-error]')?.textContent).toContain(
			'host the image and paste its link'
		);
		const small = inline(2048);
		const field = document.querySelector<HTMLInputElement>('[data-edytor-image-form] input')!;
		field.value = small;
		field.dispatchEvent(new Event('input', { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await flushDomUpdates();
		expect(edytor.facade.blockDataOf('img')).toEqual({ src: small });
	});

	it('an HTML paste does not import a larger one', () => {
		const plugin = createImagePlugin();
		const record = plugin(undefined as never).blocks!.image as BlockDefinition;
		const figure = (src: string) => {
			const el = document.createElement('figure');
			const img = document.createElement('img');
			img.setAttribute('src', src);
			el.append(img);
			return el;
		};
		expect(record.parse!(figure(inline(MAX_INLINE_IMAGE_BYTES + 1)))).toBeUndefined();
		expect(record.parse!(figure(inline(1024)))).toEqual({ src: inline(1024) });
		expect(storableImageSrc('https://example.com/huge.png')).toBe('https://example.com/huge.png');
	});
});
