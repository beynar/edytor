/** An image source the block may render: http(s), blob, or an inline image. */
export const safeImageSrc = (value: unknown): string | null => {
	if (typeof value !== 'string') return null;
	const src = value.trim();
	return /^(https?:|blob:)/i.test(src) || /^data:image\/[a-z0-9.+-]+[;,]/i.test(src) ? src : null;
};

/**
 * The largest inline image (`data:` URL) an image block takes: 1 MiB of its
 * URL (H6). An inline image is stored in the document and sent in every
 * update and catch-up that carries the block, so a larger one would bloat
 * the room's frames and storage: host the file instead (the plugin's
 * `upload` option) and embed its URL.
 */
export const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;

/** Is `src` an inline (`data:`) image larger than {@link MAX_INLINE_IMAGE_BYTES}? */
export const oversizedInlineImage = (src: string): boolean =>
	/^data:/i.test(src) && src.length > MAX_INLINE_IMAGE_BYTES;

/**
 * An image source a block may store: {@link safeImageSrc}'s, but no
 * inline image over {@link MAX_INLINE_IMAGE_BYTES}. Rendering still takes
 * any safe source, so a document that holds a larger one shows it.
 */
export const storableImageSrc = (value: unknown): string | null => {
	const src = safeImageSrc(value);
	return src !== null && !oversizedInlineImage(src) ? src : null;
};
