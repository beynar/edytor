<script lang="ts">
	import type { MarqueeBoxPayload } from 'edytor';

	/** Notion's rubber band, drawn for `createMarqueePlugin({ box })`: its host is placed and sized to it. */
	let { box }: { box: MarqueeBoxPayload } = $props();
</script>

<div class="marquee" data-edytor-marquee data-adding={box.adding ? 'true' : undefined}></div>

<style>
	.marquee {
		box-sizing: border-box;
		width: 100%;
		height: 100%;
		background: var(--edytor-marquee-background, color-mix(in oklab, var(--ring) 14%, transparent));
		border: var(
			--edytor-marquee-border,
			1px solid color-mix(in oklab, var(--ring) 40%, transparent)
		);
		border-radius: var(--edytor-marquee-radius, 2px);
	}
</style>
