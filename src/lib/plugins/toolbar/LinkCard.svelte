<script lang="ts">
	import { iconOf } from '../icons.js';
	import type { ToolbarController } from './ToolbarController.svelte.js';
	let { controller }: { controller: ToolbarController } = $props();
	const labels = $derived(controller.labels);
</script>

<!--
	The link card (`link.card`, Notion): the hovered link's URL with Open,
	Edit and Remove, just below the link. No press on it takes the editor's
	focus (its host cancels each `mousedown`).
-->
{#if controller.card}
	<div
		class="link-card"
		data-testid="link-card"
		data-edytor-link-card
		role="toolbar"
		aria-label={labels.card}
	>
		<span
			class="link-card-url"
			style:--link-card-icon={iconOf('mark.link')}
			title={controller.hoveredHref}>{controller.hoveredHref}</span
		>
		<button
			type="button"
			data-testid="link-card-open"
			title={labels.openLink}
			onclick={() => controller.openHovered()}>{labels.open}</button
		>
		<button
			type="button"
			data-testid="link-card-edit"
			title={labels.editLink}
			onclick={() => controller.editHovered()}>{labels.edit}</button
		>
		<button
			type="button"
			data-testid="link-card-remove"
			title={labels.removeLink}
			onclick={() => controller.removeHovered()}>{labels.remove}</button
		>
	</div>
{/if}

<style>
	/* Its host's top padding bridges the link and the card for the pointer. */
	.link-card {
		display: flex;
		align-items: center;
		gap: 2px;
		box-sizing: border-box;
		max-width: 420px;
		height: 36px;
		padding: 0 4px 0 8px;
		border-radius: 10px;
		background: #fff;
		box-shadow:
			0 14px 28px -6px rgba(0, 0, 0, 0.1),
			0 2px 4px -1px rgba(0, 0, 0, 0.06),
			0 0 0 1px rgba(84, 72, 49, 0.08);
		color: #2c2c2b;
		font-family:
			ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI Variable Display',
			'Segoe UI',
			Helvetica,
			Arial,
			sans-serif;
		font-size: 13px;
		line-height: 20px;
		white-space: nowrap;
		animation: link-card-in 120ms cubic-bezier(0.2, 0, 0, 1);
	}
	@keyframes link-card-in {
		from {
			opacity: 0;
			transform: translateY(-2px);
		}
	}
	.link-card-url {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		margin-right: 4px;
		overflow: hidden;
		color: #7d7a75;
		text-overflow: ellipsis;
	}
	.link-card-url::before {
		content: '';
		flex: none;
		width: 16px;
		height: 16px;
		background: currentColor;
		-webkit-mask: var(--link-card-icon) center / 16px no-repeat;
		mask: var(--link-card-icon) center / 16px no-repeat;
	}
	button {
		flex: none;
		height: 28px;
		padding: 0 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
		transition: background-color 80ms ease;
	}
	button:hover {
		background: rgba(33, 27, 23, 0.06);
	}
</style>
