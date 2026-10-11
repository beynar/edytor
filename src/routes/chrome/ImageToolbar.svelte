<script lang="ts">
	import { words } from './words.svelte.js';
	import { alignIcons, altIcon } from './icons.js';
	import type { ImageControls } from '$lib/index.js';

	/**
	 * Notion's image toolbar, drawn for `createImagePlugin({ toolbar })`: the
	 * three alignments and the alt text's button, and the alt text field
	 * under them. A press on the toolbar keeps the editor's focus; the alt
	 * field takes it.
	 */
	let { controls }: { controls: ImageControls } = $props();
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
	<div data-image-toolbar aria-label={labels.toolbar} {@attach controls.bar}>
		{#each buttons as { align, label, icon } (icon)}
			<button
				type="button"
				data-edytor-image-align={align}
				data-edytor-image-alt-toggle={align ? undefined : ''}
				aria-label={label}
				title={label}
				aria-pressed={align ? box.align === align : undefined}
				aria-expanded={align ? undefined : controls.editing === box.id}
				onmousedown={keep}
				onclick={() => (align ? controls.align(align) : controls.toggleAlt())}
				><span aria-hidden="true" style:mask-image={icon}></span></button
			>
		{/each}
	</div>
	{#if controls.editing === box.id}
		<div data-edytor-image-alt-panel>
			<input
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
		background: var(--edytor-image-toolbar-background, #fff);
		box-shadow:
			0 0 0 1px rgba(15, 15, 15, 0.05),
			0 3px 6px rgba(15, 15, 15, 0.1);
		font-size: 13px;
	}

	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: rgba(55, 53, 47, 0.65);
		cursor: pointer;
	}

	button:hover,
	button[aria-pressed='true'],
	button[aria-expanded='true'] {
		background: rgba(55, 53, 47, 0.08);
		color: rgb(55, 53, 47);
	}

	button span {
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
		background: var(--edytor-image-toolbar-background, #fff);
		box-shadow:
			0 0 0 1px rgba(15, 15, 15, 0.05),
			0 3px 6px rgba(15, 15, 15, 0.1);
	}

	[data-edytor-image-alt] {
		box-sizing: border-box;
		width: 100%;
		height: 28px;
		padding: 0 8px;
		border: 0;
		border-radius: 4px;
		background: rgba(242, 241, 238, 0.6);
		box-shadow: inset 0 0 0 1px rgba(15, 15, 15, 0.1);
		font: inherit;
		outline: 0;
	}
</style>
