<script lang="ts">
	import { float } from './float.js';
	import { Button } from '$registry/ui/button/index.js';
	import { Textarea } from '$registry/ui/textarea/index.js';
	import { words } from './words.svelte.js';
	import type { EquationEditor } from 'edytor';

	/**
	 * Notion's equation editor, drawn for `createEquationPlugin({ panel })`:
	 * the TeX source in a field, KaTeX's error under it, and Done. The
	 * equation itself is the preview: each keystroke writes it.
	 */
	let { editor }: { editor: EquationEditor } = $props();

	const labels = $derived(words.equation);
</script>

<div
	data-edytor-equation-editor
	role="dialog"
	aria-label={labels.editor}
	{@attach float(() => editor.anchor, {
		placement: editor.display ? 'bottom' : 'bottom-start',
		gap: 6
	})}
>
	<div data-edytor-equation-editor-row>
		<Textarea
			aria-label={labels.editor}
			placeholder={labels.placeholder}
			rows={editor.display ? 3 : 1}
			spellcheck="false"
			autocomplete="off"
			autocapitalize="off"
			value={editor.expression}
			oninput={(event) => editor.set(event.currentTarget.value)}
			{@attach editor.field}
		></Textarea>
		<Button
			variant="ghost"
			data-edytor-equation-done
			onmousedown={(event) => event.preventDefault()}
			onclick={() => editor.close()}>{labels.done} <span aria-hidden="true">↵</span></Button
		>
	</div>
	{#if editor.error}
		<div data-edytor-equation-editor-error role="status">{editor.error}</div>
	{/if}
</div>

<style>
	[data-edytor-equation-editor] {
		box-sizing: border-box;
		width: 400px;
		max-width: calc(100vw - 32px);
		padding: 8px;
		border-radius: 8px;
		background: var(--edytor-equation-editor-background, var(--popover));
		box-shadow:
			0 0 0 1px var(--accent),
			0 3px 6px var(--border),
			0 9px 24px var(--border);
		font-size: 14px;
	}

	[data-edytor-equation-editor-row] {
		display: flex;
		gap: 8px;
		align-items: flex-start;
	}

	[data-edytor-equation-editor] :global(textarea) {
		flex: 1;
		box-sizing: border-box;
		min-height: 32px;
		padding: 6px 8px;
		border: 0;
		border-radius: 4px;
		background: var(--muted);
		box-shadow: inset 0 0 0 1px var(--border);
		font:
			13px/1.5 ui-monospace,
			SFMono-Regular,
			Menlo,
			monospace;
		outline: 0;
		resize: vertical;
	}

	[data-edytor-equation-editor] :global([data-edytor-equation-done]) {
		flex: none;
		height: 32px;
		padding: 0 12px;
		border: 0;
		border-radius: 4px;
		background: var(--primary);
		color: var(--primary-foreground);
		font: inherit;
		font-weight: 500;
		cursor: pointer;
	}

	[data-edytor-equation-editor-error] {
		margin-top: 6px;
		color: var(--destructive);
		font-size: 12px;
	}
</style>
