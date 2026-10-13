<script lang="ts">
	import type { StarterIconPayload } from '../types.js';
	import { words } from '../chrome/words.svelte.js';
	import IconPicker from './IconPicker.svelte';

	/** The page icon: an emoji or an image; a button opening its picker where it is editable. */
	let { icon, set, readonly, upload }: StarterIconPayload = $props();
	let open = $state(false);
	let button = $state<HTMLButtonElement>();
</script>

{#snippet face()}
	{#if icon && 'emoji' in icon}
		<span class="starter-icon-emoji">{icon.emoji}</span>
	{:else if icon && 'url' in icon}
		<img class="starter-icon-image" src={icon.url} alt="" />
	{/if}
{/snippet}

<div class="starter-icon" data-edytor-starter-icon>
	{#if readonly}
		<span role="img" aria-label={words.starter.icon}>{@render face()}</span>
	{:else}
		<button
			type="button"
			bind:this={button}
			aria-label={words.starter.iconMenu}
			aria-haspopup="dialog"
			aria-expanded={open}
			onclick={() => (open = !open)}>{@render face()}</button
		>
		{#if open}
			<IconPicker
				current={icon}
				{upload}
				onpick={(next) => {
					set(next);
					open = false;
					button?.focus();
				}}
				onclose={() => {
					open = false;
					button?.focus();
				}}
			/>
		{/if}
	{/if}
</div>

<style>
	.starter-icon {
		position: relative;
		width: fit-content;
		margin: 0 0 4px -4px;
	}
	.starter-icon > button,
	.starter-icon > span {
		display: flex;
		align-items: center;
		justify-content: center;
		width: var(--edytor-starter-icon-size, 78px);
		height: var(--edytor-starter-icon-size, 78px);
		padding: 0;
		border: 0;
		border-radius: var(--edytor-starter-radius, 6px);
		background: transparent;
		cursor: pointer;
	}
	.starter-icon > span {
		cursor: default;
	}
	.starter-icon > button:hover {
		background: var(--notion-hover);
	}
	.starter-icon > button:focus-visible {
		outline: 2px solid var(--notion-blue);
	}
	.starter-icon-emoji {
		font-size: calc(var(--edytor-starter-icon-size, 78px) * 0.9);
		line-height: 1;
	}
	.starter-icon-image {
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: var(--edytor-starter-radius, 6px);
	}
	:global([data-has-cover]) .starter-icon {
		margin-top: calc(var(--edytor-starter-icon-size, 78px) * -0.6);
	}
	@media (max-width: 720px) {
		.starter-icon {
			--edytor-starter-icon-size: 64px;
		}
	}
</style>
