<script lang="ts">
	import type { StarterCoverPayload } from '../types.js';
	import { words } from '../../chrome/words.svelte.js';
	import { Button, buttonVariants } from '$registry/ui/button/index.js';
	import { Input } from '$registry/ui/input/index.js';
	import * as Popover from '$registry/ui/popover/index.js';
	import { cn } from '$registry/utils.js';
	import { imageUrl, uploadFile } from './popover.js';

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
	let frame = $state<HTMLElement>();
	const position = $derived(moving ?? cover?.position ?? 50);
	const clamp = (value: number) => Math.round(Math.min(100, Math.max(0, value)));

	const choose = (url: string) => {
		set({ url, position: 50 });
		link = '';
		menu = false;
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
				<Button size="xs" variant="outline" onclick={save}>{words.starter.savePosition}</Button>
				<Button size="xs" variant="outline" onclick={() => (moving = null)}
					>{words.starter.close}</Button
				>
			{:else}
				<Popover.Root bind:open={menu}>
					<Popover.Trigger>
						{#snippet child({ props })}
							<Button {...props} size="xs" variant="outline" data-edytor-starter-change-cover
								>{words.starter.changeCover}</Button
							>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content
						class="w-80 gap-3 p-2"
						align="end"
						side="top"
						portalProps={{ disabled: true }}
						role="dialog"
						aria-label={words.starter.coverMenu}
						data-edytor-starter-cover-menu
						onCloseAutoFocus={(event) => {
							// Back on Change cover, even where a press gave it no focus (WebKit).
							event.preventDefault();
							frame?.querySelector<HTMLElement>('[data-edytor-starter-change-cover]')?.focus();
						}}
					>
						<form class="flex gap-1.5" onsubmit={applyLink}>
							<Input
								class="h-8"
								type="url"
								placeholder={words.starter.linkPlaceholder}
								aria-label={words.starter.link}
								bind:value={link}
							/>
							<Button size="sm" variant="outline" type="submit" disabled={!imageUrl(link)}
								>{words.starter.apply}</Button
							>
						</form>
						<div class="flex flex-wrap gap-1.5">
							{#if upload}
								<label class={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'relative')}>
									<input
										class="absolute size-px opacity-0"
										type="file"
										accept="image/*"
										onchange={pickFile}
										disabled={busy}
									/>
									{busy ? words.starter.uploading : words.starter.upload}
								</label>
							{/if}
							<Button
								size="sm"
								variant="outline"
								data-edytor-starter-remove-cover
								onclick={() => {
									set(undefined);
									menu = false;
								}}>{words.starter.remove}</Button
							>
						</div>
					</Popover.Content>
				</Popover.Root>
				<Button
					size="xs"
					variant="outline"
					data-edytor-starter-reposition
					onclick={() => (moving = cover?.position ?? 50)}>{words.starter.reposition}</Button
				>
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
	@media (hover: hover) {
		.starter-cover:not(:hover, :focus-within) .starter-cover-actions {
			opacity: 0;
		}
	}
	.starter-cover-hint {
		padding: 4px 8px;
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.5);
		color: var(--primary-foreground);
		font-size: 12px;
	}
	.starter-cover-slider {
		width: 1px;
		height: 1px;
		outline: 0;
	}
	.starter-cover:has(.starter-cover-slider:focus-visible) {
		outline: 2px solid var(--ring);
		outline-offset: -2px;
	}
	@media (max-width: 720px) {
		.starter-cover-hint {
			display: none;
		}
	}
</style>
