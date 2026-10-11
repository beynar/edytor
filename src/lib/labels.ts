/**
 * The words the package itself shows or says: the kinds' and commands'
 * names (the menus search them), the document's own markup (placeholders,
 * a to-do's checkbox, an empty body's hint, a page's or an entry's
 * "Untitled"), the accessible names of the elements it renders, and the
 * view's announcements. English is the default. A view's `labels`
 * (`<Edytor labels>`) replaces any entry of any section, and its
 * `keywords` a command's slash keywords, by command id. The words of the
 * chrome (menus, bars, panels, cards) are the app's: its snippets write them.
 *
 * A label that says something about a value is a function of it, so a
 * language can order and inflect the words: `moved: (what) => …`.
 */

/** What the view itself says: its live announcements and a suggestion's default name. */
export type EditorLabels = {
	/** A block suggestion's accessible name when it has no `label`. */
	suggestion: string;
	/** One block in an announcement, by its kind's label ("Heading 1 block"). */
	block: (kind: string) => string;
	/** Several blocks in an announcement ("3 blocks"). */
	blocks: (count: number) => string;
	movedUp: (what: string) => string;
	movedDown: (what: string) => string;
	indented: (what: string) => string;
	outdented: (what: string) => string;
	/** A move to a place (a drop). */
	moved: (what: string) => string;
	deleted: (what: string) => string;
};

/** The rich text kinds and marks: their names, the document's own words, placeholders. */
export type RichTextLabels = {
	/** Each preset's label: the slash menu, Turn into, the handles' names. */
	kinds: {
		paragraph: string;
		heading1: string;
		heading2: string;
		heading3: string;
		toggleHeading1: string;
		toggleHeading2: string;
		toggleHeading3: string;
		bulletedList: string;
		numberedList: string;
		todoList: string;
		toggleList: string;
		callout: string;
		quote: string;
		divider: string;
	};
	/** The marks' toolbar buttons (`MarkDefinition.toolbar.label`). */
	marks: { bold: string; italic: string; underline: string; strike: string; code: string };
	/** A to-do's checkbox. */
	checkbox: string;
	/** The hint an empty body shows (an open toggle's, a callout's): a press there starts it. */
	emptyBody: { toggle: string; callout: string };
	/** A callout's icon button: `change` its icon, `add` one when it has none. */
	calloutIcon: { change: string; add: string };
	/** `richTextPlaceholder`'s texts. */
	placeholders: {
		heading: (level: 1 | 2 | 3) => string;
		toggleHeading: (level: 1 | 2 | 3) => string;
		list: string;
		todo: string;
		toggle: string;
		quote: string;
		/** An empty callout's title. */
		callout: string;
		/** A focused empty caption (image, embed, bookmark, file, video, audio). */
		caption: string;
		/** A focused empty block of any other kind. */
		empty: string;
	};
};

/** The block menu's actions (its search matches them) and the block colours' commands. */
export type BlockMenuLabels = {
	turnInto: string;
	/** The Color row. */
	color: string;
	/** A color's name, by its `BLOCK_COLORS` name (`red`), `default` for none. */
	colors: Record<string, string>;
	/** A text color row and command, from the color's name ("Red text"). */
	colorText: (color: string) => string;
	/** A background row and command, from the color's name ("Red background"). */
	colorBackground: (color: string) => string;
	copyLink: string;
	duplicate: string;
	moveUp: string;
	moveDown: string;
	delete: string;
	/** Key names in the shortcuts shown off a Mac. */
	ctrl: string;
	shift: string;
	deleteKey: string;
};

export type ImageLabels = {
	/** The preset. */
	image: string;
};

/** The media kinds' presets, and a file's size. */
export type MediaLabels = {
	embed: string;
	bookmark: string;
	file: string;
	video: string;
	audio: string;
	/** A file's size, in bytes. */
	fileSize: (bytes: number) => string;
};

export type CodeLabels = {
	/** The preset (a language's name is its `CodePluginOptions.languages` row's). */
	code: string;
};

/** The page block (`createPagePlugin`). */
export type PageLabels = {
	/** The "Page" command. */
	page: string;
	/** A page without a title: the block, its plain text and HTML export. */
	untitled: string;
};

/** The table of contents block (`createTocPlugin`). */
export type TocLabels = {
	/** The preset, and the block's accessible name. */
	toc: string;
	/** An entry for an empty heading. */
	untitled: string;
	/** The hint shown with no heading. */
	empty: string;
};

/** The `[[` page link atom (`createPageLinkPlugin`). */
export type PageLinkLabels = {
	/** An atom whose page has no title. */
	untitled: string;
};

/** The block and inline equations (`createEquationPlugin`). */
export type EquationLabels = {
	/** The block preset, and the block's accessible name. */
	block: string;
	/** The inline command. */
	inline: string;
	/** An empty block equation. */
	blockPlaceholder: string;
	/** An empty inline equation. */
	inlinePlaceholder: string;
	/** TeX that does not render: shown as the equation's title, with KaTeX's message. */
	invalid: string;
};

export type ColumnsLabels = {
	/** The `columns.<n>` command. */
	columns: (count: number) => string;
	/** A resize band's accessible name. */
	resize: string;
};

/** The comments plugin (`createCommentsPlugin`): its toolbar button and its sidebar. */
export type CommentsLabels = {
	/** The toolbar button, and a thread's card's accessible name. */
	comment: string;
	/** The sidebar's accessible name. */
	sidebar: string;
};

/** The table block (`createTablePlugin`). */
export type TableLabels = {
	/** The "Table" command, and a table's accessible name. */
	table: string;
	/** The block menu's switches. */
	headerRow: string;
	headerColumn: string;
	/** The block menu's rows: at the row and column of the cell the caret was in (else the last ones). */
	insertRowAbove: string;
	insertRowBelow: string;
	insertColumnLeft: string;
	insertColumnRight: string;
	deleteRow: string;
	deleteColumn: string;
	/** A column's resize band. */
	resize: string;
	/** A padded cell (a row showing none in a column): its first press creates it. */
	emptyCell: string;
};

/** Every section of the dictionary. */
export type Labels = {
	editor: EditorLabels;
	richText: RichTextLabels;
	blockMenu: BlockMenuLabels;
	image: ImageLabels;
	media: MediaLabels;
	code: CodeLabels;
	columns: ColumnsLabels;
	page: PageLabels;
	toc: TocLabels;
	pageLink: PageLinkLabels;
	comments: CommentsLabels;
	table: TableLabels;
	equation: EquationLabels;
};

/** The entries of a section to replace: any of them, and any entry of a nested group. */
type Overrides<L> = {
	[P in keyof L]?: L[P] extends (...args: never[]) => unknown
		? L[P]
		: L[P] extends object
			? Partial<L[P]>
			: L[P];
};

/**
 * A view's words (`<Edytor labels>`): any entry of any section, and any
 * entry of a nested group (`placeholders`, `kinds`) without the others;
 * `keywords` replaces a command's slash keywords by command id (list the
 * English ones in it to keep them).
 */
export type PartialLabels = { [K in keyof Labels]?: Overrides<Labels[K]> } & {
	keywords?: Partial<Record<string, string[]>>;
};

/** A byte count for people: `5 B`, `1.2 KB`, `3.4 MB`. */
const bytes = (count: number): string => {
	if (!Number.isFinite(count) || count < 0) return '';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = count;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

const isGroup = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** `value` frozen down to its nested groups. */
const frozen = <T extends object>(value: T): T => {
	for (const entry of Object.values(value)) if (isGroup(entry)) frozen(entry);
	return Object.freeze(value);
};

const UNTITLED = 'Untitled';
/** An empty body's hint (`body.hint`). */
/* @__NO_SIDE_EFFECTS__ */
const emptyBody = (kind: string) => `Empty ${kind}. Click or drop blocks inside.`;
const heading = (level: number) => `Heading ${level}`;
const toggleHeading = (level: number) => `Toggle heading ${level}`;

/** The `editor` section in English. */
export const editorEnglish: EditorLabels = /* @__PURE__ */ frozen({
	suggestion: 'Suggestion',
	block: (kind) => `${kind} block`,
	blocks: (count) => `${count} blocks`,
	movedUp: (what) => `Moved ${what} up`,
	movedDown: (what) => `Moved ${what} down`,
	indented: (what) => `Indented ${what}`,
	outdented: (what) => `Outdented ${what}`,
	moved: (what) => `Moved ${what}`,
	deleted: (what) => `Deleted ${what}`
});

/** The `richText` section in English. */
export const richTextEnglish: RichTextLabels = /* @__PURE__ */ frozen({
	kinds: {
		paragraph: 'Text',
		heading1: heading(1),
		heading2: heading(2),
		heading3: heading(3),
		toggleHeading1: toggleHeading(1),
		toggleHeading2: toggleHeading(2),
		toggleHeading3: toggleHeading(3),
		bulletedList: 'Bulleted list',
		numberedList: 'Numbered list',
		todoList: 'To-do list',
		toggleList: 'Toggle list',
		callout: 'Callout',
		quote: 'Quote',
		divider: 'Divider'
	},
	marks: {
		bold: 'Bold',
		italic: 'Italic',
		underline: 'Underline',
		strike: 'Strike',
		code: 'Code'
	},
	checkbox: 'Done',
	emptyBody: {
		toggle: emptyBody('toggle'),
		callout: emptyBody('callout')
	},
	calloutIcon: { change: 'Change icon', add: 'Add icon' },
	placeholders: {
		heading,
		toggleHeading,
		list: 'List',
		todo: 'To-do',
		toggle: 'Toggle',
		quote: 'Empty quote',
		callout: 'Callout title',
		caption: 'Write a caption…',
		empty: "Type '/' for commands"
	}
});

/** The `blockMenu` section in English. */
export const blockMenuEnglish: BlockMenuLabels = /* @__PURE__ */ frozen({
	turnInto: 'Turn into',
	color: 'Color',
	colors: Object.fromEntries(
		['Default', 'Gray', 'Brown', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink', 'Red'].map(
			(name) => [name.toLowerCase(), name]
		)
	),
	colorText: (color) => `${color} text`,
	colorBackground: (color) => `${color} background`,
	copyLink: 'Copy link to block',
	duplicate: 'Duplicate',
	moveUp: 'Move up',
	moveDown: 'Move down',
	delete: 'Delete',
	ctrl: 'Ctrl',
	shift: 'Shift',
	deleteKey: 'Del'
});

/** The `image` section in English. */
export const imageEnglish: ImageLabels = /* @__PURE__ */ frozen({ image: 'Image' });

/** The `media` section in English. */
export const mediaEnglish: MediaLabels = /* @__PURE__ */ frozen({
	embed: 'Embed',
	bookmark: 'Web bookmark',
	file: 'File',
	video: 'Video',
	audio: 'Audio',
	fileSize: bytes
});

/** The `code` section in English. */
export const codeEnglish: CodeLabels = /* @__PURE__ */ frozen({ code: 'Code' });

/** The `columns` section in English. */
export const columnsEnglish: ColumnsLabels = /* @__PURE__ */ frozen({
	columns: (count) => `${count} columns`,
	resize: 'Resize columns'
});

/** The `page` section in English. */
export const pageEnglish: PageLabels = /* @__PURE__ */ frozen({ page: 'Page', untitled: UNTITLED });

/** The `toc` section in English. */
export const tocEnglish: TocLabels = /* @__PURE__ */ frozen({
	toc: 'Table of contents',
	untitled: UNTITLED,
	empty: 'Add headings to create a table of contents.'
});

/** The `pageLink` section in English. */
export const pageLinkEnglish: PageLinkLabels = /* @__PURE__ */ frozen({ untitled: UNTITLED });

/** The `comments` section in English. */
export const commentsEnglish: CommentsLabels = /* @__PURE__ */ frozen({
	comment: 'Comment',
	sidebar: 'Comments'
});

/** The `table` section in English. */
export const tableEnglish: TableLabels = /* @__PURE__ */ frozen({
	table: 'Table',
	headerRow: 'Header row',
	headerColumn: 'Header column',
	insertRowAbove: 'Insert row above',
	insertRowBelow: 'Insert row below',
	insertColumnLeft: 'Insert column left',
	insertColumnRight: 'Insert column right',
	deleteRow: 'Delete row',
	deleteColumn: 'Delete column',
	resize: 'Resize column',
	emptyCell: 'Empty cell'
});

/** The `equation` section in English. */
export const equationEnglish: EquationLabels = /* @__PURE__ */ frozen({
	block: 'Block equation',
	inline: 'Inline equation',
	blockPlaceholder: 'Add a TeX equation',
	inlinePlaceholder: 'New equation',
	invalid: 'Invalid equation'
});

/**
 * The English dictionary: the default of every section. Frozen: start
 * yours from a copy (`{ ...englishLabels.richText, checkbox: '…' }`). Each
 * plugin reads only its own section, so an app ships the words of the
 * plugins it lists.
 */
export const englishLabels: Labels = /* @__PURE__ */ frozen({
	editor: editorEnglish,
	richText: richTextEnglish,
	blockMenu: blockMenuEnglish,
	image: imageEnglish,
	media: mediaEnglish,
	code: codeEnglish,
	columns: columnsEnglish,
	page: pageEnglish,
	toc: tocEnglish,
	pageLink: pageLinkEnglish,
	comments: commentsEnglish,
	table: tableEnglish,
	equation: equationEnglish
});

/** Each view's sections, merged once: its `labels` over the English ones. */
const merged = new WeakMap<PartialLabels, Map<string, object>>();

/**
 * The words of `section` in `view` (`english` its English words): the
 * view's `labels` entries over them, a nested group's entries replacing
 * only theirs. English for no view (a document read without one).
 */
export const labelsOf = <K extends keyof Labels>(
	view: { readonly labels: PartialLabels } | undefined,
	section: K,
	english: Labels[K]
): Labels[K] => {
	const overrides = view?.labels[section] as Record<string, unknown> | undefined;
	if (!overrides) return english;
	let sections = merged.get(view!.labels);
	if (!sections) merged.set(view!.labels, (sections = new Map()));
	let words = sections.get(section);
	if (!words) {
		const base = english as Record<string, unknown>;
		const out: Record<string, unknown> = { ...base };
		for (const [key, value] of Object.entries(overrides))
			if (value !== undefined)
				out[key] = isGroup(base[key]) && isGroup(value) ? { ...base[key], ...value } : value;
		sections.set(section, (words = out));
	}
	return words as Labels[K];
};

/**
 * The slash keywords of command `id` in `view`: its `keywords` entry for
 * the id when there is one (it replaces the defaults), else `defaults`.
 */
export const keywordsOf = (
	view: { readonly labels: PartialLabels } | undefined,
	id: string,
	defaults: string[] | undefined
) => view?.labels.keywords?.[id] ?? defaults;
