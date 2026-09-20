<script lang="ts">
	import type { ToolbarController, ToolbarMark } from './ToolbarController.svelte.js';

	let { controller }: { controller: ToolbarController } = $props();

	const marks: Array<{ mark: ToolbarMark; label: string; testId: string }> = [
		{ mark: 'bold', label: 'Bold', testId: 'toolbar-bold' },
		{ mark: 'italic', label: 'Italic', testId: 'toolbar-italic' },
		{ mark: 'underline', label: 'Underline', testId: 'toolbar-underline' },
		{ mark: 'strike', label: 'Strike', testId: 'toolbar-strike' },
		{ mark: 'code', label: 'Code', testId: 'toolbar-code' }
	];
</script>

{#if controller.isVisible}
	<div
		class="flex flex-wrap items-center gap-1 rounded border border-neutral-700 bg-neutral-950 p-1 text-sm text-neutral-50 shadow-lg"
		data-testid="selection-toolbar"
		role="toolbar"
		aria-label="Text formatting"
	>
		{#each marks as item (item.mark)}
			<button
				type="button"
				class="rounded px-2 py-1 hover:bg-neutral-800"
				data-testid={item.testId}
				onmousedown={(event) => event.preventDefault()}
				onclick={() => controller.toggleMark(item.mark)}
			>
				{item.label}
			</button>
		{/each}

		<label class="sr-only" for="edytor-toolbar-link">Link URL</label>
		<input
			id="edytor-toolbar-link"
			class="min-w-48 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-50"
			data-testid="toolbar-link-input"
			placeholder="https://example.com"
			value={controller.linkUrl}
			oninput={(event) => {
				controller.setLinkUrl(event.currentTarget.value);
			}}
		/>
		<button
			type="button"
			class="rounded px-2 py-1 hover:bg-neutral-800"
			data-testid="toolbar-link-apply"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => controller.applyLink()}
		>
			Apply link
		</button>
		<button
			type="button"
			class="rounded px-2 py-1 hover:bg-neutral-800"
			data-testid="toolbar-link-remove"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => controller.removeLink()}
		>
			Remove link
		</button>
	</div>
{/if}
