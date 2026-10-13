<script lang="ts">
	import type { StarterCoverPayload } from '../types.js';
	import { words } from '../chrome/words.svelte.js';
	import { imageUrl, popover, uploadFile } from './popover.js';

	/**
	 * The page cover: the image, and where it is editable, Change (upload,
	 * link, remove) and Reposition (drag the image or use the arrow keys,
	 * then Save: one write).
	 */
	let { cover, set, readonly, upload }: StarterCoverPayload = $props();
	const uid = $props.id();
	const hint = `${uid}-hint`;

	let menu = $state(false);
	let link = $state('');
	let busy = $state(false);
	/** The position while repositioning (`null`: not repositioning). */
	let moving = $state<number | null>(null);
	let menuButton = $state<HTMLButtonElement>();
	let frame = $state<HTMLElement>();
	const position = $derived(moving ?? cover?.position ?? 50);
	const clamp = (value: number) => Math.round(Math.min(100, Math.max(0, value)));

	const close = () => {
		menu = false;
		menuButton?.focus();
	};
	const choose = (url: string) => {
		set({ url, position: 50 });
		link = '';
		close();
	};
	const pickFile = async (event: Event) => {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || !upload) return;
		busy = true;
		const url = await uploadFile(upload, file);
		busy = false;
		if (url) choose(url);
	};
	const applyLink = (event: SubmitEvent) => {
		event.preventDefault();
		const url = imageUrl(link);
		if (url) choose(url);
	};
	const save = () => {
		if (moving !== null && cover) set({ url: cover.url, position: moving });
		moving = null;
	};
	const ondrag = (event: PointerEvent) => {
		if (moving === null || !frame || event.button !== 0) return;
		event.preventDefault();
		const start = event.clientY;
		const from = moving;
		const height = frame.getBoundingClientRect().height || 1;
		const view = frame.ownerDocument.defaultView!;
		const onmove = (move: PointerEvent) => {
			// Dragging the image down shows more of its top.
			moving = clamp(from - ((move.clientY - start) / height) * 100);
		};
		const onup = () => {
			view.removeEventListener('pointermove', onmove);
			view.removeEventListener('pointerup', onup);
		};
		view.addEventListener('pointermove', onmove);
		view.addEventListener('pointerup', onup);
	};
	const onkeys = (event: KeyboardEvent) => {
		if (moving === null) return;
		const step = event.shiftKey ? 10 : 2;
		if (event.key === 'ArrowUp') moving = clamp(moving + step);
		else if (event.key === 'ArrowDown') moving = clamp(moving - step);
		else if (event.key === 'Enter') save();
		else if (event.key === 'Escape') moving = null;
		else return;
		event.preventDefault();
	};
</script>

<div
	class="starter-cover"
	data-edytor-starter-cover
	data-repositioning={moving !== null ? '' : undefined}
	bind:this={frame}
>
	{#if cover?.url}
		<img
			src={cover.url}
			alt=""
			draggable="false"
			style:object-position="center {position}%"
			onpointerdown={ondrag}
		/>
	{/if}
	{#if !readonly}
		<div class="starter-cover-actions">
			{#if moving !== null}
				<span class="starter-cover-hint" id={hint}>{words.starter.positionHint}</span>
				<div
					class="starter-cover-slider"
					role="slider"
					tabindex="0"
					aria-label={words.starter.reposition}
					aria-describedby={hint}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={position}
					aria-orientation="vertical"
					onkeydown={onkeys}
					{@attach (node) => node.focus()}
				></div>
				<button type="button" class="starter-button" onclick={save}
					>{words.starter.savePosition}</button
				>
				<button type="button" class="starter-button" onclick={() => (moving = null)}
					>{words.starter.close}</button
				>
			{:else}
				<button
					type="button"
					class="starter-button"
					bind:this={menuButton}
					aria-haspopup="dialog"
					aria-expanded={menu}
					data-edytor-starter-change-cover
					onclick={() => (menu = !menu)}>{words.starter.changeCover}</button
				>
				<button
					type="button"
					class="starter-button"
					data-edytor-starter-reposition
					onclick={() => (moving = cover?.position ?? 50)}>{words.starter.reposition}</button
				>
			{/if}
			{#if menu}
				<div
					class="starter-popover starter-cover-menu"
					role="dialog"
					aria-label={words.starter.coverMenu}
					data-edytor-starter-cover-menu
					{@attach popover(close)}
				>
					<form class="starter-link" onsubmit={applyLink}>
						<input
							class="starter-input"
							type="url"
							placeholder={words.starter.linkPlaceholder}
							aria-label={words.starter.link}
							bind:value={link}
						/>
						<button class="starter-button" type="submit" disabled={!imageUrl(link)}
							>{words.starter.apply}</button
						>
					</form>
					<div class="starter-popover-row">
						{#if upload}
							<label class="starter-button starter-file">
								<input type="file" accept="image/*" onchange={pickFile} disabled={busy} />
								{busy ? words.starter.uploading : words.starter.upload}
							</label>
						{/if}
						<button
							class="starter-button"
							type="button"
							data-edytor-starter-remove-cover
							onclick={() => {
								set(undefined);
								menu = false;
							}}>{words.starter.remove}</button
						>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.starter-cover {
		position: relative;
		height: var(--edytor-starter-cover-height, 30vh);
		min-height: 120px;
		max-height: 280px;
	}
	.starter-cover img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		user-select: none;
	}
	.starter-cover[data-repositioning] img {
		cursor: ns-resize;
		touch-action: none;
	}
	.starter-cover-actions {
		position: absolute;
		right: max(16px, calc((100% - var(--edytor-starter-max-width, 708px)) / 2 - 80px));
		bottom: 10px;
		display: flex;
		gap: 4px;
		align-items: center;
	}
	.starter-cover-actions > :global(.starter-button.starter-button) {
		border: 0;
		background: var(--edytor-starter-background);
		color: var(--notion-text-secondary);
		font-size: 12px;
		box-shadow: 0 0 0 1px var(--notion-border);
	}
	@media (hover: hover) {
		.starter-cover:not(:hover, :focus-within) .starter-cover-actions {
			opacity: 0;
		}
	}
	.starter-cover-hint {
		padding: 4px 8px;
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.5);
		color: #fff;
		font-size: 12px;
	}
	.starter-cover-slider {
		width: 1px;
		height: 1px;
		outline: 0;
	}
	.starter-cover:has(.starter-cover-slider:focus-visible) {
		outline: 2px solid var(--notion-blue);
		outline-offset: -2px;
	}
	.starter-cover-actions .starter-cover-menu {
		top: auto;
		right: 0;
		bottom: calc(100% + 6px);
		left: auto;
	}
	@media (max-width: 720px) {
		.starter-cover-hint {
			display: none;
		}
	}
</style>
