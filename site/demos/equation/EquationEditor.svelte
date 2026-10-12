<script lang="ts">
	import {
		Edytor,
		createEquationPlugin,
		type EquationEditor,
		type EquationErrorPayload,
		type EquationPlaceholderPayload,
		type JSONDoc,
		type Plugin
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// Equations with their own panel, placeholder and error.
	const equations = createEquationPlugin({ panel, placeholder, error });
</script>

<!-- A dark panel: a monospace field, the message in amber, a round Done. -->
{#snippet panel(editor: EquationEditor)}
	<div class="panel" role="dialog" aria-label="Equation">
		<div class="row">
			<textarea
				aria-label="TeX"
				placeholder="TeX, e.g. x^2 + y^2 = z^2"
				rows={editor.display ? 3 : 1}
				spellcheck="false"
				value={editor.expression}
				oninput={(event) => editor.set(event.currentTarget.value)}
				{@attach editor.field}
			></textarea>
			<button
				class="done"
				aria-label="Done"
				onmousedown={(event) => event.preventDefault()}
				onclick={() => editor.close()}
			>
				✓
			</button>
		</div>
		{#if editor.error}
			<div class="message" role="status">{editor.error}</div>
		{/if}
	</div>
{/snippet}

<!-- An empty equation: a dashed slot with a sigma. -->
{#snippet placeholder(empty: EquationPlaceholderPayload)}
	<span class="slot" data-block={empty.display}>∑ {empty.label}</span>
{/snippet}

<!-- TeX KaTeX cannot read: the source on a pale red ground, with a flag. -->
{#snippet error(failed: EquationErrorPayload)}
	<code class="broken" title={failed.error}>⚠ {failed.expression}</code>
{/snippet}

<Edytor {value} plugins={[equations, ...plugins]} aria-label="Equation demo" />

<style>
	.panel {
		box-sizing: border-box;
		width: 380px;
		max-width: calc(100vw - 32px);
		padding: 8px;
		border-radius: 12px;
		background: #1f2328;
		color: #e6edf3;
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.25);
		font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.row {
		display: flex;
		gap: 8px;
		align-items: flex-start;
	}
	textarea {
		flex: 1;
		box-sizing: border-box;
		padding: 6px 8px;
		border: 1px solid #3d444d;
		border-radius: 8px;
		background: #151b23;
		color: inherit;
		font: inherit;
		outline: none;
		resize: vertical;
	}
	textarea:focus {
		border-color: #7c5cff;
	}
	.done {
		flex: none;
		width: 30px;
		height: 30px;
		border: 0;
		border-radius: 50%;
		background: #7c5cff;
		color: #fff;
		font-size: 14px;
		cursor: pointer;
	}
	.message {
		margin-top: 6px;
		color: #f2cc60;
		font-size: 12px;
	}
	.slot {
		display: inline-block;
		padding: 2px 10px;
		border: 1px dashed #b4a5ff;
		border-radius: 8px;
		background: #f5f2ff;
		color: #6b4fd8;
		font: 500 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.slot[data-block='true'] {
		display: block;
		padding: 14px;
		text-align: center;
	}
	.broken {
		padding: 1px 6px;
		border-radius: 6px;
		background: #fff1f0;
		color: #c0392b;
		font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
	}
</style>
