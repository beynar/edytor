<script module lang="ts">
	/**
	 * A consumer kind that edits its properties in place: a title field, a
	 * checkbox, a date field, a status select, a tag list and the document's
	 * title, each read from the block's `data` and written with the view's
	 * `patchData` through a function binding.
	 */
	import type { BlockSnippetPayload, BlockView, Plugin } from '$lib/plugins.js';

	type Card = { title?: string; done?: boolean; due?: string; status?: string; tags?: string[] };

	export const propsPlugin: Plugin = () => ({
		blocks: { card: { snippet: card } }
	});

	/** Write key `key` of the block's data: one `patchData`. */
	const set = (block: BlockView<Card>, key: keyof Card, value: unknown) =>
		block.handle?.edytor.patchData(block.id, [{ path: [key], value }]);
</script>

{#snippet card({ block, content }: BlockSnippetPayload<Card>)}
	<div contenteditable="false" data-card-chrome>
		<input
			data-card-title
			bind:value={() => block.data.title ?? '', (title) => set(block, 'title', title)}
		/>
		<!-- An absent key reads as empty: nothing is written on mount. -->
		<input
			type="checkbox"
			data-card-done
			bind:checked={() => block.data.done ?? false, (done) => set(block, 'done', done)}
		/>
		<input
			type="date"
			data-card-due
			bind:value={() => block.data.due ?? '', (due) => set(block, 'due', due)}
		/>
		<select
			data-card-status
			bind:value={() => block.data.status ?? '', (status) => set(block, 'status', status)}
		>
			<option value="">No status</option>
			<option value="todo">To do</option>
			<option value="doing">Doing</option>
			<option value="done">Done</option>
		</select>
		<span data-card-tags>{(block.data.tags ?? []).join(',')}</span>
		<span data-card-doc>{block.handle?.edytor.data.title ?? ''}</span>
	</div>
	<div>{@render content()}</div>
{/snippet}
