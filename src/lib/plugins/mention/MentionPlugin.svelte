<svelte:options runes />

<script module lang="ts">
	import { mentionForms } from '$lib/export/forms.js';
	import './mention.css';
	import type { Snippet } from 'svelte';
	import type {
		InlineBlockDefinition,
		InlineBlockSnippetPayload,
		InlineBlockView,
		Plugin,
		TriggerContext
	} from '$lib/plugins.js';
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

	/** What a mention atom stores (whatever its kind). */
	export type MentionData = { id: string; label: string };

	export type MentionPluginOptions = {
		/** The people matching `query` (the text typed after `@`), at once or as a promise. */
		items: (
			query: string,
			ctx: TriggerContext
		) => readonly MentionItem[] | Promise<readonly MentionItem[]>;
		/** The character that opens the menu, and that the atom shows before its label (default `@`). */
		char?: string;
		/**
		 * The inline kind the atoms are (default `mention`), and the name of the
		 * trigger menu (`controller.trigger.name`). List the plugin once per kind
		 * to mention several things (`@` people, `$` tickers as `ticker`); two
		 * instances of one kind: the first listed defines it.
		 */
		kind?: string;
		/**
		 * The menu's markup and its words; it renders while `controller.isOpen`,
		 * at the caret (without it, nothing shows). Keep its ARIA with `{@attach
		 * controller.popup}` on the list (name it) and
		 * `{...controller.option(index)}` on each row.
		 */
		menu?: Snippet<[TriggerMenuController<MentionItem>]>;
	};

	/** A mention kind's record: its `char` read by the atom's markup. */
	type MentionKind = InlineBlockDefinition & { char: string };

	/** The char of the atom's kind (the first listed instance's); `@` with no view (a suggestion). */
	const charOf = (atom: InlineBlockView) =>
		(atom.handle?.edytor.inlineBlocks.get(atom.type) as Partial<MentionKind> | undefined)?.char ??
		'@';

	/**
	 * People mentions, as in Notion: `@` opens a menu of the people your app's
	 * `items(query)` answers; picking one replaces `@query` with a `mention`
	 * atom (`{ id, label }`) and puts the caret after it, in one undo step.
	 * `char` and `kind` make another one (`$` tickers as `ticker` atoms).
	 */
	export const createMentionPlugin = (options: MentionPluginOptions): Plugin => {
		const char = options.char ?? '@';
		const kind = options.kind ?? 'mention';
		const atom: MentionKind = {
			snippet: mention,
			char,
			...mentionForms(kind, char)
		};
		return (edytor) =>
			withRulesAndTriggers(
				edytor,
				{ inlineBlocks: { [kind]: atom } },
				{
					triggers: [
						{
							char,
							name: kind,
							items: (query, ctx) => options.items(query, ctx),
							label: (item: MentionItem) => item.label,
							key: (item: MentionItem) => item.id,
							menu: options.menu,
							onPick: (item: MentionItem, { edytor, block, from, caret }) => {
								const data: MentionData = { id: item.id, label: item.label };
								const written =
									edytor.insertInline(block.id, from, { type: kind, data }).status === 'applied';
								if (written) caret(from + 1);
								return written;
							}
						}
					]
				}
			);
	};
</script>

{#snippet mention({ block }: InlineBlockSnippetPayload<Partial<MentionData>>)}
	<span
		class="edytor-mention"
		data-selected={block.selected ? 'true' : undefined}
		data-edytor-mention={block.type}
		data-mention-id={block.data.id}>{charOf(block)}{block.data.label ?? ''}</span
	>
{/snippet}
