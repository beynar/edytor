<script lang="ts" module>
	// Client only: an editor measures the DOM.
	export const client = 'only';
</script>

<script lang="ts">
	/**
	 * A plugin page's live editor, fully local: no room, no socket, nothing
	 * saved (a reload resets it). `plugin` names the page's demo folder,
	 * `site/demos/<plugin>/`; `variant="custom"` draws the page's "Customize"
	 * component instead of the plain editor.
	 */
	import { Edytor } from 'edytor';
	import 'edytor/themes/notion.css';
	import { basePlugins } from '../demos/base';
	import { loadDemo } from '../demos/registry';

	let { plugin, variant = 'default' }: { plugin: string; variant?: 'default' | 'custom' } =
		$props();
	const demo = loadDemo(plugin);
</script>

<div class="plugin-demo edytor-notion not-prose" data-plugin={plugin} data-variant={variant}>
	{#await demo then demo}
		{@const value = structuredClone(demo.value)}
		{#if variant === 'custom' && demo.custom}
			<demo.custom {value} plugins={(demo.customPlugins ?? basePlugins)()} />
		{:else}
			<Edytor {value} plugins={demo.plugins()} allowNesting aria-label="{plugin} demo" />
		{/if}
	{:catch error}
		<p class="plugin-demo-error">{error.message}</p>
	{/await}
</div>

<style>
	/* A light page, as Notion's, in either site theme; room on the left for the handles. */
	.plugin-demo {
		box-sizing: border-box;
		min-height: 8rem;
		margin: 1rem 0 1.5rem;
		padding: 20px 24px 20px 56px;
		border: 1px solid rgb(0 0 0 / 0.08);
		border-radius: 12px;
		background: #fff;
		color: #2c2c2b;
		text-align: left;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.04);
	}
	/*
	 * The page's prose rules (`.prose :where(…)`) reach into the editor, and
	 * `not-prose` does not stop them: back to the reset the theme expects.
	 * At this weight the theme's own rules still win.
	 */
	.plugin-demo :global(:where(h1, h2, h3, h4, p, ul, ol, hr, pre)) {
		margin: 0;
	}
	.plugin-demo :global(:where(h1, h2, h3, h4)) {
		font-size: inherit;
		font-weight: inherit;
		line-height: inherit;
	}
	.plugin-demo :global(:where(pre)) {
		position: static;
		padding: 0;
		border: 0;
		border-radius: 0;
		background: none;
	}
	.plugin-demo :global(:where(table)) {
		font-size: inherit;
	}
	.plugin-demo-error {
		color: #b42318;
		font-size: 14px;
	}
	@media (max-width: 640px) {
		.plugin-demo {
			padding: 16px 16px 16px 44px;
		}
	}
</style>
