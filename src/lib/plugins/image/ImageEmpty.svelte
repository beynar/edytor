<script lang="ts">
	import type { Block } from '$lib/block/block.svelte.js';
	import { safeImageSrc } from './image.js';

	/**
	 * Notion's empty image: "Add an image", then a link field (and Upload with
	 * an `upload`). A readonly view shows a passive placeholder: no control
	 * may run `upload` for a write the view would refuse.
	 */
	let { block, upload }: { block: Block; upload?: (file: File) => Promise<string> } = $props();
	let draft = $state('');
	let open = $state(false);
	let failed = $state(false);

	const embed = (value: string) => {
		const src = safeImageSrc(value);
		failed = !src;
		if (src) block.data.src = src;
	};
</script>

{#if block.edytor.readonly}
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
							if (!file || block.edytor.readonly) return;
							try {
								embed(await upload(file));
							} catch {
								failed = true;
							}
						}}
					/>
				</label>
			{/if}
			{#if failed}<small>That doesn't look like an image link or upload.</small>{/if}
		</div>
	{/if}
{/if}
