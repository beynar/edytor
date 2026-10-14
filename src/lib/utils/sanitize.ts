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
	// Marks arrive from untrusted sources too (synced peers, paste) —
	// reject non-strings outright instead of throwing on `.replace`.
	if (typeof href !== 'string') return null;
	// eslint-disable-next-line no-control-regex
	const trimmed = href.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
	if (!trimmed) return null;
	try {
		// A relative href resolves to the base's `https:`: it names no scheme of its own.
		return SAFE_LINK_PROTOCOLS.has(new URL(trimmed, 'https://relative.invalid/').protocol)
			? trimmed
			: null;
	} catch {
		return null;
	}
};
