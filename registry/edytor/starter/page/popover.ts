/** The page parts' helpers: an upload of a picked file and a typed image link. */
/** Read a picked file through `upload`; `null` when it fails. */
export const uploadFile = async (
	upload: (file: File, report: { progress(fraction: number): void }) => Promise<string>,
	file: File
): Promise<string | null> => {
	try {
		return await upload(file, { progress: () => {} });
	} catch (error) {
		console.error('[edytor/starter] upload failed', error);
		return null;
	}
};

/** An `http(s):` or `data:image/` URL a user typed, else `null`. */
export const imageUrl = (text: string): string | null => {
	const value = text.trim();
	if (/^data:image\//i.test(value)) return value;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
};
