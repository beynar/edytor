/**
 * `text/uri-list` is a line-based format (IANA): lines beginning with `#`
 * are comments and may carry several URIs — consumers take the first
 * non-comment, non-empty line (Quill clipboard.ts does the same).
 */
export const firstUriListEntry = (value: string | null | undefined) =>
	value
		?.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0 && !line.startsWith('#')) ?? null;
