<script lang="ts">
	import {
		Edytor,
		createCodePlugin,
		type CodeHeader,
		type JSONDoc,
		type LanguageMenu,
		type Plugin
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// Code blocks drawn with the two snippets below.
	const code = createCodePlugin({ header, menu });
</script>

<!-- A window bar: the language as a tag, Copy as a quiet button. -->
{#snippet header(header: CodeHeader)}
	<div class="bar">
		<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
		{#if header.editable}
			<button class="tag" aria-label="Language: {header.label}" {@attach header.button}>
				{header.label} ▾
			</button>
		{:else}
			<span class="tag">{header.label}</span>
		{/if}
		<button
			class="copy"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => header.copy()}
		>
			{header.copied ? 'Copied' : 'Copy'}
		</button>
	</div>
{/snippet}

<!-- A dark palette: a filter over the languages as chips. -->
{#snippet menu(menu: LanguageMenu)}
	<div class="palette">
		<input
			aria-label="Filter languages"
			placeholder="Filter…"
			value={menu.query}
			oninput={(event) => menu.search(event.currentTarget.value)}
			{@attach menu.keys}
		/>
		<div class="chips" aria-label="Languages" {@attach menu.popup}>
			{#each menu.items as item, index (item.item.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div
					class="chip"
					data-selected={item.selected}
					data-current={item.current}
					onmousemove={item.select}
					onclick={item.run}
					{@attach menu.option(index)}
				>
					{item.item.label}
				</div>
			{/each}
		</div>
		{#if menu.items.length === 0}
			<div class="none" role="status">No match</div>
		{/if}
	</div>
{/snippet}

<Edytor {value} plugins={[code, ...plugins]} aria-label="Code demo" />

<style>
	.bar {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 10px;
	}
	.dots {
		display: flex;
		gap: 5px;
	}
	.dots i {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: #ff5f57;
	}
	.dots i:nth-child(2) {
		background: #febc2e;
	}
	.dots i:nth-child(3) {
		background: #28c840;
	}
	.tag,
	.copy {
		padding: 1px 8px;
		border: 1px solid #d9d7d2;
		border-radius: 999px;
		background: #fff;
		color: #45433f;
		font: 600 11px/18px ui-monospace, SFMono-Regular, Menlo, monospace;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		cursor: pointer;
	}
	.copy {
		margin-left: auto;
		border-color: transparent;
		background: transparent;
	}
	.tag:hover,
	.copy:hover {
		border-color: #a8a5a0;
	}
	.palette {
		width: 260px;
		padding: 8px;
		border-radius: 12px;
		background: #1f2328;
		color: #e6edf3;
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.25);
		font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	input {
		box-sizing: border-box;
		width: 100%;
		margin-bottom: 8px;
		padding: 6px 8px;
		border: 1px solid #3d444d;
		border-radius: 8px;
		background: #151b23;
		color: inherit;
		font: inherit;
		outline: none;
	}
	.chips {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 4px;
		max-height: 200px;
		overflow-y: auto;
	}
	.chip {
		padding: 4px 8px;
		border-radius: 6px;
		cursor: pointer;
	}
	.none {
		padding: 4px 8px;
		color: #9198a1;
	}
	.chip[data-current='true'] {
		color: #7ee787;
	}
	.chip[data-selected='true'] {
		background: #2f81f7;
		color: #fff;
	}
</style>
