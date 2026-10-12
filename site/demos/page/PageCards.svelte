<script lang="ts">
	import { Edytor, createPagePlugin, type JSONDoc, type PageBlockLinkPayload, type Plugin } from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// Subpages drawn with the `link` snippet below; opening one does nothing here.
	const pages = createPagePlugin({
		open: () => {},
		create: () => ({ pageId: crypto.randomUUID(), title: 'Untitled' }),
		link
	});
</script>

<!-- A card: a paper icon, the title, and a hint of where it leads. -->
{#snippet link(page: PageBlockLinkPayload)}
	<button type="button" class="card" disabled={!page.openable} {@attach page.control}>
		<span class="icon" aria-hidden="true">▤</span>
		<span class="title">{page.label}</span>
		<span class="go" aria-hidden="true">Open →</span>
	</button>
{/snippet}

<Edytor {value} plugins={[pages, ...plugins]} aria-label="Page demo" />

<style>
	.card {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		margin: 2px 0;
		padding: 8px 12px;
		border: 1px solid #d9d7d2;
		border-left: 4px solid #6b5bd2;
		border-radius: 8px;
		background: #faf9ff;
		color: #2b2850;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.card:hover {
		background: #f0eeff;
	}
	.icon {
		color: #6b5bd2;
	}
	.title {
		flex: 1;
		font-weight: 600;
	}
	.go {
		color: #8a86b8;
		font-size: 12px;
	}
</style>
