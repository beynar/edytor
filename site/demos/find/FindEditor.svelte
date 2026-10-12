<script lang="ts">
	import { Edytor, createFindPlugin, type FindController, type JSONDoc, type Plugin } from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// The find bar drawn by the snippet below.
	const find = createFindPlugin({ bar });
</script>

<!-- A dark pill: the query, a count, the steps, then a replace row. -->
{#snippet bar(find: FindController)}
	<div class="bar" role="search" aria-label="Find in this page">
		<div class="row">
			<input
				aria-label="Find"
				placeholder="Find…"
				value={find.query}
				oninput={(event) => (find.query = event.currentTarget.value)}
				{@attach find.field}
			/>
			<span class="count" role="status">
				{find.matches.length ? `${find.current + 1} of ${find.matches.length}` : 'No match'}
			</span>
			<button
				aria-label="Match case"
				aria-pressed={find.caseSensitive}
				onclick={() => (find.caseSensitive = !find.caseSensitive)}>Aa</button
			>
			<button aria-label="Previous match" onclick={find.previous}>↑</button>
			<button aria-label="Next match" onclick={find.next}>↓</button>
			<button aria-label="Close" onclick={() => find.close()}>✕</button>
		</div>
		{#if find.canReplace}
			<div class="row">
				<input
					aria-label="Replace with"
					placeholder="Replace with…"
					value={find.replacement}
					oninput={(event) => (find.replacement = event.currentTarget.value)}
					{@attach find.replaceField}
				/>
				<button class="go" onclick={find.replace}>Replace</button>
				<button class="go" onclick={find.replaceAll}>All</button>
			</div>
		{/if}
	</div>
{/snippet}

<Edytor {value} plugins={[find, ...plugins]} aria-label="Find demo" />

<style>
	.bar {
		display: grid;
		gap: 6px;
		width: 340px;
		max-width: calc(100vw - 32px);
		padding: 8px;
		border-radius: 14px;
		background: #1f2328;
		color: #e6edf3;
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.28);
		font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	input {
		box-sizing: border-box;
		flex: 1;
		min-width: 0;
		padding: 5px 8px;
		border: 1px solid #3d444d;
		border-radius: 8px;
		background: #151b23;
		color: inherit;
		font: inherit;
		outline: none;
	}
	input:focus {
		border-color: #2f81f7;
	}
	.count {
		color: #9198a1;
		white-space: nowrap;
	}
	button {
		padding: 3px 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	button:hover {
		background: #2d333b;
	}
	button[aria-pressed='true'] {
		background: #2f81f7;
		color: #fff;
	}
	.go {
		background: #2d333b;
	}
</style>
