<script lang="ts">
	import {
		Edytor,
		createMediaEmptyPlugin,
		createUploadsPlugin,
		createVideoPlugin,
		type JSONDoc,
		type MediaEmptyController,
		type Plugin
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// Uploads stay in this tab: the file's object URL.
	const uploads = createUploadsPlugin({
		upload: async (file, report) => {
			report.progress(1);
			return URL.createObjectURL(file);
		}
	});

	// Every empty media block drawn with the snippet below.
	const slot = createMediaEmptyPlugin({ empty });
	const video = createVideoPlugin();

	let over = $state(false);
</script>

<!-- A film slate: a drop zone with a link field under it. -->
{#snippet empty(panel: MediaEmptyController)}
	{#if panel.pending?.status === 'uploading'}
		<div class="slate" role="status">
			<span class="title">Loading the reel…</span>
			<progress value={panel.pending.progress ?? undefined} max="1"></progress>
		</div>
	{:else if panel.readonly}
		<div class="slate"><span class="title">{panel.icon} No {panel.kind} yet</span></div>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="slate"
			class:over
			ondragenter={() => (over = true)}
			ondragleave={() => (over = false)}
			ondrop={() => (over = false)}
		>
			<span class="clapper" aria-hidden="true">{panel.icon}</span>
			<span class="title">Roll a {panel.kind}</span>
			<form
				onsubmit={(event) => {
					event.preventDefault();
					panel.embed();
				}}
			>
				<input
					aria-label="Link to a {panel.kind} file"
					placeholder="https://…/clip.mp4"
					bind:value={panel.draft}
					{@attach panel.field}
				/>
				<button type="submit">Action</button>
			</form>
			{#if panel.canUpload}
				<label class="pick">
					or choose a file
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
				<small role="alert">Cut: that is not a {panel.kind} file.</small>
			{/if}
		</div>
	{/if}
{/snippet}

<Edytor {value} plugins={[uploads, video, slot, ...plugins]} aria-label="Video demo" />

<style>
	.slate {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 18px 16px;
		border-radius: 10px;
		background: repeating-linear-gradient(
			135deg,
			#1f2328 0 14px,
			#2a2f36 14px 28px
		);
		color: #e6edf3;
		font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
		outline: 2px dashed transparent;
		outline-offset: -8px;
	}
	.slate.over {
		outline-color: #febc2e;
	}
	.clapper {
		font-size: 28px;
	}
	.title {
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	form {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 6px;
		width: 100%;
	}
	input:not([type='file']) {
		box-sizing: border-box;
		flex: 1;
		min-width: 180px;
		max-width: 320px;
		padding: 6px 10px;
		border: 1px solid #3d444d;
		border-radius: 8px;
		background: #151b23;
		color: inherit;
		font: inherit;
		outline: none;
	}
	button,
	.pick {
		padding: 6px 12px;
		border: 0;
		border-radius: 8px;
		background: #febc2e;
		color: #1f2328;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.pick {
		background: transparent;
		color: #febc2e;
		text-decoration: underline;
	}
	small {
		color: #ff7b72;
	}
</style>
