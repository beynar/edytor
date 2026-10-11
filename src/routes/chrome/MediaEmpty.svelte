<script lang="ts">
	import type { MediaEmptyController } from '$lib/index.js';

	/**
	 * A media block's empty state (the image's pattern, Notion), drawn for a
	 * media plugin's `empty`: an "Add …" button, then a link field (and
	 * Upload with the kind's `upload`); a pasted or dropped file's upload and
	 * progress; a readonly view's (or a suggestion preview's) placeholder.
	 */
	let { panel }: { panel: MediaEmptyController } = $props();
	const labels = $derived(panel.labels);
	const { placeholder, submit, invalid } = $derived(panel.kindLabels);
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
		{panel.label}
	</div>
{:else}
	<button
		type="button"
		data-edytor-media-add
		onmousedown={(event) => event.preventDefault()}
		onclick={panel.toggle}><span aria-hidden="true">{panel.icon}</span> {panel.label}</button
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
