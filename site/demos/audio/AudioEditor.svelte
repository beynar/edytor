<script lang="ts">
	import {
		Edytor,
		createAudioPlugin,
		createMediaEmptyPlugin,
		createUploadsPlugin,
		type JSONDoc,
		type MediaEmptyController,
		type Plugin
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// An app would upload to its storage; this keeps the file in the tab.
	const uploads = createUploadsPlugin({
		upload: async (file, report) => {
			report.progress(1);
			return URL.createObjectURL(file);
		}
	});

	// The empty slot of every media block, drawn by the snippet below.
	const empty = createMediaEmptyPlugin({ empty: slot });
	const audio = createAudioPlugin();
</script>

<!-- A drop zone: one big target, the link field below it. -->
{#snippet slot(slot: MediaEmptyController)}
	{#if slot.pending?.status === 'uploading'}
		<div class="zone" role="status">
			<progress value={slot.pending.progress ?? undefined} max="1"></progress>
			Uploading…
		</div>
	{:else if slot.readonly}
		<div class="zone">{slot.icon} Nothing here yet</div>
	{:else}
		<div class="zone">
			<span class="icon" aria-hidden="true">{slot.icon}</span>
			<strong>Add a sound</strong>
			<div class="row">
				<input
					placeholder="https://…/clip.mp3"
					aria-label="Audio link"
					bind:value={slot.draft}
					{@attach slot.field}
				/>
				<button type="button" onclick={() => slot.embed()}>Link</button>
				{#if slot.canUpload}
					<label class="pick">
						Upload
						<input
							type="file"
							accept={slot.accept}
							hidden
							onchange={(event) => {
								const picked = event.currentTarget.files?.[0];
								if (picked) void slot.upload(picked);
							}}
						/>
					</label>
				{/if}
			</div>
			{#if slot.failed}
				<small>That did not work. Try another file or link.</small>
			{/if}
		</div>
	{/if}
{/snippet}

<Edytor {value} plugins={[audio, empty, uploads, ...plugins]} aria-label="Audio demo" />

<style>
	.zone {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 20px 16px;
		border: 2px dashed #c9c5f0;
		border-radius: 14px;
		background: #f6f5ff;
		color: #4b44a8;
		font-size: 14px;
	}
	.icon {
		font-size: 28px;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 6px;
		width: 100%;
	}
	input:not([type='file']) {
		flex: 1;
		min-width: 180px;
		max-width: 320px;
		height: 30px;
		padding: 0 10px;
		border: 1px solid #c9c5f0;
		border-radius: 999px;
		background: #fff;
		font: inherit;
		outline: none;
	}
	button,
	.pick {
		height: 30px;
		padding: 0 14px;
		border: 0;
		border-radius: 999px;
		background: #5b52d6;
		color: #fff;
		font: inherit;
		line-height: 30px;
		cursor: pointer;
	}
	.pick {
		background: #fff;
		color: #5b52d6;
		box-shadow: inset 0 0 0 1px #5b52d6;
	}
	small {
		color: #c0392b;
	}
</style>
