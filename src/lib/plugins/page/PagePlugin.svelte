<script module lang="ts">
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { pageKinds } from '$lib/crdt/semantics.js';
	import { convertToKind, type KindRow } from '$lib/kinds.js';
	import { keywordsOf, labelsWith } from '$lib/labels.js';
	import { getSelectedBlocksInDocumentOrder } from '$lib/selection/replaceSelection.js';
	import PageLink from './PageLink.svelte';
	import { pageHtml, pageIdOf, pageLabels, pageTitleOf, type PagePluginOptions } from './page.js';

	export type { PagePluginOptions };

	const optionsOf = new WeakMap<Edytor, PagePluginOptions>();

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
			pageLabels.claim(edytor, labelsWith('page', options.labels));
			const own = optionsOf.get(edytor)!;
			const labels = pageLabels.of(edytor);
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
						html: (block) => pageHtml(block.data, own, labels.untitled),
						plain: (block) => pageTitleOf(block.data?.title) ?? labels.untitled,
						// Its own export: a `p[data-edytor-page]` naming the page.
						parse: (el) => {
							const pageId = pageIdOf(el.getAttribute('data-edytor-page'));
							if (el.localName !== 'p' || !pageId) return;
							const title = pageTitleOf(el.textContent);
							return { pageId, ...(title && { title }) };
						}
					}
				},
				commands: create
					? [
							{
								id: 'page.new',
								label: labels.page,
								icon: '📄',
								keywords: keywordsOf(
									'page.new',
									['subpage', 'new page', 'document', 'link'],
									own.keywords
								),
								group: 'Basic blocks',
								// Asked of the view given (a `+`'s menu asks it of the block it adds).
								isEnabled: (view = edytor) => Boolean(view.selection.state.startBlock?.convertible),
								run: () => {
									const block = edytor.selection.state.startBlock;
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

	/** The page block without a way to open, name or create pages: a block showing its stored title. */
	export const pagePlugin = createPagePlugin();
</script>

{#snippet page({ block }: BlockSnippetPayload<Record<string, unknown>>)}
	{@const options = (block.handle && optionsOf.get(block.handle.edytor)) || {}}
	<div use:block.void data-edytor-page>
		<PageLink data={block.data} handle={block.handle} {options} />
	</div>
{/snippet}
