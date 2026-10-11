<script lang="ts">
	import { words } from './words.svelte.js';
	import type { MediaEmptyController } from '$lib/index.js';

	/**
	 * A media block's empty state (the image's pattern, Notion), drawn for a
	 * media plugin's `empty`: an "Add …" button, then a link field (and
	 * Upload with the kind's `upload`); a pasted or dropped file's upload and
	 * progress; a readonly view's (or a suggestion preview's) placeholder.
	 */
	let { panel }: { panel: MediaEmptyController } = $props();
	const labels = $derived(words.media);
	const own = $derived(labels[panel.kind]);
	const { placeholder, submit, invalid } = $derived(own);
	/** The button and placeholder text ("Embed a link"; the file's names its upload). */
	const label = $derived(panel.canUpload && 'addOrUpload' in own ? own.addOrUpload : own.add);
	const pending = $derived(panel.pending);
</script>

{#if pending?.status === 'uploading'}
	<div data-edytor-media-uploading role="status">
		<span aria-hidden="true">{panel.icon}</span>
		<progress value={pending.progress ?? undefined} max="1"></progress>
		{labels.uploading}
	</div>
{:else if panel.readonly}
	<div data-edytor-media-placeholder>
		<span aria-hidden="true">{panel.icon}</span>
		{label}
	</div>
{:else}
	<button
		type="button"
		data-edytor-media-add
		onmousedown={(event) => event.preventDefault()}
		onclick={panel.toggle}><span aria-hidden="true">{panel.icon}</span> {label}</button
	>
	{#if panel.open}
		<div data-edytor-media-form>
			<input
				{placeholder}
				aria-label={placeholder}
				bind:value={panel.draft}
				{@attach panel.field}
			/>
			<button type="button" onclick={() => panel.embed()}>{submit}</button>
			{#if panel.canUpload}
				<label data-edytor-media-upload>
					{labels.upload}
					<input
						type="file"
						accept={panel.accept}
						hidden
						onchange={(event) => {
							const picked = event.currentTarget.files?.[0];
							if (picked) void panel.upload(picked);
						}}
					/>
				</label>
			{/if}
			{#if panel.failed}
				<small data-edytor-media-error={panel.failed}
					>{panel.failed === 'upload' ? labels.uploadFailed : invalid}</small
				>
			{/if}
		</div>
	{/if}
{/if}

<style>
	[data-edytor-media-add],
	[data-edytor-media-placeholder] {
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
		text-decoration: none;
		cursor: pointer;
		transition: background-color 80ms ease;
	}
	[data-edytor-media-placeholder] {
		cursor: default;
	}
	[data-edytor-media-add]:hover {
		background: rgba(33, 27, 23, 0.07);
	}
	[data-edytor-media-form] {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	[data-edytor-media-form] input:not([type='file']) {
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
	[data-edytor-media-form] button,
	[data-edytor-media-upload] {
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
	[data-edytor-media-form] small {
		flex-basis: 100%;
		color: #cf5148;
	}
</style>
