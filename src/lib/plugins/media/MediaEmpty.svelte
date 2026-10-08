<script lang="ts">
	import { getContext, untrack } from 'svelte';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { mediaEmpty, mediaLabels, type MediaKind } from './media.js';
	import { MediaEmptyController } from './empty.svelte.js';
	import { fileUploads, type Uploader } from '../uploads.svelte.js';

	/**
	 * A media block's empty state (the image's pattern, Notion): an "Add …"
	 * button, then a link field (and Upload with an `upload`). `link` answers
	 * whether it took the link; `file` stores an uploaded file's URL (an
	 * upload fills `src`, and only a block still empty when it lands). A
	 * readonly view, or a suggestion's preview (no `block`), shows a passive
	 * placeholder: no control may run `upload` (or a bookmark's `unfurl`) for
	 * a write the view would refuse. A pasted or dropped file (`media.files`)
	 * shows its upload and progress here; a failed one opens the panel with
	 * its error; data answered while the block was not shown fills it as soon
	 * as it shows. Its state is a `MediaEmptyController`, which the view's
	 * `empty` snippet for the kind renders instead of this markup.
	 */
	let {
		block,
		kind,
		icon,
		accept,
		upload,
		link,
		file
	}: {
		block: Block | undefined;
		/** Whose words it shows, in the labels of the view rendering it (a suggestion's preview included). */
		kind: MediaKind;
		icon: string;
		/** The file picker's `accept`. */
		accept?: string;
		upload?: Uploader;
		link: (value: string) => boolean;
		file?: (file: File, src: string) => boolean;
	} = $props();
	/** The view rendering it (a suggestion's preview included): whose labels it shows. */
	const view = getContext<Edytor>('edytor');
	const panel = untrack(
		() =>
			new MediaEmptyController(block, kind, icon, () => mediaLabels[kind].of(view), {
				accept,
				upload,
				link: (value) => link(value),
				file: file && ((picked, src) => file(picked, src))
			})
	);
	const empty = untrack(() => mediaEmpty.of(block?.edytor ?? view, kind));
	const labels = $derived(panel.labels);
	const { placeholder, submit, invalid } = $derived(panel.kindLabels);
	/** The upload of a pasted or dropped file into this block, if any. */
	const pending = $derived(panel.pending);
	// After the flush that shows the block: never inside the transaction that showed it.
	$effect(() => {
		if (pending?.status === 'landed' && block && !block.edytor.readonly) {
			const id = block.id;
			untrack(() => fileUploads(block.edytor)?.fill(id));
		}
	});
	// The panel opens on a failed upload, with its error; the user closes it.
	$effect(() => {
		if (pending?.status === 'failed')
			untrack(() => {
				panel.open = true;
				panel.failed = 'upload';
			});
	});
</script>

{#if empty}
	{@render empty(panel)}
{:else if pending?.status === 'uploading'}
	<div data-edytor-media-uploading role="status">
		<span aria-hidden="true">{icon}</span>
		<progress value={pending.progress ?? undefined} max="1"></progress>
		{labels.uploading}
	</div>
{:else if panel.readonly}
	<div data-edytor-media-placeholder><span aria-hidden="true">{icon}</span> {panel.label}</div>
{:else}
	<button
		type="button"
		data-edytor-media-add
		onmousedown={(event) => event.preventDefault()}
		onclick={panel.toggle}><span aria-hidden="true">{icon}</span> {panel.label}</button
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
						{accept}
						hidden
						onchange={(event) => {
							const picked = event.currentTarget.files?.[0];
							if (picked) void panel.upload(picked);
						}}
					/>
				</label>
			{/if}
			{#if panel.failed === 'upload'}
				<small data-edytor-media-error="upload">{labels.uploadFailed}</small>
			{:else if panel.failed}
				<small data-edytor-media-error="invalid">{invalid}</small>
			{/if}
		</div>
	{/if}
{/if}
