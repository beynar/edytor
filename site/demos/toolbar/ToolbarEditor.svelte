<script lang="ts">
	import {
		Edytor,
		createToolbarPlugin,
		type JSONDoc,
		type Plugin,
		type ToolbarController
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// A dark pill for the selection, a matching card under hovered links.
	const toolbar = createToolbarPlugin({ toolbar: bar, card });

	const highlights = [
		{ name: 'Yellow', value: '#fde68a' },
		{ name: 'Mint', value: '#bbf7d0' },
		{ name: 'Sky', value: '#bae6fd' }
	];
</script>

{#snippet bar(controller: ToolbarController)}
	<div class="frame">
		<div class="pill" {@attach controller.popup} {@attach controller.keys}>
			{#each controller.marks as { mark, label, icon } (mark)}
				<button
					aria-label={label}
					aria-pressed={controller.isActive(mark)}
					onclick={() => controller.toggleMark(mark)}
				>
					{icon}
				</button>
			{/each}
			<span class="rule" aria-hidden="true"></span>
			{#each highlights as swatch (swatch.value)}
				<button
					class="dot"
					aria-label="Highlight {swatch.name}"
					style:background={swatch.value}
					onclick={() => controller.setColor('highlight', swatch.value)}
				></button>
			{/each}
			<button aria-label="Clear highlight" onclick={() => controller.setColor('highlight', null)}>
				✕
			</button>
			<span class="rule" aria-hidden="true"></span>
			<button aria-expanded={controller.panel === 'link'} onclick={() => controller.togglePanel('link')}>
				Link
			</button>
		</div>
		{#if controller.panel === 'link'}
			<div class="field">
				<input
					aria-label="Link URL"
					placeholder="https://…"
					value={controller.linkUrl}
					oninput={(event) => controller.setLinkUrl(event.currentTarget.value)}
					{@attach controller.linkField}
				/>
				<button onclick={() => controller.applyLink()}>Apply</button>
				<button onclick={() => controller.removeLink()}>Remove</button>
			</div>
		{/if}
	</div>
{/snippet}

{#snippet card(controller: ToolbarController)}
	<div class="chip">
		<span class="url">{controller.hoveredHref}</span>
		<button onclick={() => controller.openHovered()}>Open ↗</button>
		<button onclick={() => controller.removeHovered()}>Unlink</button>
	</div>
{/snippet}

<Edytor {value} plugins={[toolbar, ...plugins]} aria-label="Toolbar demo" />

<style>
	.frame {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
	}
	.pill,
	.field,
	.chip {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 4px 6px;
		border-radius: 999px;
		background: #1f2328;
		color: #e6edf3;
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.25);
		font: 500 13px/1 ui-sans-serif, system-ui, sans-serif;
		white-space: nowrap;
	}
	button {
		min-width: 26px;
		height: 26px;
		padding: 0 8px;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	button:hover,
	button[aria-expanded='true'] {
		background: #373e47;
	}
	button[aria-pressed='true'] {
		background: #2f81f7;
		color: #fff;
	}
	.dot {
		min-width: 14px;
		width: 14px;
		height: 14px;
		margin: 0 3px;
		padding: 0;
		border: 1px solid rgb(255 255 255 / 0.3);
	}
	.rule {
		width: 1px;
		height: 16px;
		margin: 0 4px;
		background: #3d444d;
	}
	.field {
		padding: 4px;
		border-radius: 12px;
	}
	input {
		width: 200px;
		height: 26px;
		padding: 0 8px;
		border: 1px solid #3d444d;
		border-radius: 8px;
		background: #151b23;
		color: inherit;
		font: inherit;
		outline: none;
	}
	.chip {
		padding: 4px 4px 4px 12px;
	}
	.url {
		max-width: 200px;
		margin-right: 6px;
		overflow: hidden;
		color: #9198a1;
		text-overflow: ellipsis;
	}
</style>
