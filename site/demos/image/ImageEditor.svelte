<script lang="ts">
	import {
		Edytor,
		createImageToolbarPlugin,
		createMediaEmptyPlugin,
		type ImageToolbar,
		type JSONDoc,
		type MediaEmptyController,
		type Plugin
	} from 'edytor';

	// The page's document and the rest of your editor's plugins (the uploads one).
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// The empty slot and the toolbar over the hovered image, drawn below.
	const empty = createMediaEmptyPlugin({ empty: emptySlot });
	const toolbar = createImageToolbarPlugin({ toolbar: bar });

	const aligns = [
		{ align: 'left', label: 'Left' },
		{ align: 'center', label: 'Center' },
		{ align: 'right', label: 'Right' }
	] as const;
</script>

<!-- A dashed drop zone: pick a file or paste a link. -->
{#snippet emptySlot(panel: MediaEmptyController)}
	{#if panel.pending?.status === 'uploading'}
		<div class="zone" role="status">Uploading…</div>
	{:else if panel.readonly}
		<div class="zone">No picture yet</div>
	{:else}
		<div class="zone">
			<span class="hint">{panel.icon} Drop a picture, or</span>
			{#if panel.canUpload}
				<label class="pick">
					choose a file
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
			<input
				class="link"
				aria-label="Image link"
				placeholder="paste a link"
				bind:value={panel.draft}
				{@attach panel.field}
				onkeydown={(event) => event.key === 'Enter' && panel.embed()}
			/>
			{#if panel.failed}
				<small role="alert">That link or file was refused.</small>
			{/if}
		</div>
	{/if}
{/snippet}

<!-- A dark pill: three alignments and a quiet alt text field. -->
{#snippet bar(controls: ImageToolbar)}
	{#if controls.box}
		{@const box = controls.box}
		<div class="pill" {@attach controls.bar}>
			{#each aligns as { align, label } (align)}
				<button
					type="button"
					aria-pressed={box.align === align}
					onmousedown={(event) => event.preventDefault()}
					onclick={() => controls.align(align)}
				>
					{label}
				</button>
			{/each}
			<button
				type="button"
				aria-expanded={controls.editing === box.id}
				onmousedown={(event) => event.preventDefault()}
				onclick={() => controls.toggleAlt()}
			>
				Alt
			</button>
			{#if controls.editing === box.id}
				<input
					class="alt"
					aria-label="Alt text"
					placeholder="Describe the picture"
					value={controls.alt}
					oninput={(event) => controls.setAlt(event.currentTarget.value)}
					{@attach controls.altField}
				/>
			{/if}
		</div>
	{/if}
{/snippet}

<Edytor {value} plugins={[empty, toolbar, ...plugins]} aria-label="Image demo" />

<style>
	.zone {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 18px 14px;
		border: 1.5px dashed #b9b5ad;
		border-radius: 12px;
		background: #faf8f4;
		color: #6b6862;
		font-size: 14px;
	}
	.pick {
		padding: 3px 10px;
		border-radius: 999px;
		background: #355070;
		color: #fff;
		font-weight: 600;
		cursor: pointer;
	}
	.link {
		flex: 1;
		min-width: 140px;
		padding: 4px 10px;
		border: 1px solid #d9d7d2;
		border-radius: 999px;
		background: #fff;
		font: inherit;
		outline: none;
	}
	small {
		flex-basis: 100%;
		color: #b3402f;
	}
	.pill {
		display: flex;
		position: relative;
		align-items: center;
		gap: 2px;
		width: max-content;
		margin-left: auto;
		padding: 3px;
		border-radius: 999px;
		background: #1f2328;
		box-shadow: 0 8px 20px rgb(0 0 0 / 0.25);
	}
	.pill button {
		padding: 2px 10px;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: #c9d1d9;
		font: 600 12px/20px ui-sans-serif, system-ui, sans-serif;
		cursor: pointer;
	}
	.pill button:hover {
		color: #fff;
	}
	.pill button[aria-pressed='true'],
	.pill button[aria-expanded='true'] {
		background: #2f81f7;
		color: #fff;
	}
	.alt {
		position: absolute;
		top: 36px;
		right: 0;
		width: 220px;
		padding: 6px 10px;
		border: 0;
		border-radius: 10px;
		background: #1f2328;
		color: #e6edf3;
		font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
		outline: none;
	}
</style>
