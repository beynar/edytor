<script lang="ts">
	import { getContext, untrack, type Snippet } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import { imageLabels } from './image.js';
	import { ImageEmptyController } from './empty.svelte.js';
	import type { FileUploads, Uploader } from '../uploads.svelte.js';

	/**
	 * Notion's empty image: "Add an image", then a link field (and Upload with
	 * an `upload`). A readonly view, or a suggestion's preview (no `block`),
	 * shows a passive placeholder: no control may run `upload` for a write the
	 * view would refuse. A pasted or dropped file whose upload failed
	 * (`error`) opens the panel with its error; embedding a source forgets
	 * it. A block whose upload answered while it was not shown (`landed`: its
	 * paste undone, then redone) gets that URL as soon as it shows here. Its
	 * state is an `ImageEmptyController`, which an `empty` snippet renders
	 * instead of this markup.
	 */
	let {
		block,
		upload,
		uploads,
		error = null,
		landed = false,
		empty
	}: {
		block: Block | undefined;
		upload?: Uploader;
		uploads?: FileUploads;
		error?: 'upload' | null;
		landed?: boolean;
		empty?: Snippet<[ImageEmptyController]>;
	} = $props();

	// After the flush that shows the block: never inside the transaction that showed it.
	$effect(() => {
		if (landed && block && !block.edytor.readonly) {
			const id = block.id;
			untrack(() => uploads?.fill(id));
		}
	});
	/** The words of the view rendering it (a suggestion's preview included). */
	const labels = imageLabels.of(getContext<Edytor>('edytor'));
	const panel = untrack(() => new ImageEmptyController(block, labels, { upload, uploads, error }));
</script>

{#if empty}
	{@render empty(panel)}
{:else if panel.readonly}
	<div data-edytor-image-placeholder><span aria-hidden="true">🖼</span> {labels.image}</div>
{:else}
	<button
		type="button"
		data-edytor-image-add
		onmousedown={(event) => event.preventDefault()}
		onclick={panel.toggle}><span aria-hidden="true">🖼</span> {labels.add}</button
	>
	{#if panel.open}
		<div data-edytor-image-form>
			<input
				placeholder={labels.linkPlaceholder}
				aria-label={labels.link}
				bind:value={panel.draft}
				{@attach panel.field}
			/>
			<button type="button" onclick={() => panel.embed()}>{labels.embed}</button>
			{#if panel.canUpload}
				<label data-edytor-image-upload>
					{labels.upload}
					<input
						type="file"
						accept="image/*"
						hidden
						onchange={(event) => {
							const file = event.currentTarget.files?.[0];
							if (file) void panel.upload(file);
						}}
					/>
				</label>
			{/if}
			{#if panel.failed === 'inline'}
				<small data-edytor-image-error="inline"
					>{labels.tooLarge(panel.inlineLimit, panel.canUpload)}</small
				>
			{:else if panel.failed === 'upload'}
				<small data-edytor-image-error="upload">{labels.uploadFailed}</small>
			{:else if panel.failed}
				<small data-edytor-image-error="invalid">{labels.invalid}</small>
			{/if}
		</div>
	{/if}
{/if}
