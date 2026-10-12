<script lang="ts">
	import {
		Edytor,
		createSlashMenuPlugin,
		type EditorCommand,
		type JSONDoc,
		type Plugin,
		type SlashMenuController
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// The slash menu, drawn with the snippet below.
	const slash = createSlashMenuPlugin({ menu });

	/** The rows by group, in order. */
	function sections(commands: EditorCommand[]) {
		const runs: { name: string; rows: { command: EditorCommand; index: number }[] }[] = [];
		commands.forEach((command, index) => {
			const name = command.group ?? '';
			const run = runs.at(-1);
			if (run && run.name === name) run.rows.push({ command, index });
			else runs.push({ name, rows: [{ command, index }] });
		});
		return runs;
	}
</script>

<!-- A dark palette: a command line on top, groups as small caps, hints as keycaps. -->
{#snippet menu(slash: SlashMenuController)}
	<div class="palette" role="presentation" onmousedown={(event) => event.preventDefault()}>
		{#if slash.addition}
			<input
				aria-label="Filter commands"
				placeholder="Filter commands…"
				value={slash.query}
				oninput={(event) => slash.search(event.currentTarget.value)}
				{@attach slash.keys}
			/>
		{:else}
			<div class="query" aria-live="polite">/{slash.query}</div>
		{/if}
		<div class="list" {@attach slash.popup}>
			{#each sections(slash.commands) as section, at (`${at}:${section.name}`)}
				<div role="group" aria-label={section.name || undefined}>
					{#if section.name}<div class="group" aria-hidden="true">{section.name}</div>{/if}
					{#each section.rows as { command, index } (command.id)}
						<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
						<div
							class="row"
							data-selected={slash.index === index}
							onmousemove={() => (slash.index = index)}
							onclick={() => void slash.run(command)}
							{@attach slash.option(index)}
						>
							<span>{command.label}</span>
							{#if command.hint}<kbd>{command.hint}</kbd>{/if}
						</div>
					{/each}
				</div>
			{/each}
			{#if slash.commands.length === 0}
				<div class="none" role="status">No command</div>
			{/if}
		</div>
	</div>
{/snippet}

<Edytor {value} plugins={[slash, ...plugins]} aria-label="Slash menu demo" />

<style>
	.palette {
		width: 280px;
		padding: 8px;
		border-radius: 12px;
		background: #1f2328;
		color: #e6edf3;
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.25);
		font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.query {
		padding: 2px 8px 8px;
		color: #7ee787;
	}
	input {
		box-sizing: border-box;
		width: 100%;
		margin-bottom: 8px;
		padding: 6px 8px;
		border: 1px solid #3d444d;
		border-radius: 8px;
		background: #151b23;
		color: inherit;
		font: inherit;
		outline: none;
	}
	.list {
		max-height: 260px;
		overflow-y: auto;
	}
	.group {
		padding: 6px 8px 2px;
		color: #9198a1;
		font-size: 10px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 8px;
		border-radius: 6px;
		cursor: pointer;
	}
	.row[data-selected='true'] {
		background: #2f81f7;
		color: #fff;
	}
	kbd {
		padding: 0 5px;
		border-radius: 4px;
		background: rgb(255 255 255 / 0.12);
		font: inherit;
		font-size: 11px;
	}
	.none {
		padding: 4px 8px;
		color: #9198a1;
	}
</style>
