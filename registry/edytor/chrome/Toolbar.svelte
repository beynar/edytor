<script lang="ts">
	import { Button } from '$registry/ui/button/index.js';
	import { Input } from '$registry/ui/input/index.js';
	import { css } from './ui.js';
	import { words } from './words.svelte.js';
	import { iconOf, linkIcon } from './icons.js';
	import type { ToolbarController } from 'edytor';
	import { PALETTE } from './palette.js';

	/** Notion's selection toolbar, drawn for `createToolbarPlugin({ toolbar })`. */
	let { controller }: { controller: ToolbarController } = $props();

	const labels = $derived(words.toolbar);
</script>

<!--
	The bar's id, role, placement mark and publication to the view's root
	(`popup`), its roving tab stop and Escape (`keys`) and the link field's
	keys (`linkField`) are the controller's attachments.
-->
<div class="selection-toolbar-frame">
	<div
		class="selection-toolbar"
		data-testid="selection-toolbar"
		role="toolbar"
		aria-label={labels.bar}
		tabindex="-1"
		{@attach controller.popup}
		{@attach controller.keys}
	>
		<Button
			variant="ghost"
			class="toolbar-type"
			data-stop="turn"
			aria-haspopup="menu"
			aria-expanded={controller.panel === 'turn'}
			onclick={() => controller.togglePanel('turn')}
			>{controller.currentKind?.label ?? labels.text}<span
				class="toolbar-chevron"
				aria-hidden="true"
			></span></Button
		>
		<span class="toolbar-divider" aria-hidden="true"></span>
		<Button
			variant="ghost"
			class="toolbar-link"
			data-stop="link"
			data-testid="toolbar-link"
			aria-expanded={controller.panel === 'link'}
			onclick={() => controller.togglePanel('link')}
			style={css({ '--toolbar-icon': linkIcon })}>{labels.link}</Button
		>
		<span class="toolbar-divider" aria-hidden="true"></span>
		{#each controller.marks as item (item.mark)}
			<Button
				variant="ghost"
				class={`toolbar-mark mark-${item.mark}`}
				data-stop={`mark:${item.mark}`}
				aria-label={item.label}
				title={item.label}
				data-testid={`toolbar-${item.mark}`}
				aria-pressed={controller.isActive(item.mark)}
				onclick={() => controller.toggleMark(item.mark)}>{item.icon}</Button
			>
		{/each}
		<span class="toolbar-divider" aria-hidden="true"></span>
		<Button
			variant="ghost"
			class="toolbar-color"
			data-stop="color"
			aria-label={labels.color}
			title={labels.textColor}
			aria-expanded={controller.panel === 'color'}
			onclick={() => controller.togglePanel('color')}
			>A<span class="toolbar-chevron" aria-hidden="true"></span></Button
		>
	</div>

	{#if controller.panel === 'turn'}
		<div class="toolbar-panel" role="menu" aria-label={labels.turnInto}>
			<div class="toolbar-heading">{labels.turnInto}</div>
			{#each controller.kinds as kind (kind.id)}
				<Button
					variant="ghost"
					role="menuitem"
					class="toolbar-row"
					data-current={kind === controller.currentKind}
					onclick={() => controller.turnInto(kind)}
					style={css({ '--toolbar-icon': iconOf(kind.id) })}>{kind.label}</Button
				>
			{/each}
		</div>
	{:else if controller.panel === 'link'}
		<div class="toolbar-panel toolbar-link-panel">
			<label class="sr-only" for={controller.linkFieldId}>{labels.linkUrl}</label>
			<Input
				data-testid="toolbar-link-input"
				placeholder={labels.linkPlaceholder}
				value={controller.linkUrl}
				oninput={(event) => controller.setLinkUrl(event.currentTarget.value)}
				{@attach controller.linkField}
			/>
			<Button
				variant="ghost"
				class="toolbar-link-action"
				data-testid="toolbar-link-apply"
				title={labels.applyLink}
				onclick={() => controller.applyLink()}>{labels.apply}</Button
			>
			<Button
				variant="ghost"
				class="toolbar-link-action"
				data-testid="toolbar-link-remove"
				title={labels.removeLink}
				onclick={() => controller.removeLink()}>{labels.remove}</Button
			>
		</div>
	{:else if controller.panel === 'color'}
		<div class="toolbar-panel" role="menu" aria-label={labels.color}>
			<!-- The text colours (an "A" in the colour), then the backgrounds (a filled square). -->
			{#each ['color', 'highlight'] as const as mark (mark)}
				{@const text = mark === 'color'}
				<div class="toolbar-heading">{text ? labels.textColor : labels.backgroundColor}</div>
				<div class="toolbar-swatches">
					{#each PALETTE as color (color.name)}
						{@const name = labels.colors[color.name] ?? color.name}
						<Button
							variant="ghost"
							role="menuitem"
							class="toolbar-swatch"
							title={text ? labels.colorText(name) : labels.colorBackground(name)}
							onclick={() => controller.setColor(mark, text ? color.text : color.background)}
							style={css({
								color: text ? (color.text ?? 'inherit') : undefined,
								background: text ? undefined : (color.background ?? 'transparent')
							})}>{text ? 'A' : ''}</Button
						>
					{/each}
				</div>
			{/each}
		</div>
	{/if}
</div>

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
		color: var(--popover-foreground);
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
		background: var(--popover);
		box-shadow:
			0 14px 28px -6px rgba(0, 0, 0, 0.1),
			0 2px 4px -1px rgba(0, 0, 0, 0.06),
			0 0 0 1px var(--border);
	}
	.selection-toolbar {
		display: flex;
		align-items: center;
		gap: 1px;
		height: 36px;
		padding: 0 4px;
		white-space: nowrap;
	}
	.selection-toolbar-frame :global(button) {
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
	.selection-toolbar-frame :global(button:hover),
	.selection-toolbar-frame :global(button[aria-expanded='true']) {
		background: var(--accent);
	}
	.selection-toolbar-frame :global(button[aria-pressed='true']) {
		color: var(--primary);
	}
	.selection-toolbar-frame :global(.toolbar-type) {
		padding: 0 6px 0 8px;
		font-weight: 500;
	}
	.toolbar-chevron {
		width: 12px;
		height: 12px;
		background: var(--muted-foreground);
		-webkit-mask: var(--toolbar-chevron) center / 12px no-repeat;
		mask: var(--toolbar-chevron) center / 12px no-repeat;
		--toolbar-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='black' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
	}
	.selection-toolbar-frame :global(.toolbar-link::before),
	.selection-toolbar-frame :global(.toolbar-row::before) {
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
		background: var(--border);
	}
	.selection-toolbar-frame :global(.mark-bold) {
		font-weight: 700;
	}
	.selection-toolbar-frame :global(.mark-italic) {
		font-style: italic;
		font-family: Georgia, serif;
	}
	.selection-toolbar-frame :global(.mark-underline) {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.selection-toolbar-frame :global(.mark-strike) {
		text-decoration: line-through;
	}
	.selection-toolbar-frame :global(.mark-code) {
		font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 12px;
	}
	.selection-toolbar-frame :global(.toolbar-color) {
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
		color: var(--muted-foreground);
		font-size: 12px;
		font-weight: 500;
		line-height: 16px;
	}
	.selection-toolbar-frame :global(.toolbar-row) {
		justify-content: flex-start;
		gap: 8px;
		width: 100%;
		padding: 0 8px;
	}
	.selection-toolbar-frame :global(.toolbar-row[data-current='true']::after) {
		content: '✓';
		margin-left: auto;
		color: var(--popover-foreground);
		font-size: 13px;
	}
	.toolbar-link-panel {
		display: flex;
		align-items: center;
		gap: 4px;
		width: 380px;
	}
	.toolbar-link-panel :global(input) {
		flex: 1;
		height: 28px;
		padding: 0 8px;
		border-radius: 6px;
		background: var(--muted);
		box-shadow: inset 0 0 0 1px var(--border);
		color: inherit;
		font: inherit;
		outline: 0;
	}
	.toolbar-link-panel :global(input:focus) {
		box-shadow:
			inset 0 0 0 1px color-mix(in oklab, var(--ring) 57%, transparent),
			0 0 0 2px color-mix(in oklab, var(--ring) 35%, transparent);
	}
	.selection-toolbar-frame :global(.toolbar-link-action) {
		color: var(--muted-foreground);
		font-size: 13px;
	}
	.toolbar-swatches {
		display: grid;
		grid-template-columns: repeat(5, 28px);
		gap: 4px;
		padding: 2px 6px 6px;
	}
	.selection-toolbar-frame :global(.toolbar-swatch) {
		width: 28px;
		padding: 0;
		box-shadow: inset 0 0 0 1px var(--border);
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
