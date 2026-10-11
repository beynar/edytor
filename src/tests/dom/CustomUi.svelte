<script lang="ts">
	import Edytor, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import { createSlashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
	import { createToolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
	import { createBlockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
	import { createBlockHandlesPlugin } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
	import type { JSONDoc } from '$lib/utils/json.js';

	/** Every UI plugin with its own markup, through snippets; default plugins on. */
	let { edytor = $bindable(), value }: { edytor?: EdytorContext; value: JSONDoc } = $props();
	const plugins = [
		createBlockHandlesPlugin({ handle }),
		createSlashMenuPlugin({ menu: slashMenu }),
		createToolbarPlugin({ toolbar: bar }),
		createBlockMenuPlugin({ menu: blockMenu })
	];
</script>

{#snippet slashMenu(controller: import('$lib/plugins/index.js').SlashMenuController)}
	<!-- A `+`'s menu holds the keyboard on its own element (typing edits the query). -->
	<div tabindex="-1" role="presentation" {@attach controller.addition ? controller.keys : null}>
		<div {@attach controller.popup}>
			{#each controller.commands as command, index (command.id)}
				<button
					data-testid="custom-slash"
					{...controller.option(index)}
					onclick={() => void controller.run(command)}>{command.label}</button
				>
			{/each}
		</div>
	</div>
{/snippet}

{#snippet bar(controller: import('$lib/plugins/index.js').ToolbarController)}
	<div data-testid="custom-toolbar">
		<button onmousedown={(e) => e.preventDefault()} onclick={() => controller.toggleMark('bold')}
			>Bold</button
		>
	</div>
{/snippet}

{#snippet handle({ block, grip, add }: import('$lib/plugins/index.js').BlockHandleSnippetPayload)}
	<button data-testid="custom-add" data-id={block.id} onclick={() => add()}>+</button>
	<button data-testid="custom-grip" data-id={block.id} use:grip>⠿</button>
{/snippet}

{#snippet blockMenu(controller: import('$lib/plugins/index.js').BlockMenuController)}
	<div data-testid="custom-block-menu">
		{controller.block?.type}
		<button onclick={() => controller.remove()}>Delete</button>
	</div>
{/snippet}

<Edytor bind:edytor {plugins} {value} />
