<script lang="ts">
	import {
		Edytor,
		createPageLinkPlugin,
		type JSONDoc,
		type PageLinkItem,
		type Plugin,
		type TriggerMenuController
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	const pages: PageLinkItem[] = [
		{ id: 'p1', title: 'Roadmap', icon: '🗺️' },
		{ id: 'p2', title: 'Meeting notes', icon: '📝' },
		{ id: 'p3', title: 'Design system', icon: '🎨' },
		{ id: 'p4', title: 'Release checklist', icon: '✅' },
		{ id: 'p5', title: 'Onboarding guide', icon: '👋' }
	];

	// Pages as tiles in a grid under the caret.
	const pageLinks = createPageLinkPlugin({
		search: (query) =>
			pages.filter((page) => page.title.toLowerCase().includes(query.trim().toLowerCase())),
		menu
	});
</script>

<!-- A tile grid: the page's icon large, its title underneath. -->
{#snippet menu(menu: TriggerMenuController<PageLinkItem>)}
	<div class="tiles" onmousedown={(event) => event.preventDefault()} role="presentation">
		<div class="title">Link to a page</div>
		<div class="grid" aria-label="Pages" {@attach menu.popup}>
			{#each menu.items as page, index (page.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div
					class="tile"
					data-selected={menu.index === index}
					onmousemove={() => (menu.index = index)}
					onclick={() => void menu.pick(page)}
					{@attach menu.option(index)}
				>
					<span class="icon" aria-hidden="true">{page.icon}</span>
					<span class="name">{page.title}</span>
				</div>
			{:else}
				<div class="empty" role="presentation">
					{menu.loading ? 'Searching…' : 'No page by that name'}
				</div>
			{/each}
		</div>
	</div>
{/snippet}

<Edytor {value} plugins={[pageLinks, ...plugins]} aria-label="Page link demo" />

<style>
	.tiles {
		width: 300px;
		padding: 10px;
		border: 1px solid #dfe3ea;
		border-radius: 14px;
		background: #f8faff;
		box-shadow: 0 12px 30px rgb(30 50 100 / 0.18);
		font: 13px/1.3 system-ui, sans-serif;
		color: #1f2a44;
	}
	.title {
		margin: 0 4px 8px;
		color: #6b7a99;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		gap: 6px;
	}
	.tile {
		display: grid;
		justify-items: center;
		gap: 4px;
		padding: 8px 4px;
		border: 1px solid transparent;
		border-radius: 10px;
		text-align: center;
		cursor: pointer;
	}
	.tile[data-selected='true'] {
		border-color: #8fa8e8;
		background: #e6edff;
	}
	.icon {
		font-size: 22px;
	}
	.name {
		font-size: 12px;
	}
	.empty {
		grid-column: 1 / -1;
		padding: 6px 8px;
		color: #6b7a99;
	}
</style>
