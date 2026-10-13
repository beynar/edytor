/**
 * The demo chrome's words: what its menus, bars, panels and cards show and
 * say (the package's own words, the kinds' names and the document's, are
 * the view's `labels`). English by default; `setWords` replaces any entry
 * of any section (a nested group's entries alone), `setWords()` restores
 * English. The chrome reads `words` reactively.
 */

/** A byte count is the package's (`media.fileSize`); these are the chrome's. */
const english = {
	slashMenu: {
		filter: 'Type to filter…',
		filterLabel: 'Filter block commands',
		list: 'Block commands',
		noResults: 'No results',
		close: 'Close menu',
		closeKey: 'esc',
		/** A section heading, by its group key; others show as they are. */
		groups: {
			'Basic blocks': 'Basic blocks',
			'Advanced blocks': 'Advanced blocks',
			Media: 'Media',
			Layout: 'Layout',
			Color: 'Color',
			Inline: 'Inline'
		} as Record<string, string>
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
		/** A palette color's name, by its `PALETTE` name. */
		colors: {} as Record<string, string>,
		colorText: (color: string) => `${color} text`,
		colorBackground: (color: string) => `${color} background`,
		card: 'Link',
		open: 'Open',
		openLink: 'Open link in a new tab',
		edit: 'Edit',
		editLink: 'Edit link'
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
		noResults: 'No results'
	},
	blockHandles: {
		add: (kind: string) => `Add a block below ${kind} (Alt: above)`,
		addBeside: (kind: string) => `Add a block below ${kind} (Alt: a column to the right)`,
		addHint: 'Click to add below\nAlt-click to add a block above',
		addBesideHint: 'Click to add below\nAlt-click to add a column to the right',
		grip: (kind: string) => `${kind} block: drag to move, click for actions`
	},
	/** A trigger's menu: one that names nothing, the mention's, the page link's. */
	trigger: { menu: 'Suggestions', searching: 'Searching…', noResults: 'No results' },
	mention: { menu: 'People', searching: 'Searching…', noResults: 'No results' },
	pageLink: { menu: 'Pages', searching: 'Searching…', noResults: 'No results' },
	image: {
		image: 'Image',
		add: 'Add an image',
		link: 'Image link',
		linkPlaceholder: 'Paste the image link…',
		embed: 'Embed image',
		upload: 'Upload',
		tooLarge: (limit: string, upload: boolean) =>
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
			add: 'Embed a link',
			placeholder: 'Paste the link…',
			submit: 'Embed link',
			invalid: 'No embed provider plays that link.'
		},
		bookmark: {
			add: 'Add a web bookmark',
			placeholder: 'Paste the link…',
			submit: 'Create bookmark',
			invalid: "That doesn't look like a web link."
		},
		file: {
			add: 'Embed a file',
			/** The button when an upload is offered. */
			addOrUpload: 'Upload or embed a file',
			placeholder: 'Paste the file link…',
			submit: 'Embed link',
			invalid: "That doesn't look like a file link or upload."
		},
		video: {
			add: 'Embed a video',
			placeholder: 'Paste the video link…',
			submit: 'Embed video',
			invalid: "That doesn't look like a video link or upload."
		},
		audio: {
			add: 'Embed audio',
			placeholder: 'Paste the audio link…',
			submit: 'Embed audio',
			invalid: "That doesn't look like an audio link or upload."
		},
		upload: 'Upload',
		uploading: 'Uploading…',
		uploadFailed: 'The upload failed: try again or paste a link.'
	},
	/** The menu a URL pasted on an empty line opens, its rows by option id. */
	urlPaste: { menu: 'Paste as', link: 'Link', embed: 'Embed', bookmark: 'Bookmark' } as Record<
		string,
		string
	>,
	code: {
		language: 'Code language',
		search: 'Search for a language…',
		noResults: 'No results',
		copy: 'Copy',
		copied: 'Copied'
	},
	calloutIcons: { picker: 'Callout icons', remove: 'Remove icon' },
	find: {
		bar: 'Find in page',
		query: 'Find',
		queryPlaceholder: 'Find in page',
		noResults: 'No results',
		count: (current: number, total: number) => `${current}/${total}`,
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
		writing: (label: string | undefined) => `${label ?? 'AI'} is writing…`,
		accept: 'Accept',
		discard: 'Discard',
		retry: 'Try again',
		ctrl: 'Ctrl',
		escape: 'Esc'
	},
	comments: {
		placeholder: 'Add a comment…',
		reply: 'Reply…',
		post: 'Comment',
		cancel: 'Cancel',
		resolve: 'Resolve',
		reopen: 'Re-open',
		delete: 'Delete',
		resolvedBy: (name: string) => `Resolved by ${name}`,
		showResolved: (count: number) => `Resolved (${count})`,
		hideResolved: 'Hide resolved',
		you: 'You',
		when: (at: number) =>
			Number.isFinite(at)
				? new Intl.DateTimeFormat('en', {
						month: 'short',
						day: 'numeric',
						hour: 'numeric',
						minute: '2-digit'
					}).format(at)
				: '',
		failed: 'Could not save the comment. Try again.'
	},
	table: {
		insertAbove: 'Insert above',
		insertBelow: 'Insert below',
		insertLeft: 'Insert left',
		insertRight: 'Insert right',
		moveUp: 'Move up',
		moveDown: 'Move down',
		moveLeft: 'Move left',
		moveRight: 'Move right',
		deleteRow: 'Delete row',
		deleteColumn: 'Delete column',
		addRow: 'Add a row',
		addColumn: 'Add a column',
		rowMenu: 'Row options',
		columnMenu: 'Column options'
	} as Record<string, string>,
	equation: { editor: 'Equation', placeholder: 'E = mc^2', done: 'Done' },
	history: {
		title: 'Version history',
		versions: 'Versions',
		morning: 'Morning',
		evening: 'Evening',
		loading: 'Loading…',
		empty: 'No versions yet. A version is saved twice a day while the page changes.',
		noEditors: 'No editors',
		moreEditors: (count: number) => `+${count}`,
		saved: 'Saved',
		preview: 'Version preview',
		choose: 'Choose a version to preview it.',
		highlight: 'Highlight changes',
		added: (count: number) => `${count} added since`,
		removed: (count: number) => `${count} removed since`,
		changed: (count: number) => `${count} changed since`,
		same: 'Same as the current page',
		restore: 'Restore version',
		/** A status (`VersionHistoryStatus`) as said. */
		restoring: 'Restoring…',
		undo: 'Undo restore',
		restored: 'Version restored.',
		unchanged: 'The page already matches this version.',
		unavailable: 'This version is no longer available.',
		undone: 'Restore undone.',
		nothingToUndo: 'There is no restore to undo.',
		denied: 'You do not have access to this history.',
		failed: 'The history could not be reached.'
	},
	/** The starter editor's page: cover, icon, title and properties (`edytor/starter`). */
	starter: {
		page: 'Page',
		content: 'Page content',
		addIcon: 'Add icon',
		addCover: 'Add cover',
		changeCover: 'Change cover',
		reposition: 'Reposition',
		savePosition: 'Save position',
		positionHint: 'Drag the image, or use the up and down arrow keys',
		coverMenu: 'Cover options',
		icon: 'Page icon',
		iconMenu: 'Icon options',
		emojis: 'Emoji',
		upload: 'Upload',
		uploading: 'Uploading…',
		link: 'Link',
		linkPlaceholder: 'Paste an image link…',
		apply: 'Apply',
		remove: 'Remove',
		close: 'Close',
		title: 'Page title',
		untitled: 'Untitled',
		properties: 'Page properties',
		addProperty: 'Add a property',
		hideProperty: (name: string) => `Hide ${name}`,
		showProperty: (name: string) => `Show ${name}`,
		hiddenProperties: (count: number) =>
			count === 1 ? '1 hidden property' : `${count} hidden properties`,
		search: 'Search…',
		noOptions: 'No options',
		pickDate: 'Pick a date',
		clear: 'Clear',
		empty: 'Empty',
		pick: 'Select an option',
		yes: 'Yes',
		no: 'No',
		removeValue: (name: string) => `Remove ${name}`
	}
};

export type ChromeWords = typeof english;

/** The English words (a copy is `words` until `setWords`). */
export const englishWords: ChromeWords = english;

/** The entries of each section to replace (a nested group's entries alone). */
export type PartialChromeWords = {
	[K in keyof ChromeWords]?: {
		[P in keyof ChromeWords[K]]?: ChromeWords[K][P] extends (...args: never[]) => unknown
			? ChromeWords[K][P]
			: ChromeWords[K][P] extends object
				? Partial<ChromeWords[K][P]>
				: ChromeWords[K][P];
	};
};

/** The chrome's words now (reactive). */
export const words: ChromeWords = $state(structuredCloneWords(english));

/** A copy of `source` (its functions shared). */
function structuredCloneWords<T>(source: T): T {
	if (typeof source !== 'object' || source === null) return source;
	return Object.fromEntries(
		Object.entries(source).map(([key, value]) => [key, structuredCloneWords(value)])
	) as T;
}

/** Replace any entry of `words` (`partial`'s nested groups merged); none: English again. */
export const setWords = (partial?: PartialChromeWords) => {
	const fresh = structuredCloneWords(english) as Record<string, Record<string, unknown>>;
	for (const [section, entries] of Object.entries(partial ?? {}))
		for (const [key, value] of Object.entries(entries ?? {})) {
			const own = fresh[section]![key];
			fresh[section]![key] =
				own && typeof own === 'object' && value && typeof value === 'object'
					? { ...own, ...value }
					: value;
		}
	Object.assign(words, fresh);
};
