<script lang="ts">
	import type { Block } from '$lib/block/block.svelte.js';
	import { MAX_INLINE_IMAGE_BYTES, oversizedInlineImage, safeImageSrc } from './image.js';

	/**
	 * Notion's empty image: "Add an image", then a link field (and Upload with
	 * an `upload`). A readonly view, or a suggestion's preview (no `block`),
	 * shows a passive placeholder: no control may run `upload` for a write the
	 * view would refuse.
	 */
	let { block, upload }: { block: Block | undefined; upload?: (file: File) => Promise<string> } =
		$props();
	let draft = $state('');
	let open = $state(false);
	/** Why the last link or upload was not embedded (`null`: it was). */
	let failed = $state<'invalid' | 'inline' | null>(null);
	const inlineLimit = `${MAX_INLINE_IMAGE_BYTES / (1024 * 1024)} MB`;

	const embed = (value: string) => {
		const src = safeImageSrc(value);
		// An inline image over the cap is never stored (H6): it would weigh on every sync.
		failed = !src ? 'invalid' : oversizedInlineImage(src) ? 'inline' : null;
		if (src && failed === null && block) block.data.src = src;
	};
</script>

{#if !block || block.edytor.readonly}
	<div data-edytor-image-placeholder><span aria-hidden="true">🖼</span> Image</div>
{:else}
	<button
		type="button"
		data-edytor-image-add
		onmousedown={(event) => event.preventDefault()}
		onclick={() => (open = !open)}><span aria-hidden="true">🖼</span> Add an image</button
	>
	{#if open}
		<div data-edytor-image-form>
			<input
				placeholder="Paste the image link…"
				aria-label="Image link"
				bind:value={draft}
				onkeydown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						embed(draft);
					}
				}}
			/>
			<button type="button" onclick={() => embed(draft)}>Embed image</button>
			{#if upload}
				<label data-edytor-image-upload>
					Upload
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
								failed = 'invalid';
							}
						}}
					/>
				</label>
			{/if}
			{#if failed === 'inline'}
				<small data-edytor-image-error="inline"
					>Inline images are limited to {inlineLimit}: {upload
						? 'upload the file instead'
						: 'host the image and paste its link'}.</small
				>
			{:else if failed}
				<small data-edytor-image-error="invalid"
					>That doesn't look like an image link or upload.</small
				>
			{/if}
		</div>
	{/if}
{/if}
