/** An image source the block may render: http(s), blob, or an inline image. */
export const safeImageSrc = (value: unknown): string | null => {
	if (typeof value !== 'string') return null;
	const src = value.trim();
	return /^(https?:|blob:)/i.test(src) || /^data:image\/[a-z0-9.+-]+[;,]/i.test(src) ? src : null;
};
