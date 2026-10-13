<script lang="ts">
	import {
		Edytor,
		createEmbedPlugin,
		type EmbedFallbackPayload,
		type JSONDoc,
		type Plugin,
		type UrlPasteController
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	const labels: Record<string, string> = { link: 'Keep as link', embed: 'Embed player', bookmark: 'Bookmark' };

	// A link no provider plays, and the menu a pasted link opens, drawn with the two snippets below.
	const embeds = createEmbedPlugin({ fallback, menu });
</script>

<!-- A postcard instead of a bare link. -->
{#snippet fallback(embed: EmbedFallbackPayload)}
	<a class="card" href={embed.url} {@attach embed.link}>
		<span class="host">{new URL(embed.url).host}</span>
		<span class="note">No player for this link. Open it in a new tab ↗</span>
	</a>
{/snippet}

<!-- Pill buttons in a dark strip. -->
{#snippet menu(controller: UrlPasteController)}
	<div class="strip" {@attach controller.popup}>
		{#each controller.open?.options ?? [] as option, index (option.id)}
			<button
				type="button"
				class="pill"
				data-selected={controller.index === index}
				{@attach controller.option(index)}
				onmousemove={() => (controller.index = index)}
				onclick={() => controller.pick(option)}
			>
				{option.icon} {labels[option.id] ?? option.id}
			</button>
		{/each}
	</div>
{/snippet}

<Edytor {value} plugins={[embeds, ...plugins]} aria-label="Embed demo" />

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 12px 14px;
		border: 1px dashed #c9b88f;
		border-radius: 10px;
		background: #fbf6e8;
		color: #5a4a1f;
		text-decoration: none;
	}
	.card:hover {
		border-style: solid;
	}
	.host {
		font: 600 14px/20px ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.note {
		font-size: 12px;
		opacity: 0.75;
	}
	.strip {
		display: flex;
		gap: 4px;
		padding: 4px;
		border-radius: 999px;
		background: #1f2328;
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.25);
	}
	.pill {
		padding: 3px 12px;
		border-radius: 999px;
		color: #e6edf3;
		font: 13px/20px ui-sans-serif, system-ui, sans-serif;
		white-space: nowrap;
		cursor: pointer;
	}
	.pill[data-selected='true'] {
		background: #2f81f7;
		color: #fff;
	}
</style>
