import type { Edytor } from '$lib/edytor.svelte.js';
import type { PluginOperations } from '$lib/plugins.js';
import { sanitizeLinkHref } from '../richtext/richTextOperations.js';
import { fileUploads, type Uploader } from '../uploads.svelte.js';
import { viewLabels, type PartialLabels } from '$lib/labels.js';

/** The media kinds a view shows the labels of. */
export type MediaKind = 'embed' | 'bookmark' | 'file' | 'video' | 'audio';

/**
 * Each view's media labels, by kind: the first plugin of a kind listed in a
 * view claims them, as its kind record (first wins).
 */
export const mediaLabels: Record<MediaKind, ReturnType<typeof viewLabels<'media'>>> = {
	embed: viewLabels('media'),
	bookmark: viewLabels('media'),
	file: viewLabels('media'),
	video: viewLabels('media'),
	audio: viewLabels('media')
};

/**
 * A web page's URL a media block may store or render: the link sanitizer's
 * reading of it (`sanitizeLinkHref`: ASCII control characters and spaces stripped,
 * tab/newline anywhere), then only an absolute `http:`/`https:` URL with a
 * host. `null` for anything else: a script or `data:` URL, a `mailto:`, a
 * relative path, a bare domain.
 */
export const safeWebUrl = (value: unknown): string | null => {
	const href = sanitizeLinkHref(value);
	if (href === null) return null;
	try {
		const url = new URL(href);
		return (url.protocol === 'http:' || url.protocol === 'https:') && url.host ? href : null;
	} catch {
		return null;
	}
};

/**
 * A media file's source (a video, an audio track, an attachment): a
 * {@link safeWebUrl}, or a `blob:` URL an upload answered. Never `data:`:
 * an inline file would be stored in the document and sent in every update.
 */
export const safeMediaSrc = (value: unknown): string | null => {
	const blob = typeof value === 'string' ? /^blob:(.*)$/is.exec(value.trim()) : null;
	const origin = blob && safeWebUrl(blob[1]);
	return origin ? `blob:${origin}` : safeWebUrl(value);
};

/** The file, video and audio plugins' options. */
export type MediaPluginOptions = {
	/**
	 * Upload a file and answer its URL: the empty block's Upload button, and
	 * the pasted and dropped files the kind takes (`media.files`), each shown
	 * uploading with the progress it reports. Without it only links are
	 * embedded.
	 */
	upload?: Uploader;
	/** The words the block shows (its empty panel, its menu row), over the English ones. */
	labels?: PartialLabels<'media'>;
	/** The slash menu's keywords of its command (`block.<kind>`), which replace its own. */
	keywords?: Partial<Record<string, string[]>>;
};

/** One allowlisted embed provider: which links it plays, and its player. */
export type EmbedProvider = {
	/** The provider's name: the frame's `title`. */
	name: string;
	/**
	 * The player's URL for a link of this provider, else `null`. It must be
	 * `https:` on another origin than the page's: any other answer is
	 * refused (the frame has `allow-scripts` and `allow-same-origin`, so a
	 * player on the page's origin, or on one that can script it, could lift
	 * its own sandbox). Match the host exactly (never a
	 * suffix or a substring) and check every id you copy into the player URL.
	 */
	embed: (url: URL) => string | null;
	/** The frame's CSS `aspect-ratio` (default `16 / 9`); ignored with `height`. */
	aspectRatio?: string;
	/** A fixed frame height in pixels (a music player). */
	height?: number;
};

/** The frame's `sandbox`: scripts and the provider's own origin, popups that leave it; no top navigation, modals, downloads or forms. */
export const EMBED_SANDBOX =
	'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation';
/** The frame's permissions (`allow`): what a player needs, nothing that reads the viewer. */
export const EMBED_ALLOW = 'fullscreen; picture-in-picture; encrypted-media; clipboard-write';

const ID = /^[\w-]{1,128}$/;
const hostIs =
	(...hosts: string[]) =>
	(url: URL) =>
		hosts.includes(url.hostname.toLowerCase());
/** `segments` of `url`'s path, empty ones dropped. */
const path = (url: URL) => url.pathname.split('/').filter(Boolean);

const youtubeHost = hostIs(
	'youtube.com',
	'www.youtube.com',
	'm.youtube.com',
	'music.youtube.com',
	'www.youtube-nocookie.com'
);
/** A YouTube start time (`t=42`, `t=42s`, `start=42`) in seconds. */
const youtubeStart = (url: URL) => {
	const t = url.searchParams.get('t') ?? url.searchParams.get('start');
	return t && /^\d{1,6}s?$/.test(t) ? `?start=${parseInt(t, 10)}` : '';
};
const youtube: EmbedProvider = {
	name: 'YouTube',
	embed: (url) => {
		const [first, second] = path(url);
		const id =
			url.hostname.toLowerCase() === 'youtu.be'
				? first
				: !youtubeHost(url)
					? undefined
					: first === 'watch'
						? url.searchParams.get('v')
						: first && ['shorts', 'embed', 'live'].includes(first)
							? second
							: undefined;
		return id && /^[\w-]{11}$/.test(id)
			? `https://www.youtube-nocookie.com/embed/${id}${youtubeStart(url)}`
			: null;
	}
};

const vimeo: EmbedProvider = {
	name: 'Vimeo',
	embed: (url) => {
		const parts = path(url);
		const [id, hash] = hostIs('vimeo.com', 'www.vimeo.com')(url)
			? parts
			: hostIs('player.vimeo.com')(url) && parts[0] === 'video'
				? parts.slice(1)
				: [];
		if (!id || !/^\d{1,12}$/.test(id)) return null;
		const h = hash && /^[\da-f]{1,32}$/i.test(hash) ? hash : url.searchParams.get('h');
		return `https://player.vimeo.com/video/${id}${h && /^[\da-f]{1,32}$/i.test(h) ? `?h=${h}` : ''}`;
	}
};

const loom: EmbedProvider = {
	name: 'Loom',
	embed: (url) => {
		const [kind, id] = path(url);
		return hostIs('loom.com', 'www.loom.com')(url) &&
			(kind === 'share' || kind === 'embed') &&
			id &&
			/^[\da-f]{32}$/i.test(id)
			? `https://www.loom.com/embed/${id}`
			: null;
	}
};

const figma: EmbedProvider = {
	name: 'Figma',
	embed: (url) => {
		const [kind, key] = path(url);
		if (!hostIs('figma.com', 'www.figma.com')(url) || !key || !ID.test(key)) return null;
		if (!['file', 'design', 'proto', 'board', 'slides', 'deck'].includes(kind!)) return null;
		return `https://www.figma.com/embed?embed_host=edytor&url=${encodeURIComponent(url.href)}`;
	}
};

const codepen: EmbedProvider = {
	name: 'CodePen',
	embed: (url) => {
		const [user, kind, id] = path(url);
		return hostIs('codepen.io')(url) &&
			user &&
			ID.test(user) &&
			(kind === 'pen' || kind === 'embed') &&
			id &&
			ID.test(id)
			? `https://codepen.io/${user}/embed/${id}?default-tab=result`
			: null;
	},
	height: 400
};

const spotify: EmbedProvider = {
	name: 'Spotify',
	embed: (url) => {
		let parts = path(url);
		if (!hostIs('open.spotify.com')(url)) return null;
		if (parts[0] === 'embed' || /^intl-[a-z-]+$/i.test(parts[0] ?? '')) parts = parts.slice(1);
		const [kind, id] = parts;
		return ['track', 'album', 'playlist', 'episode', 'show', 'artist'].includes(kind!) &&
			id &&
			/^[A-Za-z0-9]{1,64}$/.test(id)
			? `https://open.spotify.com/embed/${kind}/${id}`
			: null;
	},
	height: 352
};

/**
 * The default allowlist: YouTube (through `youtube-nocookie.com`), Vimeo,
 * Loom, Figma, CodePen and Spotify. A link no provider plays renders no
 * frame. Extend it with `createEmbedPlugin({ providers: [...EMBED_PROVIDERS, mine] })`.
 */
export const EMBED_PROVIDERS: readonly EmbedProvider[] = Object.freeze([
	youtube,
	vimeo,
	loom,
	figma,
	codepen,
	spotify
]);

/**
 * `url` is on the page's own origin (in a browser): a frame there with
 * `allow-scripts` and `allow-same-origin` could remove its own sandbox.
 */
const sameOrigin = (url: URL) => {
	const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin;
	return typeof origin === 'string' && url.origin === origin;
};

/**
 * The player for `value` (a stored or pasted link): the first provider of
 * `providers` that plays it, and its `https:` player URL. `null` when the
 * link is not a {@link safeWebUrl}, no provider plays it, or the player URL
 * a provider answers is not `https:` or is on the page's own origin. The frame's `src` is always this
 * answer, never the stored value.
 */
export const embedSourceOf = (
	value: unknown,
	providers: readonly EmbedProvider[] = EMBED_PROVIDERS
): { src: string; provider: EmbedProvider } | null => {
	const href = safeWebUrl(value);
	if (!href) return null;
	const url = new URL(href);
	for (const provider of providers) {
		let src: string | null;
		try {
			src = provider.embed(new URL(url.href));
		} catch {
			continue;
		}
		if (src === null || src === undefined) continue;
		try {
			const player = new URL(src);
			if (player.protocol === 'https:' && safeWebUrl(src) === src && !sameOrigin(player))
				return { src, provider };
		} catch {
			// An unparsable player URL is refused like any other non-https one.
		}
		return null;
	}
	return null;
};

/** A file's display name from its URL's last path segment, decoded. */
export const fileNameOf = (src: string): string => {
	try {
		const last = new URL(src).pathname.split('/').filter(Boolean).at(-1);
		return last ? decodeURIComponent(last) : src;
	} catch {
		return src;
	}
};

/**
 * The element a media kind's HTML import reads: `element` itself when it
 * is a `tag` (not inside a `figure`, which claims it), or a `figure`'s own
 * `tag` child.
 */
export const claimed = (element: HTMLElement, tag: string): HTMLElement | undefined => {
	if (element.localName === 'figure')
		return [...element.children].find((child): child is HTMLElement => child.localName === tag);
	return element.localName === tag && element.parentElement?.localName !== 'figure'
		? element
		: undefined;
};

/** An imported `video`'s or `audio`'s source: its `src`, else its first `source`'s. */
export const mediaSourceOf = (element: HTMLElement | undefined) =>
	safeMediaSrc(
		element?.getAttribute('src') ?? element?.querySelector('source[src]')?.getAttribute('src')
	);

/** HTML-escape `value` for an attribute or text of an export. */
export const escapeHtml = (value: string) =>
	value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The files each media kind takes: a video, an audio track, any other file. */
const ACCEPTS: Record<'video' | 'audio' | 'file', (file: File) => boolean> = {
	video: (file) => /^video\//i.test(file.type),
	audio: (file) => /^audio\//i.test(file.type),
	file: () => true
};

/**
 * Register `type`'s uploads on the view's (`media.files`): with an
 * `upload`, the files it takes (the file kind: any no other kind takes)
 * become its blocks. Answers the paste hook to list, or `undefined`
 * without an `upload` or a view.
 */
export const mediaUploads = (
	edytor: Edytor | undefined,
	type: 'video' | 'audio' | 'file',
	upload: Uploader | undefined
): PluginOperations['onPaste'] => {
	const uploads = upload ? fileUploads(edytor) : undefined;
	if (!uploads || !upload) return undefined;
	uploads.register({
		type,
		accepts: ACCEPTS[type],
		fallback: type === 'file',
		upload,
		data: (file, answer) => {
			const src = safeMediaSrc(answer);
			if (!src) return null;
			return type === 'file'
				? { src, name: file.name || fileNameOf(src), size: file.size }
				: { src };
		},
		filled: (data) => safeMediaSrc(data.src) !== null
	});
	return uploads.paste;
};
