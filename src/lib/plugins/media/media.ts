import type { Snippet } from 'svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import type { Attachment } from 'svelte/attachments';
import { attach } from '../chrome.js';
import type { BlockDefinition, Plugin, PluginDefinitions, PluginOperations } from '$lib/plugins.js';
import { mediaKinds } from '$lib/crdt/semantics.js';
import { escapeHtml } from '$lib/clipboard/serializeClipboardFragment.js';
import { keywordsOf, labelsOf, mediaEnglish } from '$lib/labels.js';
import { MEDIA_ICONS, type EmptyView } from './empty.svelte.js';

/** The media kinds. */
export type MediaKind = 'embed' | 'bookmark' | 'file' | 'video' | 'audio';

export { MEDIA_ICONS };

/**
 * A media kind in a view: the first plugin of the kind listed in it claims
 * it, as its kind record (first wins): how a block of it stores a source,
 * the embed's allowlist, and the app's markup for the kind's own control
 * (the bookmark's `card`, the file's `row`, the embed's `fallback`).
 */
export type MediaView = EmptyView & {
	providers?: readonly EmbedProvider[];
	card?: Snippet<[BookmarkCardPayload]>;
	row?: Snippet<[FileRowPayload]>;
	fallback?: Snippet<[EmbedFallbackPayload]>;
};

/** What a bookmark's `card` snippet receives: the page it links to, as `unfurl` described it. */
export type BookmarkCardPayload = {
	/** The bookmark; `undefined` in a suggestion's preview. */
	block: Block | undefined;
	/** The page's URL (`http(s)`). */
	url: string;
	/** Its title, description, cover image and icon, when `unfurl` answered them. */
	title: string | undefined;
	description: string | undefined;
	image: string | undefined;
	icon: string | undefined;
	/**
	 * The card's link (`<a href={card.url} {@attach card.link}>`): a new tab
	 * without the opener, never dragged out of the editor.
	 */
	link: Attachment<HTMLElement>;
};

/** What a file block's `row` snippet receives: the file it links to. */
export type FileRowPayload = {
	/** The file block; `undefined` in a suggestion's preview. */
	block: Block | undefined;
	/** The file's URL. */
	src: string;
	/** Its name: the uploaded file's, else its URL's last segment. */
	name: string;
	/** Its size in bytes, when it was uploaded. */
	size: number | undefined;
	/** That size in the view's words (`media.fileSize`), `''` without one. */
	sizeLabel: string;
	/**
	 * The file is uploading (then `src` is its object URL, this view's only,
	 * never stored): the row shows it at once, with `progress`.
	 */
	uploading: boolean;
	/** The share sent while it uploads, `0` to `1`; `null` before a report or once stored. */
	progress: number | null;
	/**
	 * The row's link (`<a href={row.src} {@attach row.link}>`): it downloads
	 * the file under its name, in a new tab without the opener, never dragged
	 * out of the editor.
	 */
	link: Attachment<HTMLElement>;
};

/** What an embed's `fallback` snippet receives: a link no allowed provider plays. */
export type EmbedFallbackPayload = {
	/** The embed; `undefined` in a suggestion's preview. */
	block: Block | undefined;
	/** The link (`http(s)`), shown as a link, never in a frame. */
	url: string;
	/** Its link (`<a href={fallback.url} {@attach fallback.link}>`): a new tab without the opener. */
	link: Attachment<HTMLElement>;
};

/** A media block's link opens a new tab without the opener (and tells the target nothing). */
export const LINK_REL = 'noopener noreferrer nofollow';

/**
 * A media block's link's attachment: a new tab without the opener
 * (`target`, `rel`), and `own` (`draggable="false"`: no drag of its own; a
 * file's `download` name). The default markup writes the same, so a server
 * render's link is safe too; its `href` is the markup's. It is the block's
 * own link (`data-edytor-block-link`, `sel.press.void`): in an editable
 * view a press on it selects the block and a plain click opens nothing;
 * Mod or Shift + click, a middle click, or a click in a readonly view opens it.
 */
export const mediaLink = (own: { draggable?: 'false'; download?: string } = {}, block?: Block) =>
	attach(
		{ target: '_blank', rel: LINK_REL, 'data-edytor-block-link': '', ...own },
		{
			click: (event: MouseEvent) => {
				const plain = !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
				if (block && !block.edytor.readonly && event.button === 0 && plain) event.preventDefault();
			}
		}
	);

/** The app's markup for a media kind's own control in `view`, if any. */
export const mediaControl =
	<K extends 'card' | 'row' | 'fallback'>(kind: MediaKind, control: K) =>
	(view: Edytor | undefined) =>
		mediaView(view, kind)?.[control];

const views = new WeakMap<Edytor, Partial<Record<MediaKind, MediaView>>>();

/** The view's media kind, when a plugin of it is listed there. */
export const mediaView = (edytor: Edytor | undefined, kind: MediaKind): MediaView | undefined =>
	edytor && views.get(edytor)?.[kind];

/**
 * A media kind's plugin (Notion's): a void `figure` with an editable
 * caption, its preset (its icon, `keywords`, its name in the view's
 * `media` labels), and its view
 * (`MediaView`), which the first plugin of the kind listed claims. `own`
 * answers the kind's own parts: how it stores a source, its hooks and its
 * record (its snippet, its export and import); `claims` says whether this
 * plugin claimed the kind in `edytor`.
 */
export const mediaPlugin =
	(
		kind: MediaKind,
		keywords: string[],
		own: (
			edytor: Edytor,
			claims: boolean
		) => Pick<MediaView, 'store' | 'providers' | 'card' | 'row' | 'fallback'> & {
			hooks?: PluginOperations & PluginDefinitions;
			record: Partial<BlockDefinition>;
		}
	): Plugin =>
	(edytor) => {
		const kinds = edytor && (views.get(edytor) ?? {});
		const claims = !!kinds && !kinds[kind];
		const { hooks, record, ...view } = own(edytor, claims);
		if (claims)
			views.set(edytor, {
				...kinds,
				[kind]: view
			});
		return {
			...hooks,
			blocks: {
				[kind]: {
					...mediaKinds[kind],
					element: 'figure',
					presets: [
						{
							label: labelsOf(edytor, 'media', mediaEnglish)[kind],
							icon: MEDIA_ICONS[kind],
							keywords: keywordsOf(edytor, `block.${kind}`, keywords),
							group: 'Media'
						}
					],
					...record
				}
			}
		};
	};

export * from './sources.js';
import type { EmbedProvider } from './sources.js';

export { escapeHtml };
