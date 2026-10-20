/**
 * The starter editor's public types: its props, the page's stored shape,
 * the properties schema and the theme (`edytor/starter`).
 */
import type { Snippet } from 'svelte';
import type {
	AudioPluginOptions,
	BlockHandlesOptions,
	BlockMenuOptions,
	BookmarkPluginOptions,
	CalloutIconsOptions,
	CodePluginOptions,
	CommentsClient,
	CommentsPluginOptions,
	EdytorInstance,
	EdytorProps,
	EmbedPluginOptions,
	EquationPluginOptions,
	FilePluginOptions,
	FindPluginOptions,
	ImagePluginOptions,
	MarqueePluginOptions,
	MentionItem,
	MentionPluginOptions,
	PageLinkItem,
	PageLinkPluginOptions,
	Plugin,
	RichTextPluginOptions,
	SlashMenuOptions,
	TablePluginOptions,
	ToolbarOptions,
	Uploader,
	VideoPluginOptions
} from 'edytor';

/** A person the `person` properties and `@` mentions pick from (a mention item). */
export type StarterPerson = MentionItem;

/** One option of a `select` or `multi-select` property. */
export type StarterPropertyOption = {
	/** What the document stores. */
	value: string;
	/** What the page shows (default `value`). */
	label?: string;
	/** A block colour name (`gray`, `brown`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `red`). */
	color?: string;
};

/**
 * The kinds of page properties. A `date` is stored as ISO `YYYY-MM-DD` and
 * shown in the editor's `locale`.
 */
export type StarterPropertyType =
	| 'text'
	| 'number'
	| 'select'
	| 'multi-select'
	| 'date'
	| 'checkbox'
	| 'url'
	| 'person';

/** One page property of the `properties` schema. */
export type StarterProperty = {
	/** The key of its value in the document's `properties`. */
	id: string;
	type: StarterPropertyType;
	/** What the page shows (default `id`). */
	name?: string;
	/** A short icon (an emoji or a character) before the name. */
	icon?: string;
	/** A `select` or `multi-select` property's options. */
	options?: readonly StarterPropertyOption[];
	/** Shown only once a user adds it (default `false`: shown). */
	hidden?: boolean;
	/** Users may hide it (default `true`, when the editor's `editableProperties` allows it). */
	removable?: boolean;
	/** The field's placeholder (default the words' `empty`). */
	placeholder?: string;
};

/** A property's value as stored: a string, a number, a boolean or a list of strings. */
export type StarterPropertyValue = string | number | boolean | string[] | null;

/** The page around the blocks, in the document's data (`edytor.data`). */
export type StarterPageData = {
	title?: string;
	/** An emoji, or an image URL. */
	icon?: { emoji: string } | { url: string };
	/** The cover's image URL and its vertical position, 0 (top) to 100 (bottom). */
	cover?: { url: string; position?: number };
	/** The properties' values by id. */
	properties?: Record<string, StarterPropertyValue>;
	/** A property a user added (`true`) or hid (`false`), over its schema's `hidden`. */
	shownProperties?: Record<string, boolean>;
};

/** Each bundled plugin's options, by its key in `plugins`. */
export type StarterPluginOptions = {
	richText: RichTextPluginOptions;
	code: CodePluginOptions;
	table: TablePluginOptions;
	columns: true;
	image: ImagePluginOptions;
	file: FilePluginOptions;
	video: VideoPluginOptions;
	audio: AudioPluginOptions;
	embed: EmbedPluginOptions;
	bookmark: BookmarkPluginOptions;
	equation: EquationPluginOptions;
	mention: Partial<MentionPluginOptions>;
	pageLink: Partial<PageLinkPluginOptions>;
	toc: true;
	markdownShortcuts: true;
	find: FindPluginOptions;
	marquee: MarqueePluginOptions;
	arrowMove: true;
	placeholder: true;
	blockHandles: BlockHandlesOptions;
	blockMenu: BlockMenuOptions;
	slashMenu: SlashMenuOptions;
	toolbar: ToolbarOptions;
	comments: Partial<Omit<CommentsPluginOptions, 'client'>>;
	calloutIcons: CalloutIconsOptions;
	imageToolbar: true;
	mediaEmpty: true;
	suggestions: true;
	suggestionBar: true;
	sharedSuggestions: true;
};

/**
 * Which bundled plugins the editor lists, and their options: `false` leaves
 * one out, `true` (or absent) lists it with the starter's options, an
 * object lists it with these options over the starter's (a chrome snippet
 * among them: `{ slashMenu: { menu } }`).
 */
export type StarterPlugins = {
	[K in keyof StarterPluginOptions]?: boolean | StarterPluginOptions[K];
};

/** What the cover snippet gets. */
export type StarterCoverPayload = {
	cover: StarterPageData['cover'];
	/** Set (a URL, a position) or remove (`undefined`) the cover: one undo step. */
	set: (cover: StarterPageData['cover']) => void;
	readonly: boolean;
	upload?: Uploader;
};

/** What the icon snippet gets. */
export type StarterIconPayload = {
	icon: StarterPageData['icon'];
	/** Set or remove (`undefined`) the icon: one undo step. */
	set: (icon: StarterPageData['icon']) => void;
	readonly: boolean;
	upload?: Uploader;
};

/** What the title snippet gets. */
export type StarterTitlePayload = {
	title: string;
	set: (title: string) => void;
	/** Put the caret at the start of the first block. */
	enter: () => void;
	readonly: boolean;
};

/** What a property cell snippet gets. */
export type StarterPropertyCellPayload = {
	property: StarterProperty;
	/** Its value (`undefined`: none). */
	value: StarterPropertyValue | undefined;
	/** Write the value (`undefined`, `null`, `''` or `[]` removes it): one undo step. */
	set: (value: StarterPropertyValue | undefined) => void;
	readonly: boolean;
	people: readonly StarterPerson[];
	/** The id of the property's name, for `aria-labelledby`. */
	labelId: string;
	/** The locale a date is shown in. */
	locale: string;
};

/** What the properties snippet gets: the whole block under the title. */
export type StarterPropertiesPayload = {
	/** The properties shown, in schema order. */
	shown: readonly StarterProperty[];
	/** The schema's properties a user may add. */
	addable: readonly StarterProperty[];
	/** The properties not shown (hidden by the schema or a user), in schema order: their values are kept. */
	hidden: readonly StarterProperty[];
	values: Record<string, StarterPropertyValue>;
	set: (id: string, value: StarterPropertyValue | undefined) => void;
	show: (id: string) => void;
	hide: (id: string) => void;
	readonly: boolean;
	/** Users may add and hide properties here (editable, and `editableProperties`). */
	editable: boolean;
	people: readonly StarterPerson[];
	/** The default cell of a property (or the `propertyCells` snippet of its type). */
	cell: Snippet<[StarterProperty]>;
	/** The id of a property's name element, which its cell is labelled by. */
	labelId: (id: string) => string;
};

/** A page part: `false` hides it, a snippet replaces its markup. */
export type StarterPart<T> = boolean | Snippet<[T]>;

export type StarterEditorProps = Omit<EdytorProps, 'plugins' | 'edytor'> & {
	/** The bundled plugins on or off, and their options. */
	plugins?: StarterPlugins;
	/** Your own plugins, listed before the bundled ones (their kinds and keys win). */
	extraPlugins?: Plugin[];
	/** Stores an image, file, video or audio a user adds, and the cover and icon they upload. */
	upload?: Uploader;
	/** The people of `person` properties and `@` mentions. */
	people?: readonly StarterPerson[];
	/** The pages `[[` links to; the page link plugin is listed only with them (or its own `search`). */
	pages?: readonly PageLinkItem[];
	cover?: StarterPart<StarterCoverPayload>;
	icon?: StarterPart<StarterIconPayload>;
	title?: StarterPart<StarterTitlePayload>;
	/** The page's properties; none: no properties block. */
	properties?: readonly StarterProperty[];
	/** Users may add the schema's hidden properties and hide the removable ones (default `true`). */
	editableProperties?: boolean;
	/** Replaces the whole properties block. */
	propertyList?: Snippet<[StarterPropertiesPayload]>;
	/** Replaces the cell of each property of a type. */
	propertyCells?: Partial<Record<StarterPropertyType, Snippet<[StarterPropertyCellPayload]>>>;
	/**
	 * The comment threads' store: `createMemoryCommentsClient()` locally, the
	 * room's client (`createCommentsClient`) with a server. None (or `false`):
	 * no comments.
	 */
	comments?: CommentsClient | false;
	/** The current user's id among `people` (the comments' author; default the first person). */
	user?: string;
	/** The locale dates are shown in (default `en-US`; the same on the server and in the browser). */
	locale?: string;
	/** The editor instance, once it exists. */
	edytor?: EdytorInstance;
	/** A class on the starter's root element (`class` is the editing host's). */
	rootClass?: string;
	/**
	 * The review controls above the blocks (default `true`, with the
	 * `sharedSuggestions` plugin on): the Editing / Suggesting switch (a user
	 * who may only suggest stays suggesting), and Accept all and Reject all
	 * while shared suggestions are pending.
	 */
	review?: boolean;
};
