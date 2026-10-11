<script lang="ts">
	import { words } from './words.svelte.js';
	import type { ImageEmptyController } from '$lib/index.js';

	/**
	 * Notion's empty image, drawn for `createImagePlugin({ empty })`: "Add an
	 * image", then a link field (and Upload with an `upload`). A readonly
	 * view, or a suggestion's preview, shows a passive placeholder.
	 */
	let { panel }: { panel: ImageEmptyController } = $props();
	const labels = $derived(words.image);
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

<style>
	[data-edytor-image-add],
	[data-edytor-image-placeholder] {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 12px 36px 12px 12px;
		border-radius: 6px;
		background: rgba(33, 27, 23, 0.04);
		color: var(--notion-text-secondary, #73726e);
		font: inherit;
		font-size: 14px;
		text-align: left;
		cursor: pointer;
		transition: background-color 80ms ease;
	}
	[data-edytor-image-placeholder] {
		cursor: default;
	}
	[data-edytor-image-add]:hover {
		background: rgba(33, 27, 23, 0.07);
	}
	[data-edytor-image-form] {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	[data-edytor-image-form] input:not([type='file']) {
		flex: 1;
		min-width: 200px;
		height: 32px;
		padding: 0 10px;
		border-radius: 6px;
		background: rgba(242, 241, 238, 0.6);
		box-shadow: inset 0 0 0 1px rgba(15, 15, 15, 0.1);
		font: inherit;
		font-size: 14px;
		outline: 0;
	}
	[data-edytor-image-form] button,
	[data-edytor-image-upload] {
		height: 32px;
		padding: 0 12px;
		border-radius: 6px;
		background: var(--notion-blue, #2383e2);
		color: #fff;
		font-size: 14px;
		font-weight: 500;
		line-height: 32px;
		cursor: pointer;
	}
	[data-edytor-image-form] small {
		flex-basis: 100%;
		color: #cf5148;
	}
</style>
