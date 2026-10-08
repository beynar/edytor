<script lang="ts">
	import { getContext, untrack } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import {
		MAX_INLINE_IMAGE_BYTES,
		imageLabels,
		oversizedInlineImage,
		safeImageSrc
	} from './image.js';
	import type { ImageUploads } from './uploads.svelte.js';

	/**
	 * Notion's empty image: "Add an image", then a link field (and Upload with
	 * an `upload`). A readonly view, or a suggestion's preview (no `block`),
	 * shows a passive placeholder: no control may run `upload` for a write the
	 * view would refuse. A pasted or dropped file whose upload failed
	 * (`error`) opens the panel with its error; embedding a source forgets
	 * it. A block whose upload answered while it was not shown (`landed`: its
	 * paste undone, then redone) gets that URL as soon as it shows here.
	 */
	let {
		block,
		upload,
		uploads,
		error = null,
		landed = false
	}: {
		block: Block | undefined;
		upload?: (file: File) => Promise<string>;
		uploads?: ImageUploads;
		error?: 'upload' | null;
		landed?: boolean;
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
	let draft = $state('');
	// The panel opens on a failed upload; the user closes it.
	let open = $state(untrack(() => error !== null));
	/** Why the last link or upload was not embedded (`null`: it was). */
	let failed = $state<'invalid' | 'inline' | 'upload' | null>(untrack(() => error));
	const inlineLimit = `${MAX_INLINE_IMAGE_BYTES / (1024 * 1024)} MB`;

	const embed = (value: string) => {
		const src = safeImageSrc(value);
		// An inline image over the cap is never stored (H6): it would weigh on every sync.
		failed = !src ? 'invalid' : oversizedInlineImage(src) ? 'inline' : null;
		if (src && failed === null && block) {
			block.data.src = src;
			uploads?.clear(block.id);
		}
	};
</script>

{#if !block || block.edytor.readonly}
	<div data-edytor-image-placeholder><span aria-hidden="true">🖼</span> {labels.image}</div>
{:else}
	<button
		type="button"
		data-edytor-image-add
		onmousedown={(event) => event.preventDefault()}
		onclick={() => (open = !open)}><span aria-hidden="true">🖼</span> {labels.add}</button
	>
	{#if open}
		<div data-edytor-image-form>
			<input
				placeholder={labels.linkPlaceholder}
				aria-label={labels.link}
				bind:value={draft}
				onkeydown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						embed(draft);
					}
				}}
			/>
			<button type="button" onclick={() => embed(draft)}>{labels.embed}</button>
			{#if upload}
				<label data-edytor-image-upload>
					{labels.upload}
					<input
						type="file"
						accept="image/*"
						hidden
						onchange={async (event) => {
							const file = event.currentTarget.files?.[0];
							if (!file || block?.edytor.readonly !== false) return;
							try {
								embed(await upload(file));
							} catch {
								failed = 'upload';
							}
						}}
					/>
				</label>
			{/if}
			{#if failed === 'inline'}
				<small data-edytor-image-error="inline"
					>{labels.tooLarge(inlineLimit, Boolean(upload))}</small
				>
			{:else if failed === 'upload'}
				<small data-edytor-image-error="upload">{labels.uploadFailed}</small>
			{:else if failed}
				<small data-edytor-image-error="invalid">{labels.invalid}</small>
			{/if}
		</div>
	{/if}
{/if}
