/**
 * The words the editor's chrome shows or says: one dictionary section per
 * bundled plugin, plus `editor` for the view itself (announcements, a
 * suggestion's name). English is the default; each plugin factory takes a
 * `labels` option with the entries to replace (`PartialLabels`), and
 * `<Edytor labels>` takes the `editor` section.
 *
 * A label that says something about a value is a function of it, so a
 * language can order and inflect the words: `moved: (what) => …`.
 *
 * Group names (`KindPreset.group`: `Basic blocks`, `Advanced blocks`,
 * `Media`, `Layout`), the toolbar's color names (`TOOLBAR_COLORS`) and the
 * block palette's (`BLOCK_COLORS`, and `default`) are keys: the slash menu's
 * `groups`, the toolbar's `colors` and the block menu's `colors` map them to
 * what is shown.
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

/** The rich text kinds and marks: menu rows, toolbar buttons, placeholders. */
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
	/** The toolbar's mark buttons. */
	marks: { bold: string; italic: string; underline: string; strike: string; code: string };
	/** A to-do's checkbox. */
	checkbox: string;
	/** `createRichTextPlaceholder`'s texts. */
	placeholders: {
		heading: (level: 1 | 2 | 3) => string;
		toggleHeading: (level: 1 | 2 | 3) => string;
		list: string;
		todo: string;
		toggle: string;
		quote: string;
		/** A focused empty callout. */
		callout: string;
		/** A focused empty caption (image, embed, bookmark, file, video, audio). */
		caption: string;
		/** A focused empty block of any other kind. */
		empty: string;
	};
};

export type ToolbarLabels = {
	/** The bar's accessible name. */
	bar: string;
	/** The kind button when the selection's kind has no label. */
	text: string;
	turnInto: string;
	link: string;
	/** The link field's accessible name. */
	linkUrl: string;
	linkPlaceholder: string;
	apply: string;
	applyLink: string;
	remove: string;
	removeLink: string;
	color: string;
	textColor: string;
	backgroundColor: string;
	/** A color's name, by its `TOOLBAR_COLORS` name. */
	colors: Record<string, string>;
	/** A text color swatch, from the color's name. */
	colorText: (color: string) => string;
	/** A background swatch, from the color's name. */
	colorBackground: (color: string) => string;
	/** The card under a hovered link. */
	card: string;
	open: string;
	openLink: string;
	edit: string;
	editLink: string;
};

export type SlashMenuLabels = {
	/** The `+` menu's field. */
	filter: string;
	filterLabel: string;
	/** The list's accessible name. */
	list: string;
	noResults: string;
	close: string;
	/** The key shown beside Close. */
	closeKey: string;
	/** A section heading, by its group key (`Basic blocks`, `Advanced blocks`, `Media`, `Layout`); others show as they are. */
	groups: Record<string, string>;
};

export type BlockMenuLabels = {
	search: string;
	searchLabel: string;
	/** The menu's accessible name. */
	menu: string;
	/** The heading when the block's kind has no label. */
	block: string;
	turnInto: string;
	/** The Color row, and its flyout's accessible name. */
	color: string;
	/** The flyout's sections. */
	textColor: string;
	backgroundColor: string;
	/** A color's name, by its `BLOCK_COLORS` name (`red`), `default` for none. */
	colors: Record<string, string>;
	/** A text color row, from the color's name ("Red text"). */
	colorText: (color: string) => string;
	/** A background row, from the color's name ("Red background"). */
	colorBackground: (color: string) => string;
	copyLink: string;
	duplicate: string;
	moveUp: string;
	moveDown: string;
	delete: string;
	noResults: string;
	/** Key names in the shortcuts shown off a Mac. */
	ctrl: string;
	shift: string;
	deleteKey: string;
};

export type BlockHandlesLabels = {
	/** The `+`'s accessible name, from its block's kind. */
	add: (kind: string) => string;
	/** The same, for a block directly in a column (Alt adds a column). */
	addBeside: (kind: string) => string;
	/** The `+`'s tooltip. */
	addHint: string;
	addBesideHint: string;
	/** The grip's accessible name, from its block's kind. */
	grip: (kind: string) => string;
};

export type ImageLabels = {
	/** The preset, and a readonly empty image. */
	image: string;
	add: string;
	link: string;
	linkPlaceholder: string;
	embed: string;
	upload: string;
	uploading: string;
	/** An inline image over the size limit (`limit`, in words); `upload`: an upload is offered. */
	tooLarge: (limit: string, upload: boolean) => string;
	uploadFailed: string;
	invalid: string;
	/** The chrome's toolbar name. */
	toolbar: string;
	alignLeft: string;
	alignCenter: string;
	alignRight: string;
	alt: string;
	altPlaceholder: string;
};

/** One media kind's empty block and menu row. */
export type MediaKindLabels = {
	/** The preset. */
	label: string;
	/** The empty block's button. */
	add: string;
	placeholder: string;
	submit: string;
	invalid: string;
};

export type MediaLabels = {
	embed: MediaKindLabels & {
		/** The row a pasted link offers. */
		offer: string;
	};
	bookmark: MediaKindLabels & { offer: string };
	file: MediaKindLabels & {
		/** The button when an upload is offered. */
		addOrUpload: string;
	};
	video: MediaKindLabels;
	audio: MediaKindLabels;
	upload: string;
	/** A file's size, in bytes. */
	fileSize: (bytes: number) => string;
	/** The menu a pasted link opens. */
	pasteAs: string;
	/** Its row keeping the link. */
	pasteLink: string;
};

export type CodeLabels = {
	/** The preset. */
	code: string;
	/** The language picker's name. */
	language: string;
	copy: string;
	copied: string;
	/** A language's label, by id, over the language list's own. */
	languages: Record<string, string>;
};

export type FindLabels = {
	/** The bar's accessible name. */
	bar: string;
	query: string;
	queryPlaceholder: string;
	noResults: string;
	/** The current match and the count. */
	count: (current: number, total: number) => string;
	matchCase: string;
	previous: string;
	previousHint: string;
	next: string;
	nextHint: string;
	close: string;
	closeHint: string;
	replaceWith: string;
	replace: string;
	replaceAll: string;
};

export type SuggestionsLabels = {
	/** A suggestion's name when it has no `label`. */
	suggestion: string;
	/** While it streams, from its `label`. */
	writing: (label: string | undefined) => string;
	accept: string;
	discard: string;
	retry: string;
	/** Key names in the hints. */
	ctrl: string;
	escape: string;
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

/** The `[[` page link menu and atom (`createPageLinkPlugin`). */
export type PageLinkLabels = {
	/** The menu's accessible name. */
	menu: string;
	/** The menu while a search is pending, with no rows. */
	searching: string;
	noResults: string;
	/** An atom whose page has no title. */
	untitled: string;
};

export type ColumnsLabels = {
	/** The `columns.<n>` command. */
	columns: (count: number) => string;
	/** A resize band's accessible name. */
	resize: string;
};

/** The comments plugin (`createCommentsPlugin`): its toolbar button, sidebar and composer. */
export type CommentsLabels = {
	/** The toolbar button and the sidebar's accessible name. */
	comment: string;
	/** The sidebar's accessible name. */
	sidebar: string;
	/** The new thread's field. */
	placeholder: string;
	/** A thread's reply field. */
	reply: string;
	/** The button posting a new thread or a reply. */
	post: string;
	cancel: string;
	resolve: string;
	reopen: string;
	delete: string;
	/** A resolved thread's line, with who resolved it. */
	resolvedBy: (name: string) => string;
	/** The button showing the resolved threads, with their count. */
	showResolved: (count: number) => string;
	hideResolved: string;
	/** The current user, in place of their name. */
	you: string;
	/** When a comment was written (ms since the epoch). */
	when: (at: number) => string;
	/** A request the server refused or could not answer. */
	failed: string;
};

/** Every section of the dictionary. */
export type Labels = {
	editor: EditorLabels;
	richText: RichTextLabels;
	toolbar: ToolbarLabels;
	slashMenu: SlashMenuLabels;
	blockMenu: BlockMenuLabels;
	blockHandles: BlockHandlesLabels;
	image: ImageLabels;
	media: MediaLabels;
	code: CodeLabels;
	find: FindLabels;
	suggestions: SuggestionsLabels;
	columns: ColumnsLabels;
	page: PageLabels;
	toc: TocLabels;
	pageLink: PageLinkLabels;
	comments: CommentsLabels;
};

/**
 * The entries of section `K` to replace: any of them, and any entry of a
 * nested group (`placeholders`, `groups`, a media kind) without the others.
 */
export type PartialLabels<K extends keyof Labels> = {
	[P in keyof Labels[K]]?: Labels[K][P] extends (...args: never[]) => unknown
		? Labels[K][P]
		: Labels[K][P] extends object
			? Partial<Labels[K][P]>
			: Labels[K][P];
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

/**
 * The English dictionary: the default of every section. Frozen: start
 * yours from a copy (`{ ...englishLabels.toolbar, link: '…' }`).
 */
export const englishLabels: Labels = frozen({
	editor: {
		suggestion: 'Suggestion',
		block: (kind) => `${kind} block`,
		blocks: (count) => `${count} blocks`,
		movedUp: (what) => `Moved ${what} up`,
		movedDown: (what) => `Moved ${what} down`,
		indented: (what) => `Indented ${what}`,
		outdented: (what) => `Outdented ${what}`,
		moved: (what) => `Moved ${what}`,
		deleted: (what) => `Deleted ${what}`
	},
	richText: {
		kinds: {
			paragraph: 'Text',
			heading1: 'Heading 1',
			heading2: 'Heading 2',
			heading3: 'Heading 3',
			toggleHeading1: 'Toggle heading 1',
			toggleHeading2: 'Toggle heading 2',
			toggleHeading3: 'Toggle heading 3',
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
		placeholders: {
			heading: (level) => `Heading ${level}`,
			toggleHeading: (level) => `Toggle heading ${level}`,
			list: 'List',
			todo: 'To-do',
			toggle: 'Toggle',
			quote: 'Empty quote',
			callout: 'Type something…',
			caption: 'Write a caption…',
			empty: "Type '/' for commands"
		}
	},
	toolbar: {
		bar: 'Text formatting',
		text: 'Text',
		turnInto: 'Turn into',
		link: 'Link',
		linkUrl: 'Link URL',
		linkPlaceholder: 'Paste link',
		apply: 'Apply',
		applyLink: 'Apply link',
		remove: 'Remove',
		removeLink: 'Remove link',
		color: 'Color',
		textColor: 'Text color',
		backgroundColor: 'Background color',
		colors: {
			Default: 'Default',
			Gray: 'Gray',
			Brown: 'Brown',
			Orange: 'Orange',
			Yellow: 'Yellow',
			Green: 'Green',
			Blue: 'Blue',
			Purple: 'Purple',
			Pink: 'Pink',
			Red: 'Red'
		},
		colorText: (color) => `${color} text`,
		colorBackground: (color) => `${color} background`,
		card: 'Link',
		open: 'Open',
		openLink: 'Open link in a new tab',
		edit: 'Edit',
		editLink: 'Edit link'
	},
	slashMenu: {
		filter: 'Type to filter…',
		filterLabel: 'Filter block commands',
		list: 'Block commands',
		noResults: 'No results',
		close: 'Close menu',
		closeKey: 'esc',
		groups: {
			'Basic blocks': 'Basic blocks',
			'Advanced blocks': 'Advanced blocks',
			Media: 'Media',
			Layout: 'Layout'
		}
	},
	blockMenu: {
		search: 'Search actions…',
		searchLabel: 'Search actions',
		menu: 'Block actions',
		block: 'Block',
		turnInto: 'Turn into',
		color: 'Color',
		textColor: 'Text color',
		backgroundColor: 'Background color',
		colors: {
			default: 'Default',
			gray: 'Gray',
			brown: 'Brown',
			orange: 'Orange',
			yellow: 'Yellow',
			green: 'Green',
			blue: 'Blue',
			purple: 'Purple',
			pink: 'Pink',
			red: 'Red'
		},
		colorText: (color) => `${color} text`,
		colorBackground: (color) => `${color} background`,
		copyLink: 'Copy link to block',
		duplicate: 'Duplicate',
		moveUp: 'Move up',
		moveDown: 'Move down',
		delete: 'Delete',
		noResults: 'No results',
		ctrl: 'Ctrl',
		shift: 'Shift',
		deleteKey: 'Del'
	},
	blockHandles: {
		add: (kind) => `Add a block below ${kind} (Alt: above)`,
		addBeside: (kind) => `Add a block below ${kind} (Alt: a column to the right)`,
		addHint: 'Click to add below\nAlt-click to add a block above',
		addBesideHint: 'Click to add below\nAlt-click to add a column to the right',
		grip: (kind) => `${kind} block: drag to move, click for actions`
	},
	image: {
		image: 'Image',
		add: 'Add an image',
		link: 'Image link',
		linkPlaceholder: 'Paste the image link…',
		embed: 'Embed image',
		upload: 'Upload',
		uploading: 'Uploading…',
		tooLarge: (limit, upload) =>
			`Inline images are limited to ${limit}: ${upload ? 'upload the file instead' : 'host the image and paste its link'}.`,
		uploadFailed: 'The upload failed: try again or paste a link.',
		invalid: "That doesn't look like an image link or upload.",
		toolbar: 'Image',
		alignLeft: 'Align left',
		alignCenter: 'Align center',
		alignRight: 'Align right',
		alt: 'Alt text',
		altPlaceholder: 'Describe the image…'
	},
	media: {
		embed: {
			label: 'Embed',
			offer: 'Embed',
			add: 'Embed a link',
			placeholder: 'Paste the link…',
			submit: 'Embed link',
			invalid: 'No embed provider plays that link.'
		},
		bookmark: {
			label: 'Web bookmark',
			offer: 'Bookmark',
			add: 'Add a web bookmark',
			placeholder: 'Paste the link…',
			submit: 'Create bookmark',
			invalid: "That doesn't look like a web link."
		},
		file: {
			label: 'File',
			add: 'Embed a file',
			addOrUpload: 'Upload or embed a file',
			placeholder: 'Paste the file link…',
			submit: 'Embed link',
			invalid: "That doesn't look like a file link or upload."
		},
		video: {
			label: 'Video',
			add: 'Embed a video',
			placeholder: 'Paste the video link…',
			submit: 'Embed video',
			invalid: "That doesn't look like a video link or upload."
		},
		audio: {
			label: 'Audio',
			add: 'Embed audio',
			placeholder: 'Paste the audio link…',
			submit: 'Embed audio',
			invalid: "That doesn't look like an audio link or upload."
		},
		upload: 'Upload',
		fileSize: bytes,
		pasteAs: 'Paste as',
		pasteLink: 'Link'
	},
	code: {
		code: 'Code',
		language: 'Code language',
		copy: 'Copy',
		copied: 'Copied',
		languages: {}
	},
	find: {
		bar: 'Find in page',
		query: 'Find',
		queryPlaceholder: 'Find in page',
		noResults: 'No results',
		count: (current, total) => `${current}/${total}`,
		matchCase: 'Match case',
		previous: 'Previous match',
		previousHint: 'Previous match (Shift+Enter)',
		next: 'Next match',
		nextHint: 'Next match (Enter)',
		close: 'Close',
		closeHint: 'Close (Escape)',
		replaceWith: 'Replace with',
		replace: 'Replace',
		replaceAll: 'Replace all'
	},
	suggestions: {
		suggestion: 'Suggestion',
		writing: (label) => `${label ?? 'AI'} is writing…`,
		accept: 'Accept',
		discard: 'Discard',
		retry: 'Try again',
		ctrl: 'Ctrl',
		escape: 'Esc'
	},
	columns: {
		columns: (count) => `${count} columns`,
		resize: 'Resize columns'
	},
	page: {
		page: 'Page',
		untitled: 'Untitled'
	},
	toc: {
		toc: 'Table of contents',
		untitled: 'Untitled',
		empty: 'Add headings to create a table of contents.'
	},
	pageLink: {
		menu: 'Pages',
		searching: 'Searching…',
		noResults: 'No results',
		untitled: 'Untitled'
	},
	comments: {
		comment: 'Comment',
		sidebar: 'Comments',
		placeholder: 'Add a comment…',
		reply: 'Reply…',
		post: 'Comment',
		cancel: 'Cancel',
		resolve: 'Resolve',
		reopen: 'Re-open',
		delete: 'Delete',
		resolvedBy: (name) => `Resolved by ${name}`,
		showResolved: (count) => `Resolved (${count})`,
		hideResolved: 'Hide resolved',
		you: 'You',
		when: (at) =>
			Number.isFinite(at)
				? new Intl.DateTimeFormat('en', {
						month: 'short',
						day: 'numeric',
						hour: 'numeric',
						minute: '2-digit'
					}).format(at)
				: '',
		failed: 'Could not save the comment. Try again.'
	}
});

/**
 * Section `section` of the dictionary with `overrides` over the English one:
 * an entry replaces its English entry, a nested group's entries replace
 * only theirs.
 */
export const labelsWith = <K extends keyof Labels>(
	section: K,
	overrides: PartialLabels<K> | undefined
): Labels[K] => {
	const base = englishLabels[section] as Record<string, unknown>;
	if (!overrides) return base as Labels[K];
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) continue;
		const own = base[key];
		merged[key] = isGroup(own) && isGroup(value) ? { ...own, ...value } : value;
	}
	return merged as Labels[K];
};

/**
 * The keywords of command `id`: `overrides`' entry for it when there is one
 * (it replaces the defaults: list the English ones in it to keep them),
 * else `defaults`.
 */
export const keywordsOf = (
	id: string,
	defaults: string[] | undefined,
	overrides: Partial<Record<string, string[]>> | undefined
) => overrides?.[id] ?? defaults;

/**
 * One plugin's labels per view: the first plugin of its kind listed in a
 * view claims them, as its kind records (first wins); its components read
 * them through the view they render in, English when none claimed them.
 */
export const viewLabels = <K extends keyof Labels>(section: K) => {
	const claimed = new WeakMap<object, Labels[K]>();
	return {
		/** `labels` for `view`, unless a plugin listed before claimed it. */
		claim: (view: object | undefined, labels: Labels[K]) => {
			if (view && !claimed.has(view)) claimed.set(view, labels);
		},
		/** The labels of `view` (English for none, or a view no plugin claimed). */
		of: (view: object | undefined): Labels[K] =>
			(view && claimed.get(view)) || englishLabels[section]
	};
};
