/**
 * A block's level in the table of contents (1 the outermost), or `null`
 * when it is not a heading: read from its kind and data.
 */
export type TocHeadingLevel = (block: {
	type: string;
	data: Readonly<Record<string, unknown>>;
}) => number | null;

/** The table of contents plugin's options. */
export type TocPluginOptions = {
	/**
	 * Which blocks the table lists, and how deep: by default the rich text
	 * headings and toggle headings, by their `data.level` (`h1` 1, `h2` 2,
	 * any other 3, as they are drawn).
	 */
	headingLevel?: TocHeadingLevel;
};

/** The rich text headings' levels (`heading`, `toggle-heading`), as they draw them. */
export const richTextHeadingLevel: TocHeadingLevel = ({ type, data }) => {
	if (type !== 'heading' && type !== 'toggle-heading') return null;
	const { level } = data;
	return level === undefined || level === 'h1' ? 1 : level === 'h2' ? 2 : 3;
};
