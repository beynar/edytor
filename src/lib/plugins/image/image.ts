/** An image source the block may render: http(s), blob, or an inline image. */
export const safeImageSrc = (value: unknown): string | null => {
	if (typeof value !== 'string') return null;
	const src = value.trim();
	return /^(https?:|blob:)/i.test(src) || /^data:image\/[a-z0-9.+-]+[;,]/i.test(src) ? src : null;
};

/**
 * The largest inline image (`data:` URL) an image block takes: 1 MiB of its
 * URL. An inline image is stored in the document and sent in every
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

/** Where an image sits in its block when narrower than it (Notion's alignment). */
export type ImageAlign = 'left' | 'center' | 'right';

/** `data.align`: `left` or `right`, else `center` (Notion's default). */
export const imageAlignOf = (data: Record<string, unknown> | undefined): ImageAlign =>
	data?.align === 'left' || data?.align === 'right' ? data.align : 'center';

/** `data.width`: the image's width in CSS px, a positive number; else none (its natural width). */
export const imageWidthOf = (data: Record<string, unknown> | undefined): number | undefined => {
	const width = data?.width;
	return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : undefined;
};

/** `data.alt`: the image's text alternative; none is `alt=""` (a decorative image). */
export const imageAltOf = (data: Record<string, unknown> | undefined): string =>
	typeof data?.alt === 'string' ? data.alt : '';

/** The narrowest a resize makes an image, in CSS px. */
export const MIN_IMAGE_WIDTH = 48;

/** A file the plugin uploads as an image block: an `image/*` type. */
export const isImageFile = (file: File) => /^image\//i.test(file.type);

/**
 * The data an `<img>` element carries: its source (`storableImageSrc`),
 * its `alt` and its `width` attribute (px) when present; `null` without an
 * accepted source.
 */
export const imgData = (
	img: Element | null | undefined
): Record<string, string | number> | null => {
	const src = storableImageSrc(img?.getAttribute('src'));
	if (!img || !src) return null;
	const alt = img.getAttribute('alt');
	const width = Number(img.getAttribute('width'));
	return {
		src,
		...(alt ? { alt } : {}),
		...(Number.isFinite(width) && width > 0 ? { width } : {})
	};
};
