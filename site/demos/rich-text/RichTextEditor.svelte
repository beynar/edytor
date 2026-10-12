<script lang="ts">
	import {
		Edytor,
		createRichTextPlugin,
		type CalloutIconPayload,
		type EmptyBodyPayload,
		type JSONDoc,
		type Plugin,
		type TodoCheckboxPayload
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// Rich text with its three controls drawn by the snippets below.
	const richText = createRichTextPlugin({ checkbox, calloutIcon, emptyBody });
</script>

<!-- A round check that fills in when done. -->
{#snippet checkbox(box: TodoCheckboxPayload)}
	<button type="button" class="check" data-done={box.checked} {@attach box.control}>
		{box.checked ? '✓' : ''}
	</button>
{/snippet}

<!-- The icon on a tinted tile. -->
{#snippet calloutIcon(icon: CalloutIconPayload)}
	{#if icon.editable}
		<button type="button" class="icon" {@attach icon.control}>{icon.icon || '+'}</button>
	{:else}
		<span class="icon" {@attach icon.control}>{icon.icon}</span>
	{/if}
{/snippet}

<!-- A dashed hint that says what a click does. -->
{#snippet emptyBody(hint: EmptyBodyPayload)}
	<p class="hint" {@attach hint.control}>＋ Add a {hint.kind} body</p>
{/snippet}

<Edytor {value} plugins={[richText, ...plugins]} aria-label="Rich text demo" />

<style>
	.check {
		width: 18px;
		height: 18px;
		padding: 0;
		border: 2px solid #a8a5a0;
		border-radius: 50%;
		background: #fff;
		color: #fff;
		font: 700 11px/14px system-ui, sans-serif;
		cursor: pointer;
	}
	.check[data-done='true'] {
		border-color: #1a7f4b;
		background: #1a7f4b;
	}
	.icon.icon {
		display: inline-grid;
		place-items: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 0;
		border-radius: 8px;
		background: #fff3c4;
		font-size: 16px;
		line-height: 1;
	}
	button.icon {
		cursor: pointer;
	}
	.hint {
		margin: 2px 0;
		padding: 2px 8px;
		border: 1px dashed #c9c6c0;
		border-radius: 6px;
		color: #8a8782;
		font-size: 13px;
		cursor: pointer;
	}
	.hint:hover {
		border-color: #8a8782;
		color: #45433f;
	}
</style>
