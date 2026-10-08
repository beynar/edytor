<script lang="ts">
	import { iconOf } from '../icons.js';
	import type { ImageAlign } from './image.js';
	import type { ImageControls } from './controls.svelte.js';

	/**
	 * The image chrome (`ImageControls`), in the overlay: a resize handle on
	 * each side of the hovered image (Notion's pill, at mid-height), and a
	 * toolbar at its top right: the three alignments and the alt text field.
	 * A press on the toolbar keeps the editor's focus; the alt field takes it.
	 */
	let { controls }: { controls: ImageControls } = $props();

	// The view turning readonly mid-drag drops the preview at once.
	$effect(() => {
		if (controls.readonly) controls.lock();
	});
	// The selected image changed: the chrome measures again.
	$effect(() => {
		void controls.selected;
		controls.invalidate();
	});

	const labels = $derived(controls.labels);
	const aligns: { align: ImageAlign; label: string }[] = $derived([
		{ align: 'left', label: labels.alignLeft },
		{ align: 'center', label: labels.alignCenter },
		{ align: 'right', label: labels.alignRight }
	]);
	const keep = (event: MouseEvent) => event.preventDefault();
	/** The handle's hit box: 16px wide, inside the image's edge. */
	const HANDLE = 16;
</script>

<div role="presentation">
	{#if controls.shown && controls.box}
		{@const box = controls.box}
		{#each ['left', 'right'] as const as side (side)}
			<div
				data-edytor-image-resize={side}
				aria-hidden="true"
				style:left="{side === 'left' ? box.x : box.x + box.width - HANDLE}px"
				style:top="{box.y}px"
				style:width="{HANDLE}px"
				style:height="{box.height}px"
				data-dragging={controls.drag ? 'true' : undefined}
				data-selecting={controls.selecting ? 'true' : undefined}
				onpointerdown={(event) => controls.start(event, side)}
				onmousedown={(event) => controls.mousedown(event, side)}
			></div>
		{/each}
		{#if !controls.drag}
			<div
				data-edytor-image-toolbar
				role="toolbar"
				aria-label={labels.toolbar}
				style:left="{box.x + box.width - 6}px"
				style:top="{box.y + 6}px"
				data-selecting={controls.selecting ? 'true' : undefined}
			>
				{#each aligns as { align, label } (align)}
					<button
						type="button"
						data-edytor-image-align={align}
						aria-label={label}
						title={label}
						aria-pressed={box.align === align}
						onmousedown={keep}
						onclick={() => controls.align(align)}
						><span aria-hidden="true" style:mask-image={iconOf(`image.align-${align}`)}
						></span></button
					>
				{/each}
				<button
					type="button"
					data-edytor-image-alt-toggle
					aria-label={labels.alt}
					title={labels.alt}
					aria-expanded={controls.editing === box.id}
					onmousedown={keep}
					onclick={controls.toggleAlt}
					><span aria-hidden="true" style:mask-image={iconOf('image.alt')}></span></button
				>
			</div>
			{#if controls.editing === box.id}
				<div
					data-edytor-image-alt-panel
					style:left="{box.x + box.width - 6}px"
					style:top="{box.y + 40}px"
				>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						data-edytor-image-alt
						aria-label={labels.alt}
						placeholder={labels.altPlaceholder}
						value={controls.alt}
						autofocus
						oninput={(event) => controls.setAlt(event.currentTarget.value)}
						onfocusout={controls.blurred}
						onkeydown={(event) => {
							if (event.key !== 'Enter' && event.key !== 'Escape') return;
							event.preventDefault();
							controls.closeAlt(true);
						}}
					/>
				</div>
			{/if}
		{/if}
	{/if}
</div>

<style>
	[data-edytor-image-resize] {
		position: absolute;
		cursor: col-resize;
		touch-action: none;
	}

	/* A text selection in progress: the chrome takes no pointer. */
	[data-selecting='true'] {
		pointer-events: none;
	}

	/* Notion's handle: a dark pill with a light ring, at mid-height, inside the edge. */
	[data-edytor-image-resize]::after {
		content: '';
		position: absolute;
		top: 50%;
		left: 5px;
		width: 6px;
		height: min(48px, 50%);
		transform: translateY(-50%);
		border-radius: 20px;
		background: var(--edytor-image-handle-color, rgba(15, 15, 15, 0.6));
		box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.9);
		opacity: 0.8;
	}

	[data-edytor-image-resize]:hover::after,
	[data-edytor-image-resize][data-dragging='true']::after {
		opacity: 1;
	}

	[data-edytor-image-toolbar] {
		position: absolute;
		display: flex;
		gap: 2px;
		/* The layer has no width: size to the buttons, not to it. */
		width: max-content;
		padding: 2px;
		transform: translateX(-100%);
		border-radius: 6px;
		background: var(--edytor-image-toolbar-background, #fff);
		box-shadow:
			0 0 0 1px rgba(15, 15, 15, 0.05),
			0 3px 6px rgba(15, 15, 15, 0.1);
		font-size: 13px;
	}

	[data-edytor-image-toolbar] button {
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

	[data-edytor-image-toolbar] button:hover,
	[data-edytor-image-toolbar] button[aria-pressed='true'],
	[data-edytor-image-toolbar] button[aria-expanded='true'] {
		background: rgba(55, 53, 47, 0.08);
		color: rgb(55, 53, 47);
	}

	[data-edytor-image-toolbar] button span {
		width: 18px;
		height: 18px;
		background: currentColor;
		mask-size: contain;
		mask-repeat: no-repeat;
	}

	[data-edytor-image-alt-panel] {
		position: absolute;
		width: 240px;
		padding: 4px;
		transform: translateX(-100%);
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
