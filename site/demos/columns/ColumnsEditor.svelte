<script lang="ts">
	import {
		Edytor,
		createColumnsPlugin,
		type BlockSnippetPayload,
		type JSONDoc,
		type Plugin
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// Listed first, naming only the snippets: the kinds keep their roles,
	// elements and the column weights. The plugin itself follows.
	const look: Plugin = () => ({
		blocks: { columns: { snippet: layout }, column: { snippet: card } }
	});
	const columns = createColumnsPlugin({ minWidth: 0.2 });
</script>

<!-- The row of columns, numbering its cards. -->
{#snippet layout({ children }: BlockSnippetPayload)}
	{#if children}
		<div data-edytor-children class="row">
			{@render children()}
		</div>
	{/if}
{/snippet}

<!-- A column as a card with an accent bar and a number. -->
{#snippet card({ children }: BlockSnippetPayload)}
	{#if children}
		<div data-edytor-children class="card">
			{@render children()}
		</div>
	{/if}
{/snippet}

<Edytor {value} plugins={[look, columns, ...plugins]} aria-label="Columns demo" />

<style>
	.row {
		counter-reset: card;
		margin-block: 8px;
	}
	.card {
		counter-increment: card;
		position: relative;
		padding: 18px 14px 8px;
		border: 1px solid #e3e0d8;
		border-top: 3px solid #d9822b;
		border-radius: 10px;
		background: #fffaf2;
	}
	.card::before {
		content: counter(card, decimal-leading-zero);
		position: absolute;
		top: -11px;
		left: 12px;
		padding: 0 8px;
		border-radius: 999px;
		background: #d9822b;
		color: #fff;
		font: 600 11px/20px ui-monospace, SFMono-Regular, Menlo, monospace;
		letter-spacing: 0.06em;
		pointer-events: none;
	}
</style>
