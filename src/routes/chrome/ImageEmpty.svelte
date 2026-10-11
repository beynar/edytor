<script lang="ts">
	import type { ImageEmptyController } from '$lib/index.js';

	/**
	 * Notion's empty image, drawn for `createImagePlugin({ empty })`: "Add an
	 * image", then a link field (and Upload with an `upload`). A readonly
	 * view, or a suggestion's preview, shows a passive placeholder.
	 */
	let { panel }: { panel: ImageEmptyController } = $props();
	const labels = $derived(panel.labels);
</script>

{#if panel.readonly}
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
			{#if panel.failed}
				<small data-edytor-image-error={panel.failed}
					>{panel.failed === 'inline'
						? labels.tooLarge(panel.inlineLimit, panel.canUpload)
						: panel.failed === 'upload'
							? labels.uploadFailed
							: labels.invalid}</small
				>
			{/if}
		</div>
	{/if}
{/if}
