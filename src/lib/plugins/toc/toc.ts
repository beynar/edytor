import type { Snippet } from 'svelte';
import type { ControlAttributes } from '../chrome.js';

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
	/**
	 * One entry (default: a `button` with the heading's text, one nesting
	 * step in per level under the shallowest). Spread `entry.attributes` on
	 * it: a click scrolls its heading into view, opening the closed toggles
	 * it sits in, and the selection stays.
	 */
	entry?: Snippet<[TocEntryPayload]>;
	/** What shows while the document has no heading (default: a `p` with the view's `toc.empty`). */
	empty?: Snippet<[TocEmptyPayload]>;
};

/** What a table of contents' `entry` snippet receives: one heading. */
export type TocEntryPayload = {
	/** The heading's block id. */
	id: string;
	/** Its level (`headingLevel`'s answer, 1 the outermost). */
	level: number;
	/** How many steps in it sits: its level less the shallowest shown. */
	depth: number;
	/** Its text (`''` when it has none). */
	text: string;
	/** What it reads: its text, else the view's `toc.untitled`. */
	label: string;
	/** Scroll its heading into view (opening the closed toggles it sits in). */
	go: () => void;
	/**
	 * Spread on the entry's element: its marker (`data-edytor-toc-entry`,
	 * `data-level`, `data-untitled`), `--edytor-toc-depth` (its depth, for
	 * its indent), a press that keeps the editor's selection, and a click
	 * that scrolls to it.
	 */
	attributes: ControlAttributes;
};

/** What a table of contents' `empty` snippet receives. */
export type TocEmptyPayload = {
	/** The view's words for it (`toc.empty`). */
	label: string;
};

/** A view's table of contents: the first plugin listed sets it. */
export type TocView = Required<Pick<TocPluginOptions, 'headingLevel'>> &
	Pick<TocPluginOptions, 'entry' | 'empty'>;

/** The rich text headings' levels (`heading`, `toggle-heading`), as they draw them. */
export const richTextHeadingLevel: TocHeadingLevel = ({ type, data }) => {
	if (type !== 'heading' && type !== 'toggle-heading') return null;
	const { level } = data;
	return level === undefined || level === 'h1' ? 1 : level === 'h2' ? 2 : 3;
};

/** Each view's table of contents (the first plugin listed sets it). */
export const tocViews = new WeakMap<object, TocView>();
