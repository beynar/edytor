<script module lang="ts">
	import type { Snippet } from 'svelte';
	import type {
		InlineBlockSnippetPayload,
		Plugin,
		TriggerContext,
		TriggerItemPayload
	} from '$lib/plugins.js';
	import { labelsWith, viewLabels, type PartialLabels } from '$lib/labels.js';
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
		/** Replace each row of the menu. */
		item?: Snippet<[TriggerItemPayload<PageLinkItem>]>;
		/** The words the menu and the atom show, over the English ones. */
		labels?: PartialLabels<'pageLink'>;
	};

	/** Each view's page link labels: the first page link plugin listed claims them, as its atom. */
	const pageLinkLabels = viewLabels('pageLink');

	/**
	 * Links to your app's pages, as Notion's `[[`: it opens a menu of the pages
	 * your app's `search(query)` answers; picking one replaces `[[query` with
	 * a `pageLink` atom (`{ id, title, href, icon }`), an `<a>` to the page,
	 * and puts the caret after it, in one undo step.
	 */
	export const createPageLinkPlugin =
		(options: PageLinkPluginOptions): Plugin =>
		(edytor) => {
			const labels = labelsWith('pageLink', options.labels);
			pageLinkLabels.claim(edytor, labels);
			return {
				inlineBlocks: {
					pageLink: {
						snippet: pageLink,
						plain: (data) => {
							const title = (data as Partial<PageLinkData> | undefined)?.title;
							return typeof title === 'string' ? title : '';
						}
					}
				},
				triggers: [
					{
						char: options.char ?? '[[',
						name: labels.menu,
						empty: labels.noResults,
						searching: labels.searching,
						items: (query, ctx) => options.search(query, ctx),
						label: (page: PageLinkItem) => page.title,
						key: (page: PageLinkItem) => page.id,
						item: options.item ?? row,
						onPick: (page: PageLinkItem, { block, from, caret }) => {
							const href = sanitizeLinkHref(page.href ?? options.href?.(page)) ?? undefined;
							const data: PageLinkData = {
								id: page.id,
								title: page.title,
								...(href ? { href } : {}),
								...(page.icon ? { icon: page.icon } : {})
							};
							const after = block.addInlineBlock({
								offset: from,
								block: { type: 'pageLink', data }
							});
							if (after) caret(from + 1);
							return !!after;
						}
					}
				]
			};
		};
</script>

{#snippet pageLink({ block }: InlineBlockSnippetPayload<Partial<PageLinkData>>)}
	<a
		class="edytor-page-link"
		class:selected={block.selected}
		href={sanitizeLinkHref(block.data.href) ?? undefined}
		data-edytor-page-link
		data-page-id={block.data.id}
		><span class="icon" aria-hidden="true">{block.data.icon ?? '📄'}</span><span class="title"
			>{block.data.title ?? pageLinkLabels.of(block.handle?.edytor).untitled}</span
		></a
	>
{/snippet}

{#snippet row({ item, id, selected, pick, select }: TriggerItemPayload<PageLinkItem>)}
	<button
		type="button"
		class="edytor-page-link-row"
		{id}
		role="option"
		tabindex="-1"
		aria-selected={selected}
		data-selected={selected}
		data-testid="trigger-menu-item"
		onmousemove={select}
		onclick={pick}
	>
		<span class="icon" aria-hidden="true">{item.icon ?? '📄'}</span>
		<span class="title">{item.title}</span>
	</button>
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
	.edytor-page-link-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 28px;
		padding: 0 8px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.edytor-page-link-row[data-selected='true'] {
		background: rgba(33, 27, 23, 0.06);
	}
	.edytor-page-link-row .title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
