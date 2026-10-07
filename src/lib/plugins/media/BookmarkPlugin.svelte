<script module lang="ts">
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import MediaEmpty from './MediaEmpty.svelte';
	import { mediaKinds } from '$lib/crdt/semantics.js';
	import { urlPaste } from './urlPaste.svelte.js';
	import { escapeHtml, safeWebUrl } from './media.js';

	/** What an `unfurl` answers about a page; every field optional. */
	export type BookmarkPreview = {
		title?: string;
		description?: string;
		/** The page's cover image (`og:image`): an `http(s)` URL. */
		image?: string;
		/** The page's icon: an `http(s)` URL. */
		icon?: string;
	};

	export type BookmarkPluginOptions = {
		/**
		 * Read a page's title, description and images, usually through your
		 * server (a browser cannot fetch most pages). Called when a link is
		 * set from the panel or the paste menu; without it the card shows the URL.
		 */
		unfurl?: (url: string) => Promise<BookmarkPreview | null | undefined>;
	};

	const unfurlOf = new WeakMap<Edytor, BookmarkPluginOptions['unfurl']>();

	/** A preview's text field, trimmed and capped: it is stored in the document. */
	const text = (value: unknown, max: number) =>
		typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

	/** The fields of `preview` a bookmark stores: text capped, images {@link safeWebUrl} only. */
	const previewData = (preview: BookmarkPreview | null | undefined) => {
		const fields = {
			title: text(preview?.title, 300),
			description: text(preview?.description, 1000),
			image: safeWebUrl(preview?.image) ?? undefined,
			icon: safeWebUrl(preview?.icon) ?? undefined
		};
		return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
	};

	/**
	 * The unfurl's writes: background bookkeeping, not a gesture, so no
	 * view's history tracks this origin (`crdt/document.ts`, History). The
	 * answer lands whenever the server replies, maybe after more edits: as an
	 * undo step it would make Mod+Z drop the title before the typing.
	 */
	const UNFURL_ORIGIN = Symbol('edytor.bookmark.unfurl');

	/**
	 * Ask the view's `unfurl` about `url` and store its answer on `block`, as
	 * one data write outside the undo history (`UNFURL_ORIGIN`), when the
	 * block still is that bookmark in a view that may write.
	 */
	const fill = async (block: Block, url: string) => {
		const unfurl = unfurlOf.get(block.edytor);
		if (!unfurl || block.edytor.readonly) return;
		let preview: BookmarkPreview | null | undefined;
		try {
			preview = await unfurl(url);
		} catch {
			return;
		}
		const data = previewData(preview);
		const { edytor, id } = block;
		const live = edytor.idToBlock.get(id);
		if (!Object.keys(data).length || !live?.isInTree || !edytor.dispatcher.permits()) return;
		if (live.type !== 'bookmark' || edytor.facade.blockDataOf(id)?.url !== url) return;
		const patches = Object.entries(data).map(([key, value]) => ({ path: [key], value }));
		edytor.doc.transact(
			() => edytor.facade.apply(edytor.facade.prepare.patchData(id, patches)),
			UNFURL_ORIGIN
		);
	};

	const bookmarkLink = (block: Block | undefined, value: string) => {
		const url = safeWebUrl(value);
		if (!block || !url) return false;
		block.data.url = url;
		void fill(block, url);
		return true;
	};

	/**
	 * Notion's web bookmark: a card linking to a page, with its title,
	 * description and images when your `unfurl` answers them, and an
	 * editable caption. Void: its only text is the caption. Pasting an
	 * `http(s)` link on an empty line offers "Bookmark".
	 */
	export const createBookmarkPlugin =
		(options: BookmarkPluginOptions = {}): Plugin =>
		(edytor) => {
			// First wins, as for the kind: a second listing never replaces it.
			if (!unfurlOf.has(edytor)) unfurlOf.set(edytor, options.unfurl);
			return {
				...urlPaste(edytor, {
					type: 'bookmark',
					label: 'Bookmark',
					icon: '🔖',
					data: (url) => ({ url }),
					created: (block, url) => void fill(block, url)
				}),
				blocks: {
					bookmark: {
						...mediaKinds.bookmark,
						snippet: bookmark,
						element: 'figure',
						presets: [
							{
								label: 'Web bookmark',
								icon: '🔖',
								keywords: ['link', 'url', 'preview', 'unfurl'],
								group: 'Media'
							}
						],
						html: (block, caption) => {
							const url = safeWebUrl(block.data?.url);
							const title = text(block.data?.title, 300) ?? url;
							const link = url ? `<a href="${escapeHtml(url)}">${escapeHtml(title!)}</a>` : '';
							return `<figure data-edytor-bookmark>${link}<figcaption>${caption}</figcaption></figure>`;
						},
						plain: (block, caption) =>
							[safeWebUrl(block.data?.url), caption].filter(Boolean).join('\n'),
						// Its own export: a `figure[data-edytor-bookmark]` holding the link.
						parse: (el) => {
							if (el.localName !== 'figure' || !el.hasAttribute('data-edytor-bookmark')) return;
							const anchor = el.querySelector('a[href]');
							const url = safeWebUrl(anchor?.getAttribute('href'));
							const title = text(anchor?.textContent, 300);
							return url ? { url, ...(title && title !== url ? { title } : {}) } : undefined;
						}
					}
				}
			};
		};

	/** The bookmark block, without unfurling: the card shows the URL. */
	export const bookmarkPlugin = createBookmarkPlugin();
</script>

{#snippet bookmark({ block, content }: BlockSnippetPayload<Record<string, unknown>>)}
	{@const url = safeWebUrl(block.data.url)}
	{#if url}
		{@const title = text(block.data.title, 300)}
		{@const description = text(block.data.description, 1000)}
		{@const image = safeWebUrl(block.data.image)}
		{@const icon = safeWebUrl(block.data.icon)}
		<div use:block.void data-edytor-bookmark>
			<a href={url} target="_blank" rel="noopener noreferrer nofollow" draggable="false">
				<span data-edytor-bookmark-text>
					<span data-edytor-bookmark-title>{title ?? url}</span>
					{#if description}<span data-edytor-bookmark-description>{description}</span>{/if}
					<span data-edytor-bookmark-url>
						{#if icon}<img src={icon} alt="" draggable="false" />{/if}<span>{url}</span>
					</span>
				</span>
				{#if image}
					<span data-edytor-bookmark-cover><img src={image} alt="" draggable="false" /></span>
				{/if}
			</a>
		</div>
	{:else}
		<div use:block.void data-edytor-media-empty>
			<MediaEmpty
				block={block.handle}
				label="Add a web bookmark"
				icon="🔖"
				placeholder="Paste the link…"
				submit="Create bookmark"
				invalid="That doesn't look like a web link."
				link={(value) => bookmarkLink(block.handle, value)}
			/>
		</div>
	{/if}
	<!-- The core renders the kind's <figure> around this markup. -->
	<!-- svelte-ignore a11y_figcaption_parent -->
	<figcaption>{@render content()}</figcaption>
{/snippet}
