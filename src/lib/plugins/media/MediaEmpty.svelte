<script lang="ts">
	import type { Block } from '$lib/block/block.svelte.js';

	/**
	 * A media block's empty state (the image's pattern, Notion): an "Add …"
	 * button, then a link field (and Upload with an `upload`). `link` answers
	 * whether it took the link; `file` stores an uploaded file's URL (an
	 * upload fills `src`, and only a block still empty when it lands). A
	 * readonly view, or a suggestion's preview (no `block`), shows a passive
	 * placeholder: no control may run `upload` (or a bookmark's `unfurl`) for
	 * a write the view would refuse.
	 */
	let {
		block,
		label,
		icon,
		placeholder,
		submit,
		invalid,
		accept,
		upload,
		link,
		file
	}: {
		block: Block | undefined;
		/** The button and placeholder text ("Embed a link"). */
		label: string;
		icon: string;
		/** The link field's placeholder. */
		placeholder: string;
		/** The submit button's text. */
		submit: string;
		/** The error line under a refused link. */
		invalid: string;
		/** The file picker's `accept`. */
		accept?: string;
		upload?: (file: File) => Promise<string>;
		link: (value: string) => boolean;
		file?: (file: File, src: string) => boolean;
	} = $props();
	let draft = $state('');
	let open = $state(false);
	let failed = $state(false);

	const embed = (value: string) => {
		failed = !link(value);
	};
</script>

{#if !block || block.edytor.readonly}
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
					Upload
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
								src = await upload(picked);
							} catch {
								failed = true;
								return;
							}
							// Write only to the block as it was picked from: still in the
							// tree, of its kind and empty (a peer may have set a source, or
							// deleted it, while the upload ran).
							const live = edytor.idToBlock.get(id);
							if (!live?.isInTree || live.type !== type || edytor.readonly) return;
							if (edytor.facade.blockDataOf(id)?.src !== undefined) return;
							failed = !(file ? file(picked, src) : link(src));
						}}
					/>
				</label>
			{/if}
			{#if failed}
				<small data-edytor-media-error>{invalid}</small>
			{/if}
		</div>
	{/if}
{/if}
