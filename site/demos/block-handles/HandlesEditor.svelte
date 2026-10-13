<script lang="ts">
	import {
		Edytor,
		createBlockHandlesPlugin,
		type BlockHandleSnippetPayload,
		type JSONDoc,
		type Plugin
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// A round + and a tinted grip pill, drawn by the handle snippet below.
	const handles = createBlockHandlesPlugin({ handle });
</script>

{#snippet handle({ label, grip, plus, readonly, beside, draggable }: BlockHandleSnippetPayload)}
	{#if !readonly}
		<button
			class="plus"
			contenteditable="false"
			aria-label={beside ? `Add a column beside ${label}` : `Add a block below ${label}`}
			title="Add below (Alt: above)"
			{@attach plus}
		>
			+
		</button>
		<button
			class="grip"
			contenteditable="false"
			data-draggable={draggable ? 'true' : undefined}
			aria-label={`${label} block: drag to move, click for actions`}
			title={label}
			{@attach grip}
		>
			<span aria-hidden="true">⠿</span>
		</button>
	{/if}
{/snippet}

<Edytor {value} plugins={[handles, ...plugins]} aria-label="Block handles demo" />

<style>
	.plus,
	.grip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 22px;
		padding: 0;
		border: 0;
		cursor: pointer;
		font: 600 14px/1 system-ui, sans-serif;
		transition:
			background-color 80ms ease,
			color 80ms ease;
	}
	.plus {
		width: 22px;
		border-radius: 50%;
		background: #eef0ff;
		color: #4f46e5;
	}
	.grip {
		width: 20px;
		margin-left: 2px;
		border-radius: 6px;
		background: #f1efe9;
		color: #8a857b;
	}
	.grip[data-draggable='true'] {
		cursor: grab;
	}
	.plus:hover,
	.plus:focus-visible {
		background: #4f46e5;
		color: #fff;
		outline: 0;
	}
	.grip:hover,
	.grip:focus-visible {
		background: #4f46e5;
		color: #fff;
		outline: 0;
	}
</style>
