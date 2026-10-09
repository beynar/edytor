<script lang="ts">
	import type { LanguageMenu } from './languageMenu.svelte.js';

	/**
	 * The code language list (`LanguageMenu`), in the overlay under the
	 * language button of its block: the plugin's `menu` snippet, else a
	 * search field holding the keys (a `combobox` naming the highlighted row)
	 * over the listbox of languages. Both keep the keys and the ARIA through
	 * the controller's attachments (`keys`, `popup`, `option(index)`).
	 */
	let { menu, readonly }: { menu: LanguageMenu; readonly: () => boolean } = $props();

	const place = $derived(menu.place);
	const custom = $derived(menu.settings.menu);

	// The view turning readonly closes it.
	$effect(() => {
		if (readonly()) menu.lock();
	});
</script>

<div role="presentation">
	{#if place && custom}
		<div data-edytor-code-language-panel style:left="{place.left}px" style:top="{place.top}px">
			{@render custom(menu)}
		</div>
	{:else if place}
		<div data-edytor-code-language-menu style:left="{place.left}px" style:top="{place.top}px">
			<input
				type="text"
				placeholder={menu.labels.search}
				spellcheck="false"
				autocomplete="off"
				autocapitalize="off"
				value={menu.query}
				oninput={(event) => menu.search(event.currentTarget.value)}
				{@attach menu.keys}
			/>
			<div data-edytor-code-language-list {@attach menu.popup}>
				{#each menu.items as item, index (item.item.id)}
					<!-- The field keeps the focus: a row is pressed, never focused. -->
					<div
						{...menu.option(index)}
						data-edytor-code-language-option={item.item.id}
						data-current={item.current ? '' : undefined}
						onmousemove={item.select}
						onclick={item.run}
						role="option"
					>
						{item.label}
					</div>
				{/each}
			</div>
			{#if menu.rows.length === 0}
				<div data-edytor-code-language-empty role="status">{menu.labels.noResults}</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	[data-edytor-code-language-panel] {
		position: absolute;
	}
	[data-edytor-code-language-menu] {
		position: absolute;
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
	[role='listbox'] {
		max-height: 280px;
		overflow-y: auto;
	}
	[role='option'] {
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
	[role='option'][data-current]::after {
		content: '✓';
	}
	[role='option'][aria-selected='true'] {
		background: rgba(84, 72, 49, 0.08);
	}
	[data-edytor-code-language-empty] {
		padding: 4px 8px;
		color: #73726e;
	}
</style>
