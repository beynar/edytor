<script module lang="ts">
	/**
	 * A consumer kind that edits its properties in place (0.1.0-next.6): a
	 * bound title field, a bound checkbox, a bound date field, a bound status
	 * select, a tag list and the document's title, all read through the `data`
	 * proxies.
	 */
	import type { BlockSnippetPayload, Plugin } from '$lib/plugins.js';

	type Card = { title?: string; done?: boolean; due?: string; status?: string; tags?: string[] };
	type Tasks = { tasks: { title: string; done: boolean }[] };

	export const propsPlugin: Plugin = () => ({
		blocks: { card: { snippet: card }, tasks: { snippet: list } }
	});
</script>

{#snippet card({ block, content }: BlockSnippetPayload<Card>)}
	<div contenteditable="false" data-card-chrome>
		<input data-card-title bind:value={block.data.title} />
		<!-- A function binding: `bind:checked` alone writes `false` over an absent key on mount. -->
		<input
			type="checkbox"
			data-card-done
			bind:checked={() => block.data.done ?? false, (done) => (block.data.done = done)}
		/>
		<!-- Function bindings for the same reason: an absent key reads as empty, nothing is written on mount. -->
		<input
			type="date"
			data-card-due
			bind:value={() => block.data.due ?? '', (due) => (block.data.due = due)}
		/>
		<select
			data-card-status
			bind:value={() => block.data.status ?? '', (status) => (block.data.status = status)}
		>
			<option value="">No status</option>
			<option value="todo">To do</option>
			<option value="doing">Doing</option>
			<option value="done">Done</option>
		</select>
		<span data-card-tags>{(block.data.tags ?? []).join(',')}</span>
		<span data-card-doc>{block.handle.edytor.data.title ?? ''}</span>
	</div>
	<div>{@render content()}</div>
{/snippet}

<!-- A list of synced items (0.1.0-next.7): each row binds into its own item, keyed by it. -->
{#snippet list({ block, content }: BlockSnippetPayload<Tasks>)}
	<ul contenteditable="false" data-tasks>
		{#each block.data.tasks as task, i (task)}
			<li>
				<input type="checkbox" data-task-done={i} bind:checked={task.done} />
				<input data-task-title={i} bind:value={task.title} />
			</li>
		{/each}
	</ul>
	<div>{@render content()}</div>
{/snippet}
