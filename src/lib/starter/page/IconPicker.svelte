<script lang="ts">
	import type { Uploader } from '../../index.js';
	import type { StarterPageData } from '../types.js';
	import { words } from '../chrome/words.svelte.js';
	import { imageUrl, popover, uploadFile } from './popover.js';

	/**
	 * The page icon's picker: a grid of emoji, an image upload or link, and
	 * Remove when there is an icon. Arrow keys move through the grid.
	 */
	let {
		current,
		upload,
		onpick,
		onclose
	}: {
		current: StarterPageData['icon'];
		upload?: Uploader;
		onpick: (icon: StarterPageData['icon']) => void;
		onclose: () => void;
	} = $props();

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
		if (url) onpick({ url });
	};
	const applyLink = (event: SubmitEvent) => {
		event.preventDefault();
		const url = imageUrl(link);
		if (url) onpick({ url });
	};
</script>

<div
	class="starter-popover starter-icon-picker"
	role="dialog"
	aria-label={words.starter.iconMenu}
	data-edytor-starter-icon-picker
	{@attach popover(onclose)}
>
	<div class="starter-emoji" role="group" aria-label={words.starter.emojis} bind:this={grid}>
		{#each EMOJI as emoji, index (emoji)}
			<button
				type="button"
				tabindex={index === 0 ? 0 : -1}
				aria-label={emoji}
				onkeydown={(event) => move(event, index)}
				onclick={() => onpick({ emoji })}>{emoji}</button
			>
		{/each}
	</div>
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
		{#if current}
			<button class="starter-button" type="button" onclick={() => onpick(undefined)}
				>{words.starter.remove}</button
			>
		{/if}
	</div>
</div>

<style>
	.starter-emoji {
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		gap: 2px;
	}
	.starter-emoji button {
		aspect-ratio: 1;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: transparent;
		font-size: 20px;
		line-height: 1;
		cursor: pointer;
	}
	.starter-emoji button:hover,
	.starter-emoji button:focus-visible {
		background: var(--notion-hover);
		outline: 0;
		box-shadow: inset 0 0 0 2px var(--notion-blue);
	}
</style>
