/** @jsxImportSource ../../jsx */
/**
 * NW-07 — a readonly view of an empty image block is a passive placeholder:
 * no "Add an image" button, no link panel, no file input, so a viewer can
 * never run the consumer's `upload(file)` (an orphan file) before the write
 * is refused. The editable view keeps the panel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const mount = async (readonly: boolean) => {
	const upload = vi.fn(async () => 'https://example.com/a.png');
	const rendered = await renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [richTextPlugin, mentionPlugin, createImagePlugin({ upload })],
			readonly,
			value: { children: [{ type: 'image', content: [{ text: '' }] }] }
		}
	);
	return { ...rendered, upload };
};

const open = async () => {
	const add = document.querySelector<HTMLButtonElement>('[data-edytor-image-add]');
	add?.click();
	await flushDomUpdates();
};

describe('an empty image in a readonly view (NW-07)', () => {
	it('renders a passive placeholder: no Add button, no link field, no file input', async () => {
		const { upload } = await mount(true);
		expect(document.querySelector('[data-edytor-image-empty]')).not.toBeNull();
		expect(document.querySelector('[data-edytor-image-placeholder]')).not.toBeNull();
		await open();
		expect(document.querySelector('[data-edytor-image-add]')).toBeNull();
		expect(document.querySelector('[data-edytor-image-form]')).toBeNull();
		expect(document.querySelector('input[type=file]')).toBeNull();
		expect(upload).not.toHaveBeenCalled();
	});

	it('an editable view keeps the panel, and switching to readonly removes it', async () => {
		const { edytor, upload } = await mount(false);
		expect(document.querySelector('[data-edytor-image-placeholder]')).toBeNull();
		await open();
		expect(document.querySelector('[data-edytor-image-form]')).not.toBeNull();
		expect(document.querySelector('input[type=file]')).not.toBeNull();
		edytor.readonly = true;
		await flushDomUpdates();
		expect(document.querySelector('[data-edytor-image-add]')).toBeNull();
		expect(document.querySelector('input[type=file]')).toBeNull();
		expect(upload).not.toHaveBeenCalled();
	});
});
