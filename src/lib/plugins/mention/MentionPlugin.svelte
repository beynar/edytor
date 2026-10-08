<script module lang="ts">
	import type { Snippet } from 'svelte';
	import type {
		InlineBlockSnippetPayload,
		Plugin,
		TriggerContext,
		TriggerItemPayload
	} from '$lib/plugins.js';
	import { labelsWith, type PartialLabels } from '$lib/labels.js';

	/** A person the mention menu offers: what your app's directory answers. */
	export type MentionItem = {
		/** The person's id in your app: stored in the atom. */
		id: string;
		/** The name shown in the menu and in the atom. */
		label: string;
		/** A line under the name in the menu (an email, a role). */
		description?: string;
		/** An avatar image URL (http, https or data). */
		avatar?: string;
	};

	/** What a `mention` atom stores. */
	export type MentionData = { id: string; label: string };

	export type MentionPluginOptions = {
		/** The people matching `query` (the text typed after `@`), at once or as a promise. */
		items: (
			query: string,
			ctx: TriggerContext
		) => readonly MentionItem[] | Promise<readonly MentionItem[]>;
		/** The character that opens the menu (default `@`). */
		char?: string;
		/** Replace each row of the menu. */
		item?: Snippet<[TriggerItemPayload<MentionItem>]>;
		/** The words the menu shows and says, over the English ones. */
		labels?: PartialLabels<'mention'>;
	};

	/** An avatar's URL when it is one an `img` may load (http, https, a data image), else nothing. */
	const avatarOf = (src: unknown) =>
		typeof src === 'string' && /^(https?:|data:image\/)/i.test(src.trim()) ? src : undefined;

	/**
	 * People mentions, as in Notion: `@` opens a menu of the people your app's
	 * `items(query)` answers; picking one replaces `@query` with a `mention`
	 * atom (`{ id, label }`) and puts the caret after it, in one undo step.
	 */
	export const createMentionPlugin = (options: MentionPluginOptions): Plugin => {
		const labels = labelsWith('mention', options.labels);
		return () => ({
			inlineBlocks: {
				mention: {
					snippet: mention,
					plain: (data) => {
						const label = (data as Partial<MentionData> | undefined)?.label;
						return typeof label === 'string' && label ? `@${label}` : '@';
					}
				}
			},
			triggers: [
				{
					char: options.char ?? '@',
					name: labels.menu,
					empty: labels.noResults,
					searching: labels.searching,
					items: (query, ctx) => options.items(query, ctx),
					label: (person: MentionItem) => person.label,
					key: (person: MentionItem) => person.id,
					item: options.item ?? row,
					onPick: (person: MentionItem, { block, from, caret }) => {
						const data: MentionData = { id: person.id, label: person.label };
						const after = block.addInlineBlock({ offset: from, block: { type: 'mention', data } });
						if (after) caret(from + 1);
						return !!after;
					}
				}
			]
		});
	};
</script>

{#snippet mention({ block }: InlineBlockSnippetPayload<Partial<MentionData>>)}
	<span
		class="edytor-mention"
		class:selected={block.selected}
		data-edytor-mention
		data-mention-id={block.data.id}>@{block.data.label ?? ''}</span
	>
{/snippet}

{#snippet row({ item, id, selected, pick, select }: TriggerItemPayload<MentionItem>)}
	<button
		type="button"
		class="edytor-mention-row"
		{id}
		role="option"
		tabindex="-1"
		aria-selected={selected}
		data-selected={selected}
		data-testid="trigger-menu-item"
		onmousemove={select}
		onclick={pick}
	>
		<span class="avatar" aria-hidden="true">
			{#if avatarOf(item.avatar)}
				<img src={avatarOf(item.avatar)} alt="" />
			{:else}
				{item.label.trim().charAt(0).toUpperCase()}
			{/if}
		</span>
		<span class="name">{item.label}</span>
		{#if item.description}<span class="description">{item.description}</span>{/if}
	</button>
{/snippet}

<style>
	.edytor-mention {
		color: rgba(55, 53, 47, 0.65);
		font-weight: 500;
		white-space: nowrap;
	}
	.edytor-mention.selected {
		border-radius: 3px;
		background: rgba(35, 131, 226, 0.14);
	}
	.edytor-mention-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 32px;
		padding: 4px 8px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.edytor-mention-row[data-selected='true'] {
		background: rgba(33, 27, 23, 0.06);
	}
	.avatar {
		display: grid;
		flex: none;
		place-items: center;
		width: 20px;
		height: 20px;
		overflow: hidden;
		border-radius: 50%;
		background: rgba(84, 72, 49, 0.12);
		font-size: 11px;
		font-weight: 600;
	}
	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.description {
		margin-left: auto;
		overflow: hidden;
		color: #73726e;
		font-size: 12px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
