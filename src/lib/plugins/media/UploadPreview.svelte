<script module lang="ts">
	import './upload.css';
</script>

<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { FileUpload } from '../uploads.svelte.js';
	import { labelsOf, mediaEnglish } from '$lib/labels.js';

	/**
	 * A file uploading, the plugin's own markup when the view has no empty
	 * markup to draw it: an image at once from its object URL (this view's
	 * only, never stored) with the progress over it; another file's name and
	 * size, then the progress (indeterminate until `upload` reports one).
	 */
	let {
		upload,
		image = false
	}: { upload: Extract<FileUpload, { status: 'uploading' }>; image?: boolean } = $props();
	const labels = labelsOf(getContext<Edytor>('edytor'), 'media', mediaEnglish);
</script>

<div data-edytor-upload data-edytor-upload-image={image ? '' : undefined} role="status">
	{#if image && upload.preview}
		<img src={upload.preview} alt={upload.name} draggable="false" />
	{:else}
		<span data-edytor-file-name>{upload.name}</span>
		<span data-edytor-file-size>{labels.fileSize(upload.size)}</span>
	{/if}
	<progress value={upload.progress ?? undefined} max="1" aria-label={labels.uploading}></progress>
</div>
