<script lang="ts">
	import { Button } from '$registry/ui/button/index.js';
	import { Input } from '$registry/ui/input/index.js';
	import { words } from './words.svelte.js';
	import { MAX_INLINE_IMAGE_BYTES, type MediaEmptyController } from 'edytor';

	/**
	 * Notion's empty image or media block, drawn for an image or media
	 * plugin's `empty`: an "Add …" button, then a link field (and Upload
	 * with the kind's `upload`); a pasted or dropped file's upload, its
	 * progress (and an image's preview); a readonly view's (or a suggestion
	 * preview's) placeholder. Its marks are `data-edytor-image-*` for an
	 * image, `data-edytor-media-*` for the others.
	 */
	let { panel }: { panel: MediaEmptyController } = $props();
	const image = $derived(panel.kind === 'image');
	const media = $derived(words.media);
	/** The kind's words: its button, field, submit and refusal. */
	const own = $derived(
		panel.kind === 'image'
			? {
					add: words.image.add,
					field: words.image.link,
					placeholder: words.image.linkPlaceholder,
					submit: words.image.embed,
					invalid: words.image.invalid,
					idle: words.image.image
				}
			: (() => {
					const kind = media[panel.kind];
					const add = panel.canUpload && 'addOrUpload' in kind ? kind.addOrUpload : kind.add;
					return { ...kind, add, field: kind.placeholder, idle: add };
				})()
	);
	const upload = $derived(image ? words.image.upload : media.upload);
	const pending = $derived(panel.pending);
	/** The kind's mark on a part: `data-edytor-image-<part>`, else `data-edytor-media-<part>`. */
	const mark = (part: string, value = '') => ({
		[`data-edytor-${image ? 'image' : 'media'}-${part}`]: value
	});
	const failure = (failed: NonNullable<MediaEmptyController['failed']>) =>
		failed === 'upload'
			? media.uploadFailed
			: failed === 'inline'
				? words.image.tooLarge(`${MAX_INLINE_IMAGE_BYTES / (1024 * 1024)} MB`, panel.canUpload)
				: own.invalid;
</script>

{#if pending?.status === 'uploading'}
	<div class="empty-uploading" {...mark('uploading')} role="status">
		{#if pending.preview}<img src={pending.preview} alt="" draggable="false" />{/if}
		<span aria-hidden="true">{panel.icon}</span>
		<progress value={pending.progress ?? undefined} max="1"></progress>
		{media.uploading}
	</div>
{:else if panel.readonly}
	<div class="empty-add" {...mark('placeholder')}>
		<span aria-hidden="true">{panel.icon}</span>
		{own.idle}
	</div>
{:else}
	<Button
		variant="ghost"
		class="empty-add"
		{...mark('add')}
		onmousedown={(event) => event.preventDefault()}
		onclick={() => (panel.open = !panel.open)}
		><span aria-hidden="true">{panel.icon}</span> {own.add}</Button
	>
	{#if panel.open}
		<div class="empty-form" {...mark('form')}>
			<Input
				placeholder={own.placeholder}
				aria-label={own.field}
				bind:value={panel.draft}
				{@attach panel.field}
			/>
			<Button variant="ghost" onclick={() => panel.embed()}>{own.submit}</Button>
			{#if panel.canUpload}
				<label class="empty-upload" {...mark('upload')}>
					{upload}
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
				<small {...mark('error', panel.failed)}>{failure(panel.failed)}</small>
			{/if}
		</div>
	{/if}
{/if}

<style>
	:global(.empty-add) {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 12px 36px 12px 12px;
		border-radius: 6px;
		background: var(--accent);
		color: var(--muted-foreground);
		font: inherit;
		font-size: 14px;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
		transition: background-color 80ms ease;
	}
	div.empty-add {
		cursor: default;
	}
	:global(button.empty-add:hover) {
		background: var(--accent);
	}
	.empty-uploading {
		display: flex;
		position: relative;
		align-items: center;
		gap: 10px;
		min-height: 48px;
		padding: 12px;
		border-radius: 6px;
		background: var(--accent);
		color: var(--muted-foreground);
		font-size: 14px;
	}
	.empty-uploading img {
		max-width: 100%;
		opacity: 0.5;
	}
	.empty-form {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.empty-form :global(input:not([type='file'])) {
		flex: 1;
		min-width: 200px;
		height: 32px;
		padding: 0 10px;
		border-radius: 6px;
		background: var(--muted);
		box-shadow: inset 0 0 0 1px var(--border);
		font: inherit;
		font-size: 14px;
		outline: 0;
	}
	.empty-form :global(button),
	.empty-upload {
		height: 32px;
		padding: 0 12px;
		border-radius: 6px;
		background: var(--primary);
		color: var(--primary-foreground);
		font-size: 14px;
		font-weight: 500;
		line-height: 32px;
		cursor: pointer;
	}
	.empty-form small {
		flex-basis: 100%;
		color: var(--destructive);
	}
</style>
