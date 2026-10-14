<script module lang="ts">
	import { mediaForms } from '$lib/export/forms.js';
	import type { Plugin } from '$lib/plugins.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import { previewData, source } from './SourceBlock.svelte';
	import type { Snippet } from 'svelte';
	import { urlPaste, type UrlPasteController } from './urlPaste.svelte.js';
	import { MEDIA_ICONS, mediaPlugin, safeWebUrl, type BookmarkCardPayload } from './media.js';

	export type { BookmarkCardPayload };

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
		/**
		 * The menu a URL pasted on an empty line opens (Link, Embed, Bookmark);
		 * it renders while `controller.open`, under the line (without it, the
		 * link is kept and nothing shows). The
		 * view's one menu takes the first `menu` its embed and bookmark
		 * plugins pass. Its keys stay the editor's; keep its ARIA with
		 * `{@attach controller.popup}` on the list and
		 * `{@attach controller.option(index)}` on each row.
		 */
		menu?: Snippet<[UrlPasteController]>;
		/**
		 * The card of a bookmark with a link (default: Notion's, the title,
		 * description and URL beside the cover): `<a href={card.url}
		 * {@attach card.link}>`. The first bookmark plugin listed in a view gives its card.
		 */
		card?: Snippet<[BookmarkCardPayload]>;
	};

	/**
	 * The unfurl's writes: background bookkeeping, not a gesture, so no
	 * view's history tracks this origin (`crdt/document.ts`, History). The
	 * answer lands whenever the server replies, maybe after more edits: as an
	 * undo step it would make Mod+Z drop the title before the typing.
	 */
	const UNFURL_ORIGIN = Symbol('edytor.bookmark.unfurl');

	/**
	 * Notion's web bookmark: a card linking to a page, with its title,
	 * description and images when your `unfurl` answers them, and an
	 * editable caption. Void: its only text is the caption. Pasting an
	 * `http(s)` link on an empty line offers "Bookmark".
	 */
	export const createBookmarkPlugin = (options: BookmarkPluginOptions = {}): Plugin =>
		mediaPlugin('bookmark', ['link', 'url', 'preview', 'unfurl'], (edytor) => {
			/**
			 * Ask `unfurl` about `url` and store its answer on `block`, as one
			 * data write outside the undo history (`UNFURL_ORIGIN`), when the
			 * block still is that bookmark in a view that may write. The view's
			 * is the first bookmark plugin's listed (first wins, as for the
			 * kind): its store and its paste offer call this.
			 */
			const fill = async (block: Block, url: string) => {
				const { unfurl } = options;
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
			return {
				card: options.card,
				store: (block, value) => {
					const url = safeWebUrl(value);
					if (!url) return 'invalid';
					block.edytor.patchData(block.id, [{ path: ['url'], value: url }]);
					void fill(block, url);
					return null;
				},
				hooks: urlPaste(
					edytor,
					{
						type: 'bookmark',
						icon: MEDIA_ICONS.bookmark,
						data: (url) => ({ url }),
						created: (block, url) => void fill(block, url)
					},
					options.menu
				),
				record: {
					snippet: source,
					...mediaForms().bookmark
				}
			};
		});
</script>
