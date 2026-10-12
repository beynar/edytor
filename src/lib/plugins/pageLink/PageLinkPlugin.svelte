<svelte:options runes />

<script module lang="ts">
	import type { Snippet } from 'svelte';
	import type { InlineBlockSnippetPayload, Plugin, TriggerContext } from '$lib/plugins.js';
	import type { TriggerMenuController } from '../triggers/TriggerController.svelte.js';
	import { withRulesAndTriggers } from '../triggers/triggers.js';
	import { pageLinkEnglish, labelsOf } from '$lib/labels.js';
	import { sanitizeLinkHref } from '../richtext/richTextOperations.js';

	/** A page the page-link menu offers: what your app's search answers. */
	export type PageLinkItem = {
		/** The page's id in your app: stored in the atom. */
		id: string;
		/** The page's title, shown in the menu and in the atom. */
		title: string;
		/** Where the link goes (absolute, or relative to your app); default `href(page)`. */
		href?: string;
		/** A short icon (an emoji) shown before the title. */
		icon?: string;
	};

	/** What a `pageLink` atom stores. */
	export type PageLinkData = { id: string; title: string; href?: string; icon?: string };

	export type PageLinkPluginOptions = {
		/** The pages matching `query` (the text typed after `[[`), at once or as a promise. */
		search: (
			query: string,
			ctx: TriggerContext
		) => readonly PageLinkItem[] | Promise<readonly PageLinkItem[]>;
		/** A page's URL when the search answers none (`/pages/<id>`, say). */
		href?: (page: PageLinkItem) => string | undefined;
		/** The text that opens the menu (default `[[`). */
		char?: string;
		/**
		 * The menu's markup and its words; it renders while `controller.isOpen`,
		 * at the caret (without it, nothing shows). Keep its ARIA with `{@attach
		 * controller.popup}` on the list (name it) and
		 * `{...controller.option(index)}` on each row.
		 */
		menu?: Snippet<[TriggerMenuController<PageLinkItem>]>;
	};

	/**
	 * Links to your app's pages, as Notion's `[[`: it opens a menu of the pages
	 * your app's `search(query)` answers; picking one replaces `[[query` with
	 * a `pageLink` atom (`{ id, title, href, icon }`), an `<a>` to the page,
	 * and puts the caret after it, in one undo step.
	 */
	export const createPageLinkPlugin =
		(options: PageLinkPluginOptions): Plugin =>
		(edytor) =>
			withRulesAndTriggers(
				edytor,
				{
					inlineBlocks: {
						pageLink: {
							snippet: pageLink,
							plain: (data) => {
								const title = (data as Partial<PageLinkData> | undefined)?.title;
								return typeof title === 'string' ? title : '';
							}
						}
					}
				},
				{
					triggers: [
						{
							char: options.char ?? '[[',
							items: (query, ctx) => options.search(query, ctx),
							label: (page: PageLinkItem) => page.title,
							key: (page: PageLinkItem) => page.id,
							menu: options.menu,
							onPick: (page: PageLinkItem, { edytor, block, from, caret }) => {
								const href = sanitizeLinkHref(page.href ?? options.href?.(page)) ?? undefined;
								const data: PageLinkData = {
									id: page.id,
									title: page.title,
									...(href ? { href } : {}),
									...(page.icon ? { icon: page.icon } : {})
								};
								const atom = { type: 'pageLink', data };
								const written = edytor.insertInline(block.id, from, atom).status === 'applied';
								if (written) caret(from + 1);
								return written;
							}
						}
					]
				}
			);
</script>

{#snippet pageLink({ block }: InlineBlockSnippetPayload<Partial<PageLinkData>>)}
	<a
		class="edytor-page-link"
		class:selected={block.selected}
		href={sanitizeLinkHref(block.data.href) ?? undefined}
		data-edytor-page-link
		data-page-id={block.data.id}
		><span class="icon" aria-hidden="true">{block.data.icon ?? '📄'}</span><span class="title"
			>{block.data.title ??
				labelsOf(block.handle?.edytor, 'pageLink', pageLinkEnglish).untitled}</span
		></a
	>
{/snippet}

<style>
	.edytor-page-link {
		color: inherit;
		text-decoration: none;
		white-space: nowrap;
	}
	.edytor-page-link .title {
		border-bottom: 1px solid rgba(55, 53, 47, 0.25);
		font-weight: 500;
	}
	.edytor-page-link .icon {
		margin-right: 2px;
	}
	.edytor-page-link.selected {
		border-radius: 3px;
		background: rgba(35, 131, 226, 0.14);
	}
</style>
