<script module lang="ts">
	import { pageForms } from '$lib/export/forms.js';
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	import { pageKinds } from '$lib/crdt/semantics.js';
	import { convertToKind, type KindRow } from '$lib/kinds.js';
	import { pageEnglish, keywordsOf, labelsOf } from '$lib/labels.js';
	import { getSelectedBlocksInDocumentOrder } from '$lib/selection/replaceSelection.js';
	import PageLink from './PageLink.svelte';
	import {
		pageIdOf,
		pageTitleOf,
		pageOptions as optionsOf,
		type PageBlockLinkPayload,
		type PagePluginOptions
	} from './page.js';

	export type { PageBlockLinkPayload, PagePluginOptions };

	/**
	 * Notion's subpage block: a `page` block links to another document by
	 * id (`data.pageId`), and shows its title (`data.title`, the cache your
	 * `title` lookup refreshes). Each page is a document of its own (a room
	 * per page): moving a subpage is moving this block, and the page itself,
	 * its content and history, never moves. A click opens it (`open`), and so
	 * does Enter over it selected alone; a modified or middle click opens it
	 * in a new tab (`{ newTab: true }`, the browser's own on an `href`). With `create`, the "Page"
	 * command (slash menu, `+`) creates a page, inserts a block linking to it
	 * where the caret is (an empty line becomes it) and opens it.
	 *
	 * ```ts
	 * createPagePlugin({
	 *   open: (pageId) => goto(`/p/${pageId}`),
	 *   href: (pageId) => `/p/${pageId}`,
	 *   title: (pageId) => pages.get(pageId)?.title,
	 *   create: () => crypto.randomUUID()
	 * });
	 * ```
	 */
	export const createPagePlugin =
		(options: PagePluginOptions = {}): Plugin =>
		(edytor) => {
			// First wins, as for the kind: a second listing never replaces it.
			if (!optionsOf.has(edytor)) optionsOf.set(edytor, options);
			const own = optionsOf.get(edytor)!;
			const labels = labelsOf(edytor, 'page', pageEnglish);
			const { create } = own;
			return {
				hotkeys: {
					// Enter over a page block selected alone opens it (Notion).
					enter: ({ prevent }) => {
						const [block, ...rest] = getSelectedBlocksInDocumentOrder(edytor);
						const pageId =
							block?.type === 'page' &&
							!rest.length &&
							pageIdOf(edytor.facade.blockDataOf(block.id)?.pageId);
						if (!pageId || !own.open) return;
						const open = own.open;
						prevent(() => open(pageId, { newTab: false }));
					}
				},
				blocks: {
					page: {
						...pageKinds.page,
						snippet: page,
						empty: { content: [], children: [] },
						// Its own export: a `p[data-edytor-page]` naming the page.
						...pageForms(own, labels.untitled).page
					}
				},
				commands: create
					? [
							{
								id: 'page.new',
								label: labels.page,
								icon: '📄',
								keywords: keywordsOf(edytor, 'page.new', [
									'subpage',
									'new page',
									'document',
									'link'
								]),
								group: 'Basic blocks',
								// Asked of the view given (a `+`'s menu asks it of the block it adds).
								isEnabled: (view = edytor) =>
									Boolean(view.selection.textRange().startText?.parent.convertible),
								run: () => {
									const block = edytor.selection.textRange().startText?.parent;
									if (!block?.convertible || !edytor.dispatcher.permits()) return false;
									const made = create();
									const { pageId: raw, title: named } =
										typeof made === 'string' ? { pageId: made, title: undefined } : (made ?? {});
									const pageId = pageIdOf(raw);
									if (!pageId) return false;
									const title = pageTitleOf(named);
									const row: KindRow = {
										id: 'page.new',
										label: labels.page,
										value: {
											type: 'page',
											data: { pageId, ...(title && { title }) },
											content: [],
											children: []
										},
										replaces: true
									};
									const applied = convertToKind(edytor, block, row);
									if (applied) own.open?.(pageId, { newTab: false });
									return applied;
								}
							}
						]
					: []
			};
		};
</script>

{#snippet page({ block }: BlockSnippetPayload<Record<string, unknown>>)}
	{@const options = (block.handle && optionsOf.get(block.handle.edytor)) || {}}
	<div use:block.void data-edytor-page>
		<PageLink data={block.data} handle={block.handle} {options} />
	</div>
{/snippet}
