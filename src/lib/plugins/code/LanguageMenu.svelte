<script lang="ts">
	import type { LanguageMenu } from './languageMenu.svelte.js';

	/**
	 * The code language list (`LanguageMenu`), in the overlay under the
	 * language button of its block: a search field holding the keys (a
	 * `combobox` naming the highlighted row) over the listbox of languages.
	 */
	let { menu, readonly }: { menu: LanguageMenu; readonly: () => boolean } = $props();

	let field = $state<HTMLInputElement | null>(null);
	let list = $state<HTMLElement | null>(null);
	const rows = $derived(menu.rows);
	const current = $derived(menu.current);
	const active = $derived(rows[menu.index]);

	// The view turning readonly closes it.
	$effect(() => {
		if (readonly()) menu.lock();
	});
	// Opened: the field takes the keys.
	$effect(() => {
		if (menu.open && field) field.focus({ preventScroll: true });
	});
	// The highlighted row stays in view.
	$effect(() => {
		if (!active || !list) return;
		list.ownerDocument.getElementById(menu.rowId(active))?.scrollIntoView?.({ block: 'nearest' });
	});
	// Published to the view's root once in the page (`edytor.popups`).
	$effect(() => {
		const open = Boolean(menu.open && menu.box && list);
		menu.edytor.popups.set(
			'code-languages',
			open ? { id: menu.listId, haspopup: 'listbox' } : null
		);
	});
	$effect(() => () => menu.edytor.popups.set('code-languages', null));

	const keydown = (event: KeyboardEvent) => {
		if (event.isComposing) return;
		const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
		if (step) menu.move(step);
		else if (event.key === 'Enter') menu.pick();
		else if (event.key === 'Escape') menu.close(menu.open?.keys ? 'button' : 'editor');
		else return;
		event.preventDefault();
		event.stopPropagation();
	};
</script>

<div role="presentation">
	{#if menu.open && menu.box}
		{@const box = menu.box}
		<div
			data-edytor-code-language-menu
			style:left="{box.x}px"
			style:top="{box.y + box.height + 4}px"
		>
			<input
				bind:this={field}
				type="text"
				role="combobox"
				aria-label={menu.labels.language}
				aria-expanded="true"
				aria-controls={menu.listId}
				aria-autocomplete="list"
				aria-activedescendant={active ? menu.rowId(active) : undefined}
				placeholder={menu.labels.search}
				spellcheck="false"
				autocomplete="off"
				autocapitalize="off"
				value={menu.query}
				oninput={(event) => menu.search(event.currentTarget.value)}
				onkeydown={keydown}
				onfocusout={menu.blurred}
			/>
			<div
				bind:this={list}
				id={menu.listId}
				role="listbox"
				aria-label={menu.labels.language}
				data-edytor-code-language-list
			>
				{#each rows as row, index (row.id)}
					<!-- The field keeps the focus: a row is pressed, never focused. -->
					<div
						id={menu.rowId(row)}
						role="option"
						tabindex="-1"
						aria-selected={index === menu.index}
						data-edytor-code-language-option={row.id}
						data-current={row.id === current ? '' : undefined}
						onmousedown={(event) => event.preventDefault()}
						onmousemove={() => (menu.index = index)}
						onclick={() => menu.pick(row)}
						onkeydown={keydown}
					>
						{row.label}
					</div>
				{/each}
			</div>
			{#if rows.length === 0}
				<div data-edytor-code-language-empty role="status">{menu.labels.noResults}</div>
			{/if}
		</div>
	{/if}
</div>

<style>
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
