<script lang="ts">
	import {
		Edytor,
		createTocPlugin,
		type JSONDoc,
		type Plugin,
		type TocEmptyPayload,
		type TocEntryPayload
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// The table drawn with the two snippets below.
	const toc = createTocPlugin({ entry, empty });
</script>

<!-- Numbered chapters: the level as a small figure, the indent from depth. -->
{#snippet entry(heading: TocEntryPayload)}
	<button
		type="button"
		class="entry"
		data-level={heading.level}
		style:margin-inline-start="{heading.depth * 18}px"
		{@attach heading.control}
	>
		<span class="level">H{heading.level}</span>
		{heading.label}
	</button>
{/snippet}

<!-- A friendlier hint while there is no heading. -->
{#snippet empty(none: TocEmptyPayload)}
	<p class="none">{none.label} Try typing # then a space.</p>
{/snippet}

<Edytor {value} plugins={[toc, ...plugins]} aria-label="Table of contents demo" />

<style>
	.entry {
		display: flex;
		align-items: baseline;
		gap: 8px;
		width: fit-content;
		padding: 2px 10px 2px 4px;
		border: 0;
		border-left: 2px solid #d9d7d2;
		border-radius: 0 6px 6px 0;
		background: transparent;
		color: #45433f;
		font: inherit;
		font-size: 14px;
		cursor: pointer;
	}
	.entry:hover {
		border-left-color: #2f81f7;
		background: #eef4ff;
		color: #1f4fa3;
	}
	.level {
		font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
		color: #8b8883;
	}
	.none {
		margin: 0;
		padding: 6px 10px;
		border: 1px dashed #d9d7d2;
		border-radius: 8px;
		color: #8b8883;
		font-size: 14px;
	}
</style>
