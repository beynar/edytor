<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Uploader } from 'edytor';
	import { Button, buttonVariants } from '$registry/ui/button/index.js';
	import { cn } from '$registry/utils.js';
	import { Input } from '$registry/ui/input/index.js';
	import * as Popover from '$registry/ui/popover/index.js';
	import type { StarterPageData } from '../types.js';
	import { words } from '../../chrome/words.svelte.js';
	import { imageUrl, uploadFile } from './popover.js';

	/**
	 * The page icon's picker: a grid of emoji, an image upload or link, and
	 * Remove when there is an icon, in a shadcn Popover opened by `trigger`
	 * (its props spread on your button). Arrow keys move through the grid.
	 */
	let {
		current,
		upload,
		onpick,
		open = $bindable(false),
		trigger
	}: {
		current: StarterPageData['icon'];
		upload?: Uploader;
		onpick: (icon: StarterPageData['icon']) => void;
		open?: boolean;
		trigger: Snippet<[Record<string, unknown>]>;
	} = $props();
	const pick = (icon: StarterPageData['icon']) => {
		open = false;
		onpick(icon);
	};

	const EMOJI = [
		'📄',
		'📝',
		'📌',
		'📎',
		'📚',
		'📅',
		'📊',
		'🗂️',
		'💡',
		'🚀',
		'🎯',
		'✅',
		'⭐',
		'🔥',
		'🌱',
		'🌍',
		'🎨',
		'🧪',
		'🛠️',
		'⚙️',
		'💬',
		'📣',
		'🔒',
		'🏠',
		'❤️',
		'🙂',
		'😎',
		'🤖',
		'🐙',
		'🍀',
		'☕',
		'🎵'
	];
	const COLUMNS = 8;
	let link = $state('');
	let busy = $state(false);
	let grid = $state<HTMLElement>();

	const move = (event: KeyboardEvent, index: number) => {
		const step =
			event.key === 'ArrowRight'
				? 1
				: event.key === 'ArrowLeft'
					? -1
					: event.key === 'ArrowDown'
						? COLUMNS
						: event.key === 'ArrowUp'
							? -COLUMNS
							: 0;
		if (!step) return;
		event.preventDefault();
		const next = Math.min(EMOJI.length - 1, Math.max(0, index + step));
		grid?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
	};
	const pickFile = async (event: Event) => {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || !upload) return;
		busy = true;
		const url = await uploadFile(upload, file);
		busy = false;
		if (url) pick({ url });
	};
	const applyLink = (event: SubmitEvent) => {
		event.preventDefault();
		const url = imageUrl(link);
		if (url) pick({ url });
	};
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			{@render trigger(props)}
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		class="starter-icon-picker w-80 gap-3 p-2"
		align="start"
		portalProps={{ disabled: true }}
		role="dialog"
		aria-label={words.starter.iconMenu}
		data-edytor-starter-icon-picker
	>
		<div class="starter-emoji" role="group" aria-label={words.starter.emojis} bind:this={grid}>
			{#each EMOJI as emoji, index (emoji)}
				<button
					type="button"
					class="hover:bg-accent focus-visible:bg-accent focus-visible:ring-ring rounded-md outline-none focus-visible:ring-2"
					tabindex={index === 0 ? 0 : -1}
					aria-label={emoji}
					onkeydown={(event) => move(event, index)}
					onclick={() => pick({ emoji })}>{emoji}</button
				>
			{/each}
		</div>
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
		{#if upload || current}
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
				{#if current}
					<Button size="sm" variant="outline" onclick={() => pick(undefined)}
						>{words.starter.remove}</Button
					>
				{/if}
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>

<style>
	.starter-emoji {
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		gap: 2px;
	}
	.starter-emoji button {
		aspect-ratio: 1;
		font-size: 20px;
		line-height: 1;
		cursor: pointer;
	}
</style>
