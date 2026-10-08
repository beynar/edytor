<script lang="ts">
	import { getContext, untrack } from 'svelte';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { mediaLabels, type MediaKind } from './media.js';
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
	 * as it shows.
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
	const labels = $derived(mediaLabels[kind].of(view));
	const words = $derived(labels[kind]);
	/** The button and placeholder text ("Embed a link"); the file's names its upload. */
	const label = $derived(upload && 'addOrUpload' in words ? words.addOrUpload : words.add);
	const { placeholder, submit, invalid } = $derived(words);
	/** The upload of a pasted or dropped file into this block, if any. */
	const uploads = $derived(block ? fileUploads(block.edytor) : undefined);
	const pending = $derived(block ? uploads?.of(block.id) : undefined);
	// After the flush that shows the block: never inside the transaction that showed it.
	$effect(() => {
		if (pending?.status === 'landed' && block && !block.edytor.readonly) {
			const id = block.id;
			untrack(() => uploads?.fill(id));
		}
	});
	let draft = $state('');
	let open = $state(false);
	let failed = $state<'invalid' | 'upload' | false>(false);
	// The panel opens on a failed upload, with its error; the user closes it.
	$effect(() => {
		if (pending?.status === 'failed')
			untrack(() => {
				open = true;
				failed = 'upload';
			});
	});

	const embed = (value: string) => {
		failed = link(value) ? false : 'invalid';
		if (!failed && block) uploads?.clear(block.id);
	};
</script>

{#if pending?.status === 'uploading'}
	<div data-edytor-media-uploading role="status">
		<span aria-hidden="true">{icon}</span>
		<progress value={pending.progress ?? undefined} max="1"></progress>
		{labels.uploading}
	</div>
{:else if !block || block.edytor.readonly}
	<div data-edytor-media-placeholder><span aria-hidden="true">{icon}</span> {label}</div>
{:else}
	<button
		type="button"
		data-edytor-media-add
		onmousedown={(event) => event.preventDefault()}
		onclick={() => (open = !open)}><span aria-hidden="true">{icon}</span> {label}</button
	>
	{#if open}
		<div data-edytor-media-form>
			<input
				{placeholder}
				aria-label={placeholder}
				bind:value={draft}
				onkeydown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						embed(draft);
					}
				}}
			/>
			<button type="button" onclick={() => embed(draft)}>{submit}</button>
			{#if upload}
				<label data-edytor-media-upload>
					{labels.upload}
					<input
						type="file"
						{accept}
						hidden
						onchange={async (event) => {
							const picked = event.currentTarget.files?.[0];
							if (!picked || !block || block.edytor.readonly) return;
							const { edytor, id, type } = block;
							let src: string;
							try {
								src = await upload(picked, { progress: () => {} });
							} catch {
								failed = 'upload';
								return;
							}
							// Write only to the block as it was picked from: still in the
							// tree, of its kind and empty (a peer may have set a source, or
							// deleted it, while the upload ran).
							const live = edytor.idToBlock.get(id);
							if (!live?.isInTree || live.type !== type || edytor.readonly) return;
							if (edytor.facade.blockDataOf(id)?.src !== undefined) return;
							failed = (file ? file(picked, src) : link(src)) ? false : 'invalid';
						}}
					/>
				</label>
			{/if}
			{#if failed === 'upload'}
				<small data-edytor-media-error="upload">{labels.uploadFailed}</small>
			{:else if failed}
				<small data-edytor-media-error="invalid">{invalid}</small>
			{/if}
		</div>
	{/if}
{/if}
