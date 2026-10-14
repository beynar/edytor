<script lang="ts">
	import { float } from './float.js';
	import { words } from './words.svelte.js';
	import { iconOf } from './icons.js';
	import { keepFocus } from './keepFocus.js';
	import { row } from './ui.js';
	import { Button } from '$registry/ui/button/index.js';
	import { Input } from '$registry/ui/input/index.js';
	import { Kbd } from '$registry/ui/kbd/index.js';
	import { Separator } from '$registry/ui/separator/index.js';
	import { cn } from '$registry/utils.js';
	import type { EditorCommand, SlashMenuController } from 'edytor';

	/** The slash menu and the `+`'s menu (Notion's), drawn for `createSlashMenuPlugin({ menu })`. */
	let { controller }: { controller: SlashMenuController } = $props();
	const commands = $derived(controller.commands);
	const labels = $derived(words.slashMenu);

	/** The rows by group, in order (Notion's headings): a `group` per run of one group's rows. */
	const groups = $derived.by(() => {
		const runs: { name: string; rows: { command: EditorCommand; index: number }[] }[] = [];
		commands.forEach((command, index) => {
			const name = command.group ?? '';
			const run = runs.at(-1);
			if (run && run.name === name) run.rows.push({ command, index });
			else runs.push({ name, rows: [{ command, index }] });
		});
		return runs;
	});
</script>

<!--
	The keys of a `+`'s menu (`keys`), the listbox's id, role and publication
	to the view's root (`popup`) and a row's ARIA (`option(index)`) are
	the controller's attachments. A press in the menu keeps the focus where it is (its
	field, or the editor's caret).
-->
<div
	class="slash-menu bg-popover text-popover-foreground ring-foreground/10 rounded-lg shadow-md ring-1"
	data-testid="slash-menu"
	tabindex="-1"
	role="presentation"
	onmousedown={keepFocus}
	{@attach float(() => controller.anchor)}
>
	{#if controller.addition}
		<Input
			class="slash-search mx-2 mt-2 h-8 w-auto"
			placeholder={labels.filter}
			aria-label={labels.filterLabel}
			role="combobox"
			aria-expanded="true"
			aria-autocomplete="list"
			aria-controls={controller.listId}
			value={controller.query}
			{@attach controller.keys}
			oninput={(event) => controller.search(event.currentTarget.value)}
		/>
	{:else}
		<div class="slash-query sr-only" data-testid="slash-menu-query" aria-live="polite">
			/{controller.query}
		</div>
	{/if}
	<div class="slash-items" role="listbox" aria-label={labels.list} {@attach controller.popup}>
		{#if commands.length === 0}
			<div class="slash-empty text-muted-foreground px-2 py-1.5" data-testid="slash-menu-empty">
				{labels.noResults}
			</div>
		{/if}
		{#each groups as group, at (`${at}:${group.name}`)}
			<div
				role="group"
				aria-label={group.name ? (labels.groups[group.name] ?? group.name) : undefined}
			>
				{#if group.name}<div
						class="slash-heading text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium"
						aria-hidden="true"
					>
						{labels.groups[group.name] ?? group.name}
					</div>{/if}
				{#each group.rows as { command, index } (command.id)}
					<Button
						variant="ghost"
						class={cn(row, 'slash-item')}
						data-selected={controller.index === index}
						{@attach controller.option(index)}
						data-command-id={command.id}
						data-icon={command.icon ?? '⋮'}
						data-glyph={iconOf(command.id) ? undefined : (command.icon ?? '⋮')}
						data-hint={command.hint}
						style={iconOf(command.id) ? `--slash-icon: ${iconOf(command.id)}` : undefined}
						data-testid="slash-menu-item"
						onmousemove={() => (controller.index = index)}
						onclick={() => {
							void controller.run(command);
						}}>{command.label}</Button
					>
				{/each}
			</div>
		{/each}
	</div>
	<Separator />
	<Button
		variant="ghost"
		class="slash-footer text-muted-foreground h-9 w-full justify-between rounded-none px-3 font-normal"
		tabindex={-1}
		onclick={() => controller.dismiss()}
		><span>{labels.close}</span><Kbd class="text-foreground/70 bg-transparent"
			>{labels.closeKey}</Kbd
		></Button
	>
</div>

<style>
	.slash-menu {
		width: 324px;
		max-height: min(40vh, 380px);
		min-height: 120px;
		display: flex;
		flex-direction: column;
		font-size: 14px;
		line-height: 20px;
		overflow: hidden;
		transform-origin: top left;
		animation: slash-in 140ms cubic-bezier(0.2, 0, 0, 1);
	}
	@keyframes slash-in {
		from {
			opacity: 0;
			transform: translateY(-4px) scale(0.98);
		}
	}
	.slash-items {
		flex: 1;
		overflow-y: auto;
		padding: 4px;
	}
	.slash-items :global(.slash-item::before) {
		content: attr(data-glyph);
		display: grid;
		flex: none;
		place-items: center;
		width: 20px;
		height: 20px;
		font-size: 13px;
		font-weight: 600;
		line-height: 1;
	}
	.slash-items :global(.slash-item[style*='--slash-icon']::before) {
		content: '';
		background: currentColor;
		-webkit-mask: var(--slash-icon) center / 20px no-repeat;
		mask: var(--slash-icon) center / 20px no-repeat;
	}
	.slash-items :global(.slash-item[data-hint]::after) {
		content: attr(data-hint);
		margin-left: auto;
		color: var(--muted-foreground);
		font-size: 12px;
	}
</style>
