<script module lang="ts">
	import { tocForms } from '$lib/export/forms.js';
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	import { tocKinds } from '$lib/crdt/semantics.js';
	import { tocEnglish, keywordsOf, labelsOf } from '$lib/labels.js';
	import TableOfContents from './TableOfContents.svelte';
	import {
		richTextHeadingLevel,
		type TocEmptyPayload,
		type TocEntryPayload,
		type TocHeadingLevel,
		type TocPluginOptions,
		tocViews as views
	} from './toc.js';

	export type { TocEmptyPayload, TocEntryPayload, TocHeadingLevel, TocPluginOptions };

	/**
	 * Notion's table of contents: a `toc` block lists the document's
	 * headings, live, indented by level; a click scrolls to one (opening the
	 * closed toggles it sits in). Void: it holds no text, and its list is
	 * never stored, only drawn. Its preset in the slash menu turns an empty
	 * line into one, or inserts it after the line; its words are the view's
	 * `toc` labels (English by default).
	 */
	export const createTocPlugin =
		(options: TocPluginOptions = {}): Plugin =>
		(edytor) => {
			// First wins, as for the kind: a second listing never replaces it.
			if (!views.has(edytor))
				views.set(edytor, {
					headingLevel: options.headingLevel ?? richTextHeadingLevel,
					entry: options.entry,
					empty: options.empty
				});
			const labels = labelsOf(edytor, 'toc', tocEnglish);
			return {
				blocks: {
					toc: {
						...tocKinds.toc,
						element: { tag: 'nav', attributes: { 'aria-label': labels.toc } },
						snippet: toc,
						empty: { content: [], children: [] },
						presets: [
							{
								label: labels.toc,
								icon: '☰',
								keywords: keywordsOf(edytor, 'block.toc', [
									'toc',
									'outline',
									'headings',
									'contents'
								]),
								group: 'Advanced blocks'
							}
						],
						// Its own export: the list is drawn from the document, never carried.
						...tocForms().toc
					}
				}
			};
		};
</script>

{#snippet toc({ block }: BlockSnippetPayload)}
	<div use:block.void data-edytor-toc>
		<TableOfContents />
	</div>
{/snippet}
