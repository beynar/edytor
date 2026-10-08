<script module lang="ts">
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { tocKinds } from '$lib/crdt/semantics.js';
	import TableOfContents from './TableOfContents.svelte';
	import { richTextHeadingLevel, type TocHeadingLevel, type TocPluginOptions } from './toc.js';

	export type { TocHeadingLevel, TocPluginOptions };

	const levelOf = new WeakMap<Edytor, TocHeadingLevel>();

	/**
	 * Notion's table of contents: a `toc` block lists the document's
	 * headings, live, indented by level; a click scrolls to one (opening the
	 * closed toggles it sits in). Void: it holds no text, and its list is
	 * never stored, only drawn. "Table of contents" in the slash menu turns
	 * an empty line into one, or inserts it after the line.
	 */
	export const createTocPlugin =
		(options: TocPluginOptions = {}): Plugin =>
		(edytor) => {
			// First wins, as for the kind: a second listing never replaces it.
			if (!levelOf.has(edytor)) levelOf.set(edytor, options.headingLevel ?? richTextHeadingLevel);
			return {
				blocks: {
					toc: {
						...tocKinds.toc,
						element: { tag: 'nav', attributes: { 'aria-label': 'Table of contents' } },
						snippet: toc,
						empty: { content: [], children: [] },
						presets: [
							{
								label: 'Table of contents',
								icon: '☰',
								keywords: ['toc', 'outline', 'headings', 'contents'],
								group: 'Advanced blocks'
							}
						],
						html: () => '<nav data-edytor-toc></nav>',
						plain: () => '',
						// Its own export: the list is drawn from the document, never carried.
						parse: (el) =>
							el.localName === 'nav' && el.hasAttribute('data-edytor-toc') ? {} : undefined
					}
				}
			};
		};

	/** The table of contents over the rich text headings. */
	export const tocPlugin = createTocPlugin();
</script>

{#snippet toc({ block }: BlockSnippetPayload)}
	{@const level = (block.handle && levelOf.get(block.handle.edytor)) || richTextHeadingLevel}
	<div use:block.void data-edytor-toc>
		<TableOfContents {level} />
	</div>
{/snippet}
