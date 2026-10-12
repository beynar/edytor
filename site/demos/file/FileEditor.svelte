<script lang="ts">
	import { Edytor, createFilePlugin, type FileRowPayload, type JSONDoc, type Plugin } from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// File blocks drawn as a ticket: an extension badge, the name, the size.
	const files = createFilePlugin({ row });

	const extension = (name: string) => (name.split('.').pop() ?? 'file').slice(0, 4).toUpperCase();
</script>

{#snippet row(file: FileRowPayload)}
	<a class="ticket" href={file.src} {@attach file.link}>
		<span class="badge">{extension(file.name)}</span>
		<span class="name">{file.name}</span>
		{#if file.sizeLabel}<span class="size">{file.sizeLabel}</span>{/if}
		<span class="arrow" aria-hidden="true">↓</span>
	</a>
{/snippet}

<Edytor {value} plugins={[files, ...plugins]} aria-label="File demo" />

<style>
	.ticket {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 14px;
		border: 1px dashed #c9a96e;
		border-radius: 10px;
		background: #fdf8ee;
		color: #4a3b1c;
		text-decoration: none;
	}
	.ticket:hover {
		background: #faf0d8;
	}
	.badge {
		padding: 2px 8px;
		border-radius: 6px;
		background: #4a3b1c;
		color: #fdf8ee;
		font: 700 11px/18px ui-monospace, SFMono-Regular, Menlo, monospace;
		letter-spacing: 0.06em;
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.size {
		color: #8a7547;
		font-size: 12px;
	}
	.arrow {
		color: #8a7547;
	}
</style>
