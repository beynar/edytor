<script lang="ts">
	import { iconOf } from '../icons.js';
	import { TOOLBAR_COLORS, type ToolbarController } from './ToolbarController.svelte.js';
	import type { Snippet } from 'svelte';
	let {
		controller,
		toolbar
	}: { controller: ToolbarController; toolbar?: Snippet<[ToolbarController]> } = $props();

	const keep = (event: MouseEvent) => event.preventDefault();
</script>

{#if controller.isVisible && toolbar}
	{@render toolbar(controller)}
{:else if controller.isVisible}
	<div class="selection-toolbar-frame">
		<div
			class="selection-toolbar"
			data-testid="selection-toolbar"
			data-edytor-toolbar-bar
			role="toolbar"
			aria-label="Text formatting"
		>
			<button
				type="button"
				class="toolbar-type"
				aria-haspopup="menu"
				aria-expanded={controller.panel === 'turn'}
				onmousedown={keep}
				onclick={() => controller.togglePanel('turn')}
				>{controller.currentKind?.label ?? 'Text'}<span class="toolbar-chevron" aria-hidden="true"
				></span></button
			>
			<span class="toolbar-divider" aria-hidden="true"></span>
			<button
				type="button"
				class="toolbar-link"
				data-testid="toolbar-link"
				aria-expanded={controller.panel === 'link'}
				style:--toolbar-icon={iconOf('mark.link')}
				onmousedown={keep}
				onclick={() => controller.togglePanel('link')}>Link</button
			>
			<span class="toolbar-divider" aria-hidden="true"></span>
			{#each controller.marks as item (item.mark)}
				<button
					type="button"
					class={`toolbar-mark mark-${item.mark}`}
					aria-label={item.label}
					title={item.label}
					data-testid={`toolbar-${item.mark}`}
					onmousedown={keep}
					onclick={() => controller.toggleMark(item.mark)}>{item.icon}</button
				>
			{/each}
			<span class="toolbar-divider" aria-hidden="true"></span>
			<button
				type="button"
				class="toolbar-color"
				aria-label="Color"
				title="Text color"
				aria-expanded={controller.panel === 'color'}
				onmousedown={keep}
				onclick={() => controller.togglePanel('color')}
				>A<span class="toolbar-chevron" aria-hidden="true"></span></button
			>
		</div>

		{#if controller.panel === 'turn'}
			<div class="toolbar-panel" role="menu" aria-label="Turn into">
				<div class="toolbar-heading">Turn into</div>
				{#each controller.kinds as kind (kind.id)}
					<button
						type="button"
						role="menuitem"
						class="toolbar-row"
						data-current={kind === controller.currentKind}
						style:--toolbar-icon={iconOf(kind.id)}
						onmousedown={keep}
						onclick={() => controller.turnInto(kind)}>{kind.label}</button
					>
				{/each}
			</div>
		{:else if controller.panel === 'link'}
			<div class="toolbar-panel toolbar-link-panel">
				<label class="sr-only" for="edytor-toolbar-link">Link URL</label>
				<input
					id="edytor-toolbar-link"
					data-testid="toolbar-link-input"
					placeholder="Paste link"
					value={controller.linkUrl}
					oninput={(event) => controller.setLinkUrl(event.currentTarget.value)}
					onkeydown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							controller.applyLink();
							controller.panel = null;
						}
					}}
				/>
				<button
					type="button"
					class="toolbar-link-action"
					data-testid="toolbar-link-apply"
					title="Apply link"
					onmousedown={keep}
					onclick={() => controller.applyLink()}>Apply</button
				>
				<button
					type="button"
					class="toolbar-link-action"
					data-testid="toolbar-link-remove"
					title="Remove link"
					onmousedown={keep}
					onclick={() => controller.removeLink()}>Remove</button
				>
			</div>
		{:else if controller.panel === 'color'}
			<div class="toolbar-panel" role="menu" aria-label="Color">
				<div class="toolbar-heading">Text color</div>
				<div class="toolbar-swatches">
					{#each TOOLBAR_COLORS as color (color.name)}
						<button
							type="button"
							role="menuitem"
							class="toolbar-swatch"
							title={`${color.name} text`}
							style:color={color.text ?? 'inherit'}
							onmousedown={keep}
							onclick={() => controller.setColor('color', color.text)}>A</button
						>
					{/each}
				</div>
				<div class="toolbar-heading">Background color</div>
				<div class="toolbar-swatches">
					{#each TOOLBAR_COLORS as color (color.name)}
						<button
							type="button"
							role="menuitem"
							class="toolbar-swatch"
							title={`${color.name} background`}
							style:background={color.background ?? 'transparent'}
							onmousedown={keep}
							onclick={() => controller.setColor('highlight', color.background)}
						></button>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.selection-toolbar-frame {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
		font-family:
			ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI Variable Display',
			'Segoe UI',
			Helvetica,
			Arial,
			sans-serif;
		font-size: 14px;
		line-height: 20px;
		color: #2c2c2b;
		animation: toolbar-in 120ms cubic-bezier(0.2, 0, 0, 1);
	}
	@keyframes toolbar-in {
		from {
			opacity: 0;
			transform: translateY(2px);
		}
	}
	.selection-toolbar,
	.toolbar-panel {
		border-radius: 10px;
		background: #fff;
		box-shadow:
			0 14px 28px -6px rgba(0, 0, 0, 0.1),
			0 2px 4px -1px rgba(0, 0, 0, 0.06),
			0 0 0 1px rgba(84, 72, 49, 0.08);
	}
	.selection-toolbar {
		display: flex;
		align-items: center;
		gap: 1px;
		height: 36px;
		padding: 0 4px;
		white-space: nowrap;
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		height: 28px;
		min-width: 28px;
		padding: 0 6px;
		border-radius: 6px;
		color: inherit;
		font: inherit;
		cursor: pointer;
		transition: background-color 80ms ease;
	}
	button:hover,
	button[aria-expanded='true'] {
		background: rgba(33, 27, 23, 0.06);
	}
	.toolbar-type {
		padding: 0 6px 0 8px;
		font-weight: 500;
	}
	.toolbar-chevron {
		width: 12px;
		height: 12px;
		background: #a19e99;
		-webkit-mask: var(--toolbar-chevron) center / 12px no-repeat;
		mask: var(--toolbar-chevron) center / 12px no-repeat;
		--toolbar-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='black' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
	}
	.toolbar-link::before,
	.toolbar-row::before {
		content: '';
		width: 18px;
		height: 18px;
		background: currentColor;
		-webkit-mask: var(--toolbar-icon) center / 18px no-repeat;
		mask: var(--toolbar-icon) center / 18px no-repeat;
	}
	.toolbar-divider {
		width: 1px;
		height: 20px;
		margin: 0 3px;
		background: rgba(28, 19, 1, 0.08);
	}
	.mark-bold {
		font-weight: 700;
	}
	.mark-italic {
		font-style: italic;
		font-family: Georgia, serif;
	}
	.mark-underline {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.mark-strike {
		text-decoration: line-through;
	}
	.mark-code {
		font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 12px;
	}
	.toolbar-color {
		font-weight: 500;
		text-decoration: underline;
		text-decoration-thickness: 2px;
		text-underline-offset: 3px;
	}
	.toolbar-panel {
		box-sizing: border-box;
		width: 240px;
		max-height: 320px;
		overflow-y: auto;
		padding: 4px;
		animation: toolbar-in 120ms cubic-bezier(0.2, 0, 0, 1);
	}
	.toolbar-heading {
		padding: 6px 8px 4px;
		color: #7d7a75;
		font-size: 12px;
		font-weight: 500;
		line-height: 16px;
	}
	.toolbar-row {
		justify-content: flex-start;
		gap: 8px;
		width: 100%;
		padding: 0 8px;
	}
	.toolbar-row[data-current='true']::after {
		content: '✓';
		margin-left: auto;
		color: #2c2c2b;
		font-size: 13px;
	}
	.toolbar-link-panel {
		display: flex;
		align-items: center;
		gap: 4px;
		width: 380px;
	}
	.toolbar-link-panel input {
		flex: 1;
		height: 28px;
		padding: 0 8px;
		border-radius: 6px;
		background: rgba(242, 241, 238, 0.6);
		box-shadow: inset 0 0 0 1px rgba(15, 15, 15, 0.1);
		color: inherit;
		font: inherit;
		outline: 0;
	}
	.toolbar-link-panel input:focus {
		box-shadow:
			inset 0 0 0 1px rgba(35, 131, 226, 0.57),
			0 0 0 2px rgba(35, 131, 226, 0.35);
	}
	.toolbar-link-action {
		color: #7d7a75;
		font-size: 13px;
	}
	.toolbar-swatches {
		display: grid;
		grid-template-columns: repeat(5, 28px);
		gap: 4px;
		padding: 2px 6px 6px;
	}
	.toolbar-swatch {
		width: 28px;
		padding: 0;
		box-shadow: inset 0 0 0 1px rgba(28, 19, 1, 0.11);
		font-weight: 500;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
</style>
