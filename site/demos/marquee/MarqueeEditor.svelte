<script lang="ts">
	import {
		Edytor,
		createMarqueePlugin,
		type JSONDoc,
		type MarqueeBoxPayload,
		type Plugin
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// The rubber band drawn by the snippet below.
	const marquee = createMarqueePlugin({ box });
</script>

<!-- A dashed violet band with a badge counting the selected blocks. -->
{#snippet box({ count, adding }: MarqueeBoxPayload)}
	<div class="band" data-adding={adding}>
		{#if count > 0}
			<span class="badge">{count} {count === 1 ? 'block' : 'blocks'}</span>
		{/if}
	</div>
{/snippet}

<Edytor {value} plugins={[marquee, ...plugins]} aria-label="Marquee demo" />

<style>
	.band {
		position: relative;
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		border: 1.5px dashed #7c5cdc;
		border-radius: 8px;
		background: rgb(124 92 220 / 0.1);
	}
	.band[data-adding='true'] {
		border-color: #1a9d6b;
		background: rgb(26 157 107 / 0.1);
	}
	.badge {
		position: absolute;
		right: 6px;
		bottom: 6px;
		padding: 1px 8px;
		border-radius: 999px;
		background: #7c5cdc;
		color: #fff;
		font: 600 11px/18px ui-monospace, SFMono-Regular, Menlo, monospace;
		white-space: nowrap;
	}
	.band[data-adding='true'] .badge {
		background: #1a9d6b;
	}
</style>
