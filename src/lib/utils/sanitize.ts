/**
 * The sanitizers every reader of untrusted values shares: a link's href and
 * a CSS colour (marks), read the same by render, the clipboard, HTML and
 * markdown import and export. Pure: no DOM, no Svelte, Worker-safe.
 */

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * CSS-color sanitizer for `color`/`highlight` marks. The value lands in
 * `style="color: {value}"` — a `;`/`{`/`}` payload escapes the property
 * and injects arbitrary declarations (`url()` exfil, `position:fixed`
 * overlays). Metacharacters, escape/obfuscation sequences, and
 * resource-loading functions are rejected; real `<color>` values
 * (`#hex`, `rgb()/hsl()/oklch()/color-mix()/var()`, named colors) pass.
 */
export const sanitizeCssColorValue = (value: unknown): string | null => {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 128) return null;
	if (/[;{}<>\\'"`]/.test(trimmed) || /url\s*\(|expression\s*\(|\/\*|\*\//i.test(trimmed)) {
		return null;
	}
	return trimmed;
};

/**
 * Scheme allowlist for link hrefs. `javascript:`/`data:`/`vbscript:`
 * payloads can arrive through native `insertLink`, pasted HTML, or a
 * malicious collaborator — and Svelte renders `href` verbatim. The href is
 * read as the browser's URL parser reads it: it strips C0 controls and
 * spaces at both ends and tab/newline/CR anywhere (`\u0001javascript:` is
 * `javascript:` to a browser), then resolves it against a base; only an
 * allowed scheme, or a relative href that stays relative, passes.
 */
export const sanitizeLinkHref = (href: unknown): string | null => {
	const trimmed = hrefOf(href);
	// A relative href resolves to the base's `https:`: it names no scheme of its own.
	return trimmed &&
		SAFE_LINK_PROTOCOLS.has(urlOf(trimmed, 'https://relative.invalid/')?.protocol ?? '')
		? trimmed
		: null;
};

/**
 * A href as the browser's URL parser reads it: C0 controls and spaces
 * stripped at both ends, tab/newline/CR anywhere; `''` for a non-string
 * (marks arrive from untrusted sources too: synced peers, paste).
 */
const hrefOf = (href: unknown) =>
	typeof href === 'string'
		? // eslint-disable-next-line no-control-regex
			href.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
		: '';
/** `href` parsed (against `base`), or `undefined` when it is no URL. */
const urlOf = (href: string, base?: string) => {
	try {
		return new URL(href, base);
	} catch {
		return undefined;
	}
};

/**
 * A web page's URL a media block may store or render: the link sanitizer's
 * reading of it ({@link sanitizeLinkHref}: ASCII control characters and spaces stripped,
 * tab/newline anywhere), then only an absolute `http:`/`https:` URL with a
 * host. `null` for anything else: a script or `data:` URL, a `mailto:`, a
 * relative path, a bare domain.
 */
export const safeWebUrl = (value: unknown): string | null => {
	const href = hrefOf(value);
	const url = href ? urlOf(href) : undefined;
	return url && /^https?:$/.test(url.protocol) && url.host ? href : null;
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
