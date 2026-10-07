import { sanitizeLinkHref } from '../richtext/richTextOperations.js';

/**
 * A web page's URL a media block may store or render: the link sanitizer's
 * reading of it (`sanitizeLinkHref`: C0 controls and spaces stripped,
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
	/** Upload a picked file and answer its URL; without it only links are embedded. */
	upload?: (file: File) => Promise<string>;
};

/** One allowlisted embed provider: which links it plays, and its player. */
export type EmbedProvider = {
	/** The provider's name: the frame's `title`. */
	name: string;
	/**
	 * The player's URL for a link of this provider, else `null`. It must be
	 * `https:`: any other answer is refused. Match the host exactly (never a
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
 * The player for `value` (a stored or pasted link): the first provider of
 * `providers` that plays it, and its `https:` player URL. `null` when the
 * link is not a {@link safeWebUrl}, no provider plays it, or the player URL
 * a provider answers is not `https:`. The frame's `src` is always this
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
			if (new URL(src).protocol === 'https:' && safeWebUrl(src) === src) return { src, provider };
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

/** A byte count for people: `5 B`, `1.2 KB`, `3.4 MB`. */
export const formatBytes = (bytes: number): string => {
	if (!Number.isFinite(bytes) || bytes < 0) return '';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
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
