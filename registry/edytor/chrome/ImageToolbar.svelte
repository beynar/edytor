<script lang="ts">
	import { float } from './float.js';
	import { Button } from '$registry/ui/button/index.js';
	import { Input } from '$registry/ui/input/index.js';
	import { words } from './words.svelte.js';
	import { alignIcons, altIcon } from './icons.js';
	import type { ImageToolbar } from 'edytor';

	/**
	 * Notion's image toolbar, drawn for `createImageToolbarPlugin({ toolbar })`: the
	 * three alignments and the alt text's button, and the alt text field
	 * under them. A press on the toolbar keeps the editor's focus; the alt
	 * field takes it.
	 */
	let { controls }: { controls: ImageToolbar } = $props();
	const labels = $derived(words.image);
	/** The toolbar's buttons: the three alignments, then the alt text's (no `align`). */
	const buttons = $derived([
		{ align: 'left', label: labels.alignLeft, icon: alignIcons.left },
		{ align: 'center', label: labels.alignCenter, icon: alignIcons.center },
		{ align: 'right', label: labels.alignRight, icon: alignIcons.right },
		{ align: undefined, label: labels.alt, icon: altIcon }
	] as const);
	const keep = (event: MouseEvent) => event.preventDefault();
</script>

{#if controls.box}
	{@const box = controls.box}
	<!-- Its role is the controller's `bar`. -->
	<div
		data-image-toolbar
		aria-label={labels.toolbar}
		{@attach controls.bar}
		{@attach float(() => controls.anchor, {
			placement: 'top-end',
			gap: ({ rects }) => ({ mainAxis: -rects.floating.height - 6, crossAxis: 6 })
		})}
	>
		{#each buttons as { align, label, icon } (icon)}
			<Button
				variant="ghost"
				data-edytor-image-align={align}
				data-edytor-image-alt-toggle={align ? undefined : ''}
				aria-label={label}
				title={label}
				aria-pressed={align ? box.align === align : undefined}
				aria-expanded={align ? undefined : controls.editing === box.id}
				onmousedown={keep}
				onclick={() => (align ? controls.align(align) : controls.toggleAlt())}
				><span aria-hidden="true" style:mask-image={icon}></span></Button
			>
		{/each}
	</div>
	{#if controls.editing === box.id}
		<div data-edytor-image-alt-panel>
			<Input
				data-edytor-image-alt
				aria-label={labels.alt}
				placeholder={labels.altPlaceholder}
				value={controls.alt}
				oninput={(event) => controls.setAlt(event.currentTarget.value)}
				{@attach controls.altField}
			/>
		</div>
	{/if}
{/if}

<style>
	[data-image-toolbar] {
		display: flex;
		gap: 2px;
		/* The layer has no width: size to the buttons, not to it. */
		width: max-content;
		margin-left: auto;
		padding: 2px;
		border-radius: 6px;
		background: var(--edytor-image-toolbar-background, var(--popover));
		box-shadow:
			0 0 0 1px var(--accent),
			0 3px 6px var(--border);
		font-size: 13px;
	}

	[data-image-toolbar] :global(button) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
	}

	[data-image-toolbar] :global(button:hover),
	[data-image-toolbar] :global(button[aria-pressed='true']),
	[data-image-toolbar] :global(button[aria-expanded='true']) {
		background: var(--accent);
		color: var(--popover-foreground);
	}

	[data-image-toolbar] :global(button span) {
		width: 18px;
		height: 18px;
		background: currentColor;
		mask-size: contain;
		mask-repeat: no-repeat;
	}

	[data-edytor-image-alt-panel] {
		position: absolute;
		top: 34px;
		right: 0;
		width: 240px;
		padding: 4px;
		border-radius: 6px;
		background: var(--edytor-image-toolbar-background, var(--popover));
		box-shadow:
			0 0 0 1px var(--accent),
			0 3px 6px var(--border);
	}

	[data-image-toolbar] :global([data-edytor-image-alt]) {
		box-sizing: border-box;
		width: 100%;
		height: 28px;
		padding: 0 8px;
		border: 0;
		border-radius: 4px;
		background: var(--muted);
		box-shadow: inset 0 0 0 1px var(--border);
		font: inherit;
		outline: 0;
	}
</style>
