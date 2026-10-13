<script lang="ts">
	import { words } from './words.svelte.js';
	import type { LanguageMenu } from '../../index.js';

	/**
	 * The code language list, drawn for `createCodePlugin({ menu })`: a
	 * search field holding the keys (a `combobox` naming the highlighted
	 * row) over the listbox of languages.
	 */
	let { menu }: { menu: LanguageMenu } = $props();
</script>

<div data-edytor-code-language-menu>
	<input
		type="text"
		placeholder={words.code.search}
		aria-label={words.code.language}
		spellcheck="false"
		autocomplete="off"
		autocapitalize="off"
		value={menu.query}
		oninput={(event) => menu.search(event.currentTarget.value)}
		{@attach menu.keys}
	/>
	<div data-edytor-code-language-list aria-label={words.code.language} {@attach menu.popup}>
		{#each menu.items as item, index (item.item.id)}
			<!-- The field keeps the focus (its keys): a row is pressed, never focused. Its
			role and ARIA are the `option` attachment's. -->
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div
				data-edytor-code-language-option={item.item.id}
				data-current={item.current ? '' : undefined}
				data-selected={item.selected}
				onmousemove={item.select}
				onclick={item.run}
				{@attach menu.option(index)}
			>
				{item.item.label}
			</div>
		{/each}
	</div>
	{#if menu.rows.length === 0}
		<div data-edytor-code-language-empty role="status">{words.code.noResults}</div>
	{/if}
</div>

<style>
	[data-edytor-code-language-menu] {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		width: 220px;
		padding: 4px;
		border-radius: 10px;
		background: var(--edytor-menu-background, #fff);
		color: var(--edytor-menu-color, #2c2c2b);
		box-shadow:
			0 14px 28px -6px rgba(0, 0, 0, 0.1),
			0 2px 4px -1px rgba(0, 0, 0, 0.06),
			0 0 0 1px rgba(84, 72, 49, 0.08);
		font-size: 14px;
		line-height: 20px;
		font-family:
			ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI Variable Display',
			'Segoe UI',
			Helvetica,
			Arial,
			sans-serif;
	}
	input {
		box-sizing: border-box;
		width: 100%;
		margin: 0 0 4px;
		padding: 4px 8px;
		border: 1px solid rgba(84, 72, 49, 0.16);
		border-radius: 6px;
		background: rgba(242, 241, 238, 0.6);
		color: inherit;
		font: inherit;
		outline: none;
	}
	input:focus {
		border-color: var(--edytor-code-accent, #2383e2);
		box-shadow: 0 0 0 2px rgba(35, 131, 226, 0.2);
	}
	[data-edytor-code-language-list] {
		max-height: 280px;
		overflow-y: auto;
	}
	[data-edytor-code-language-option] {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		height: 28px;
		padding: 0 8px;
		border-radius: 6px;
		white-space: nowrap;
		cursor: pointer;
		user-select: none;
	}
	/* The block's own language. */
	[data-edytor-code-language-option][data-current]::after {
		content: '✓';
	}
	[data-edytor-code-language-option][data-selected='true'] {
		background: rgba(84, 72, 49, 0.08);
	}
	[data-edytor-code-language-empty] {
		padding: 4px 8px;
		color: #73726e;
	}
</style>
