<script lang="ts">
	import type { StarterTitlePayload } from '../types.js';
	import { words } from '../../chrome/words.svelte.js';

	/**
	 * The page title: a large field above the blocks. Enter (and ArrowDown on
	 * its last line) moves into the first block; Mod+Z and Mod+Shift+Z are
	 * the view's undo and redo, so the title's edits are history steps like
	 * the blocks'.
	 */
	let {
		title,
		set,
		enter,
		readonly,
		undo,
		redo
	}: StarterTitlePayload & { undo?: () => void; redo?: () => void } = $props();

	const onkeydown = (event: KeyboardEvent) => {
		const field = event.currentTarget as HTMLTextAreaElement;
		if (event.isComposing) return;
		const mod = event.metaKey || event.ctrlKey;
		if (mod && event.key.toLowerCase() === 'z') {
			event.preventDefault();
			(event.shiftKey ? redo : undo)?.();
			return;
		}
		if (mod && event.key.toLowerCase() === 'y') {
			event.preventDefault();
			redo?.();
			return;
		}
		const atEnd = field.selectionStart === field.value.length;
		if (event.key === 'Enter' || (event.key === 'ArrowDown' && atEnd)) {
			event.preventDefault();
			enter();
		}
	};
	/** The field grows with its lines (where `field-sizing` is unknown). */
	const grow = (node: HTMLTextAreaElement) => {
		void title;
		const fit = () => {
			node.style.height = 'auto';
			node.style.height = `${node.scrollHeight}px`;
		};
		fit();
		const view = node.ownerDocument.defaultView;
		view?.addEventListener('resize', fit);
		return () => view?.removeEventListener('resize', fit);
	};
	const oninput = (event: Event) => {
		const field = event.currentTarget as HTMLTextAreaElement;
		// One line: a pasted newline is a space.
		const next = field.value.replace(/\s*\n+\s*/g, ' ');
		if (next !== field.value) field.value = next;
		set(next);
		field.style.height = 'auto';
		field.style.height = `${field.scrollHeight}px`;
	};
</script>

<h1 class="starter-title" data-edytor-starter-title>
	{#if readonly}
		<span class:starter-title-empty={!title}>{title || words.starter.untitled}</span>
	{:else}
		<textarea
			rows="1"
			value={title}
			placeholder={words.starter.untitled}
			aria-label={words.starter.title}
			spellcheck="true"
			{onkeydown}
			{oninput}
			{@attach grow}
		></textarea>
	{/if}
</h1>

<style>
	.starter-title {
		margin: 0 0 4px;
		padding: 3px 2px;
		color: var(--notion-text);
		font-family: var(--edytor-starter-title-font, var(--notion-font));
		font-size: var(--edytor-starter-title-size, 40px);
		font-weight: 700;
		line-height: 1.2;
	}
	.starter-title textarea {
		display: block;
		box-sizing: border-box;
		width: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		outline: 0;
		resize: none;
		overflow: hidden;
		background: transparent;
		color: inherit;
		font: inherit;
		field-sizing: content;
	}
	.starter-title textarea::placeholder,
	.starter-title-empty {
		color: var(--notion-placeholder);
	}
	@media (max-width: 720px) {
		.starter-title {
			font-size: var(--edytor-starter-title-size, 32px);
		}
	}
</style>
