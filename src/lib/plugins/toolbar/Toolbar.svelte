<script lang="ts">
	import type { ToolbarController, ToolbarMark } from './ToolbarController.svelte.js';
	let { controller }: { controller: ToolbarController } = $props();
	const marks: Array<{ mark: ToolbarMark; label: string; icon: string; testId: string }> = [
		{ mark: 'bold', label: 'Bold', icon: 'B', testId: 'toolbar-bold' },
		{ mark: 'italic', label: 'Italic', icon: 'I', testId: 'toolbar-italic' },
		{ mark: 'underline', label: 'Underline', icon: 'U', testId: 'toolbar-underline' },
		{ mark: 'strike', label: 'Strike', icon: 'S', testId: 'toolbar-strike' },
		{ mark: 'code', label: 'Code', icon: '</>', testId: 'toolbar-code' }
	];
</script>

{#if controller.isVisible}
	<div
		class="selection-toolbar"
		data-testid="selection-toolbar"
		role="toolbar"
		aria-label="Text formatting"
	>
		<span class="toolbar-type">Text</span>
		<span class="toolbar-divider" aria-hidden="true"></span>
		{#each marks as item (item.mark)}
			<button
				type="button"
				class={`mark-${item.mark}`}
				aria-label={item.label}
				title={item.label}
				data-testid={item.testId}
				onmousedown={(event) => event.preventDefault()}
				onclick={() => controller.toggleMark(item.mark)}>{item.icon}</button
			>
		{/each}
		<span class="toolbar-divider" aria-hidden="true"></span>
		<label class="sr-only" for="edytor-toolbar-link">Link URL</label>
		<input
			id="edytor-toolbar-link"
			data-testid="toolbar-link-input"
			placeholder="Paste link…"
			value={controller.linkUrl}
			oninput={(event) => controller.setLinkUrl(event.currentTarget.value)}
		/>
		<button
			type="button"
			class="toolbar-link-action"
			data-testid="toolbar-link-apply"
			title="Apply link"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => controller.applyLink()}>↗</button
		>
		<button
			type="button"
			class="toolbar-link-action"
			data-testid="toolbar-link-remove"
			title="Remove link"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => controller.removeLink()}>×</button
		>
	</div>
{/if}

<style>
	.selection-toolbar {
		display: flex;
		align-items: center;
		gap: 2px;
		width: max-content;
		max-width: calc(100vw - 16px);
		overflow-x: auto;
		padding: 5px;
		border-radius: 8px;
		background: #fff;
		color: #37352f;
		box-shadow:
			0 6px 28px #0f0f0f2a,
			0 0 0 1px #0f0f0f12;
		font:
			13px ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			Helvetica,
			Arial,
			sans-serif;
	}
	.toolbar-type {
		padding: 0 9px;
		font-weight: 600;
		white-space: nowrap;
	}
	.toolbar-divider {
		height: 20px;
		min-width: 1px;
		margin: 0 3px;
		background: #e9e9e6;
	}
	button {
		display: grid;
		place-items: center;
		min-width: 29px;
		height: 29px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 13px;
	}
	button:hover,
	button:focus-visible {
		background: #f1f1ef;
		outline: none;
	}
	.mark-bold {
		font-weight: 800;
	}
	.mark-italic {
		font-family: Georgia, serif;
		font-style: italic;
		font-weight: 700;
		font-size: 16px;
	}
	.mark-underline {
		text-decoration: underline;
		text-underline-offset: 2px;
		font-weight: 700;
	}
	.mark-strike {
		text-decoration: line-through;
		font-weight: 700;
	}
	input {
		width: 130px;
		height: 29px;
		padding: 0 7px;
		background: #f7f7f5;
		border: 1px solid transparent;
		border-radius: 4px;
		outline: none;
		font-size: 12px;
	}
	input:focus {
		border-color: #d8d7d2;
		background: #fff;
	}
	.toolbar-link-action {
		font-size: 17px;
	}
</style>
