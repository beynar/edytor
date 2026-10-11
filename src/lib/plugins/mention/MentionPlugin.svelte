<svelte:options runes />

<script module lang="ts">
	import type { Snippet } from 'svelte';
	import type { InlineBlockSnippetPayload, Plugin, TriggerContext } from '$lib/plugins.js';
	import type { TriggerMenuController } from '../triggers/TriggerController.svelte.js';
	import { mentionEnglish, labelsWith, type PartialLabels } from '$lib/labels.js';

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
		/**
		 * The menu's markup; it renders while `controller.isOpen`, at the caret
		 * (without it, nothing shows). Keep its ARIA with `{@attach
		 * controller.popup}` on the list and `{...controller.option(index)}` on
		 * each row.
		 */
		menu?: Snippet<[TriggerMenuController<MentionItem>]>;
		/** The words the menu shows and says, over the English ones. */
		labels?: PartialLabels<'mention'>;
	};

	/**
	 * People mentions, as in Notion: `@` opens a menu of the people your app's
	 * `items(query)` answers; picking one replaces `@query` with a `mention`
	 * atom (`{ id, label }`) and puts the caret after it, in one undo step.
	 */
	export const createMentionPlugin = (options: MentionPluginOptions): Plugin => {
		const labels = labelsWith(mentionEnglish, options.labels);
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
					menu: options.menu,
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
</style>
