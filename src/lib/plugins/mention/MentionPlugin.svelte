<svelte:options runes />

<script module lang="ts">
	import type { Snippet } from 'svelte';
	import type { InlineBlockSnippetPayload, Plugin, TriggerContext } from '$lib/plugins.js';
	import type { TriggerMenuController } from '../triggers/TriggerController.svelte.js';
	import { withRulesAndTriggers } from '../triggers/triggers.js';

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
		 * The menu's markup and its words; it renders while `controller.isOpen`,
		 * at the caret (without it, nothing shows). Keep its ARIA with `{@attach
		 * controller.popup}` on the list (name it) and
		 * `{...controller.option(index)}` on each row.
		 */
		menu?: Snippet<[TriggerMenuController<MentionItem>]>;
	};

	/**
	 * People mentions, as in Notion: `@` opens a menu of the people your app's
	 * `items(query)` answers; picking one replaces `@query` with a `mention`
	 * atom (`{ id, label }`) and puts the caret after it, in one undo step.
	 */
	export const createMentionPlugin =
		(options: MentionPluginOptions): Plugin =>
		(edytor) =>
			withRulesAndTriggers(
				edytor,
				{
					inlineBlocks: {
						mention: {
							snippet: mention,
							plain: (data) => {
								const label = (data as Partial<MentionData> | undefined)?.label;
								return typeof label === 'string' && label ? `@${label}` : '@';
							}
						}
					}
				},
				{
					triggers: [
						{
							char: options.char ?? '@',
							items: (query, ctx) => options.items(query, ctx),
							label: (person: MentionItem) => person.label,
							key: (person: MentionItem) => person.id,
							menu: options.menu,
							onPick: (person: MentionItem, { edytor, block, from, caret }) => {
								const data: MentionData = { id: person.id, label: person.label };
								const written =
									edytor.insertInline(block.id, from, { type: 'mention', data }).status ===
									'applied';
								if (written) caret(from + 1);
								return written;
							}
						}
					]
				}
			);
</script>

{#snippet mention({ block }: InlineBlockSnippetPayload<Partial<MentionData>>)}
	<span
		class="edytor-mention"
		data-selected={block.selected ? 'true' : undefined}
		data-edytor-mention
		data-mention-id={block.data.id}>@{block.data.label ?? ''}</span
	>
{/snippet}

<style>
	/* One unit, on one line; its look is a theme's. */
	.edytor-mention {
		white-space: nowrap;
	}
</style>
