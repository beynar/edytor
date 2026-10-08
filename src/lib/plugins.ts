import type { Snippet } from 'svelte';
import type { Edytor } from './edytor.svelte.js';
import type { Block } from './block/block.svelte.js';
import type { JSONBlock, JSONDoc, JSONInlineBlock, JSONText } from './utils/json.js';
import type { Text } from './text/text.svelte.js';
import type { TextTransform } from './surface/cells.js';
import type { SerializableContent } from './utils/json.js';
import type { HotKey, HotKeyCombination } from './session/keymap.js';
import type { TextOperations } from './text/text.utils.js';
import type { BlockOperations } from './block/block.utils.js';
import type { EdytorSelection } from './selection/selection.svelte.js';
import type { InlineBlock } from './block/inlineBlock.svelte.js';
import type { PlanEffect } from './crdt/edytor-doc.js';
import type { MarkEdge } from './session/editing/text.js';
import type { Prevent } from './utils.js';

/** What a placeholder function receives: the empty block's declared values. */
export type PlaceholderView = {
	type: string;
	data: Readonly<Record<string, unknown>>;
	focused: boolean;
	empty: boolean;
};

/** An empty block's placeholder text: one string, or one per block (`null`: none). */
export type Placeholder = string | ((view: PlaceholderView) => string | null);

/**
 * Represents the payload for mark snippets with generic serializable content.
 * @template D - The type of serializable content
 */
export type MarkSnippetPayload<D extends SerializableContent = SerializableContent> = {
	content: Snippet;
	mark: D;
	text: Text;
};

export type { Prevent };

/**
 * What a block snippet receives: declared
 * values read from the block's cell and the selection — reactive, never the
 * block's handle itself — plus the handle for document reads and commands.
 */
export type BlockView<D = Record<string, any>> = {
	readonly id: string;
	readonly type: string;
	readonly data: D;
	readonly selected: boolean;
	readonly focused: boolean;
	/**
	 * The block's id-only handle (non-reactive reads, commands); `undefined`
	 * in a suggestion's preview, which is no block of the document.
	 */
	readonly handle: Block | undefined;
	/** Marks inner chrome (a header, a toolbar) non-editable; the block element is the core's. */
	void: Block['void'];
};

/** The block element a kind declares: a tag, or a tag and attributes. */
export type BlockElement =
	| string
	| { tag: string; attributes?: Record<string, string | undefined> };

/**
 * Represents the payload for block snippets.
 * @template D - The block's data
 */
export type BlockSnippetPayload<D = Record<string, any>> = {
	block: BlockView<D>;
	content: Snippet;
	children: Snippet | null;
};

/**
 * Represents the payload for change operations on blocks and text.
 * Combines both text operations and block operations with prevention capability.
 */
export type ChangePayload = {
	block: Block;
	/**
	 * Veto the operation (and, with `cb`, run that in its place): records the
	 * veto and returns, so the hook runs to its end; the first call decides.
	 */
	prevent: Prevent;
	/**
	 * The prepared command's effect (blocks created, removed, merged, moved,
	 * retyped, text ranges written), on a command that is one document plan — a hook can refuse a command by what it would do.
	 */
	effect?: PlanEffect;
} & (
	| {
			[K in keyof TextOperations]: {
				operation: K;
				text: Text;
				payload: TextOperations[K];
			};
	  }[keyof TextOperations]
	| {
			[K in keyof BlockOperations]: {
				operation: K;
				payload: BlockOperations[K];
			};
	  }[keyof BlockOperations]
);

/**
 * What `onAfterOperation` receives: a {@link ChangePayload} without
 * `prevent` (the operation already ran). The `Omit` distributes over the
 * union, so `operation` still narrows `payload` (and `text`).
 */
export type AfterOperationPayload = ChangePayload extends infer C
	? C extends unknown
		? Omit<C, 'prevent'>
		: never
	: never;

/**
 * Function type for transforming content within a text block.
 */
export type ContentTransformer = (payload: {
	text: Text;
	block: Block;
	content: JSONText[];
}) => JSONText[];

/**
 * What an input rule's `replace` and a trigger's `onPick` receive: where the
 * matched text is, in block offsets (the offsets `edytor.document.facade`
 * takes, an inline atom counting 1).
 */
export type TextRuleContext = {
	edytor: Edytor;
	/** The block the text is in. */
	block: Block;
	/** Where the matched text starts. */
	from: number;
	/**
	 * Where it ends in the document: the caret, for an input rule (the typed
	 * text that completed the match is not written yet); the query's end, for
	 * a trigger.
	 */
	to: number;
	/** Set the command's result caret at `offset` of `block` (block offsets). */
	caret: (offset: number) => void;
};

/** What an input rule's `replace` receives besides the match. */
export type InputRuleContext = TextRuleContext & {
	/** The typed text that completed the match: part of the match, not in the document. */
	typed: string;
	/**
	 * Remove the matched text (`from` to `to`) in the same plan as the first
	 * operation `then` runs, so a refusal of either writes neither; without
	 * `then`, or when it runs no operation (and does not answer `false`),
	 * the text is removed on its own. Answers whether it was written.
	 */
	remove: (then?: () => unknown) => boolean;
};

/**
 * Text typed at a caret that matches `find` is replaced (`:smile:` → 😄,
 * `## ` → a heading): Notion's markdown and autoformat. Rules run for text
 * typed at a collapsed caret (one `insertText` at it, an IME's commit
 * excluded), in plugin order then list order; the first that writes wins.
 * They do not run in the lines of a code block.
 */
export type InputRule = {
	/**
	 * Tested on the caret's text segment up to the caret, followed by the
	 * typed text; a match must end at the typed text's end (end it with `$`).
	 * A segment starts after an inline atom, so `^` is a segment's start:
	 * read `from` for the block's start (`from === 0`).
	 */
	find: RegExp;
	/**
	 * The replacement. Return a string to replace the whole match with it
	 * (one command and one undo step with the matched text's removal; the
	 * caret after it), or write it yourself and return `true`, usually
	 * through `ctx.remove(() => …)`. Return `false` or `null`, writing
	 * nothing, to decline: the next rule is asked, then the typed text is
	 * inserted as usual, as it is when the replacement is refused (by the
	 * document, readonly or a plugin's veto).
	 */
	replace: (match: RegExpExecArray, ctx: InputRuleContext) => string | boolean | null | void;
};

/** What a trigger's `items` and `onPick` receive. */
export type TriggerContext = TextRuleContext & {
	/** The text typed after the trigger's `char`. */
	query: string;
};

/** One row of a trigger's menu, for an `item` snippet. */
export type TriggerItemPayload<T = unknown> = {
	item: T;
	/** The row's label (`label(item)`). */
	label: string;
	/** The row's element id: set it (`id={row.id}`) so the editor names the highlighted row. */
	id: string;
	/** It is the keyboard's row. */
	selected: boolean;
	/** Pick it. */
	pick: () => void;
	/** Make it the keyboard's row (hover). */
	select: () => void;
};

/**
 * A character typed at a text's start or after whitespace opens a menu at
 * the caret (`@` for people, `[[` for pages); the text typed after it is
 * the query. Picking a row replaces the trigger and its query (`onPick`).
 * The menu's keys are the editor's while it is open: <kbd>↑</kbd>/<kbd>↓</kbd>
 * move, <kbd>Enter</kbd> picks, <kbd>Escape</kbd> closes it and keeps the text.
 */
export type Trigger<T = any> = {
	/** The text that opens the menu (one or two characters: `@`, `[[`). */
	char: string;
	/** The rows for `query`, at once or as a promise (a search); the newest query wins. */
	items: (query: string, ctx: TriggerContext) => readonly T[] | Promise<readonly T[]>;
	/**
	 * Write the picked row: the trigger and its query (`from` to `to`) are
	 * removed in the same plan as the first operation it runs (one undo
	 * step; a refusal keeps them). Set the caret with `ctx.caret`. Return
	 * `false`, running nothing, to keep the text.
	 */
	onPick: (item: T, ctx: TriggerContext) => unknown;
	/** A row's label: default the item itself when it is a string, else its `label`, `title` or `name`. */
	label?: (item: T) => string;
	/** A row's key, which keeps its markup across queries: default its `id`, else its label. Two rows may share one. */
	key?: (item: T) => string;
	/** Replace each row's markup. */
	item?: Snippet<[TriggerItemPayload<T>]>;
	/** The menu's accessible name (default `Suggestions`). */
	name?: string;
	/** The text shown when no row matches (default `No results`). */
	empty?: string;
	/** The text shown while a search is pending and no row is shown (default `Searching…`). */
	searching?: string;
	/** Whether the menu may open in `block` (default: a block that is not void and not in a code block). */
	enabled?: (block: Block) => boolean;
};

/**
 * Defines the structure of plugin definitions including marks, blocks, inline blocks, and hotkeys.
 */
export type PluginDefinitions = {
	marks?: Record<string, MarkDefinition | Snippet<[MarkSnippetPayload<any>]>>;
	blocks?: Record<string, BlockDefinition | Snippet<[BlockSnippetPayload<any>]>>;
	inlineBlocks?: Record<string, InlineBlockDefinition | Snippet<[InlineBlockSnippetPayload<any>]>>;
	hotkeys?: Partial<Record<HotKeyCombination, HotKey>>;
	commands?: EditorCommand[];
	/** Text typed at the caret that a rule replaces (markdown, `:smile:` → 😄). */
	inputRules?: InputRule[];
	/** Characters that open a menu of rows at the caret (`@` mentions). */
	triggers?: Trigger[];
};

/**
 * Plugin factory function type that creates plugin definitions and operations.
 */
export type Plugin = (editor: Edytor) => PluginDefinitions & PluginOperations;

/**
 * Defines the available operations and hooks for plugins.
 */
export type PluginOperations = {
	/** Called before an operation is executed */
	onBeforeOperation?: <C extends ChangePayload>(payload: C) => C['payload'] | void;
	/**
	 * Called after an operation is executed: `dispatcher.last.status` is set
	 * (its `value`, what a handle mutator returns, is recorded after this
	 * hook); `operation` narrows `payload`.
	 */
	onAfterOperation?: (payload: AfterOperationPayload) => void;
	/** Called when the editor value changes: the same `JSONDoc` shape `<Edytor value>` takes. */
	onChange?: (value: JSONDoc) => void;
	/** Called when the selection changes */
	onSelectionChange?: (selection: EdytorSelection) => void;
	/** The placeholder of an empty block: rendered by a `::before` rule the library ships. */
	placeholder?: Placeholder;
	/** Called when the editor is attached to the DOM; may return a cleanup, run on detach. */
	onEdytorAttached?: (payload: { node: HTMLElement }) => (() => void) | void;
	/** Called when a block element is attached to the DOM; may return a cleanup. */
	onBlockAttached?: (payload: { node: HTMLElement; block: Block }) => (() => void) | void;
	/** Called when a text element is attached to the DOM; may return a cleanup. */
	onTextAttached?: (payload: { node: HTMLElement; text: Text }) => (() => void) | void;
	/**
	 * Before a block selection is removed: Backspace or Delete (a word or line
	 * delete too), a cut, the block menu's Delete, and typing, a composition
	 * or a paste over it. `selectedBlocks` are the blocks that go, in document
	 * order (`selection.selectedMembers`): the selected blocks, a selected
	 * list or code block with its whole subtree; a selected block's other
	 * unselected children are promoted. An unselected container (a list)
	 * left with no child goes too but is not listed (read the
	 * command's `effect.removes` in `onBeforeOperation`); a code block is an
	 * island and stays even when all its lines go. Enter, Shift+Enter and a
	 * drop remove nothing, so they never call it. `prevent()` keeps the
	 * blocks (and refuses the gesture).
	 */
	onDeleteSelectedBlocks?: (payload: { prevent: Prevent; selectedBlocks: Block[] }) => void;
	/** Called before input is processed */
	onBeforeInput?: (payload: { prevent: Prevent; e: InputEvent }) => void;
	/** Called when a copy event is detected */
	onCopy?: (payload: { prevent: Prevent; e: ClipboardEvent }) => void;
	/** Called when a cut event is detected */
	onCut?: (payload: { prevent: Prevent; e: ClipboardEvent }) => void;
	/** Called when a paste event is detected */
	onPaste?: (payload: { prevent: Prevent; e: ClipboardEvent }) => void;
};

/**
 * Defines the structure and behavior of a block type.
 */
export type BlockDefinition = {
	/** The markup inside the block element; a kind whose element takes no content (`hr`) has none. */
	snippet?: Snippet<[BlockSnippetPayload<any>]>;
	/**
	 * The element the core renders for the block: a tag, or tag and
	 * attributes, possibly from the block's data and id (the second argument:
	 * view state the kind keeps per block, such as a column's width while a
	 * resize drags; reactive state it reads re-renders the element; absent
	 * when HTML import reads a kind's tag for data alone). Default `div`.
	 */
	element?: BlockElement | ((data: Record<string, any>, id?: string) => BlockElement);
	/**
	 * The element the core wraps around the block's own text (`content()`),
	 * possibly from the block's data and id: a heading's `h1`–`h3`, a quote's
	 * `blockquote`. Children render outside it, and a snippet override keeps it.
	 */
	contentElement?: BlockElement | ((data: Record<string, any>, id?: string) => BlockElement);
	/**
	 * Attributes of the block element the browser or the user own (`open` on a
	 * `details`): declared view state, never inverted.
	 */
	viewState?: string[];
	/**
	 * A void kind (an image, a divider): one unit the editor never edits as
	 * text and never merges. The caret steps over it and a selection takes it
	 * whole. It displays no children: a retype to a void kind moves them right
	 * after it, and a child a collaborator puts under one shows in its place.
	 * Text it renders (a caption) stays editable. Adopted by the document as a
	 * role.
	 */
	void?: boolean;
	/**
	 * An island kind (a code block, a table): editable inside, structurally
	 * sealed. Nothing merges across its edge, and blocks cannot be moved in
	 * or out of it. Its children keep their kinds and nesting, unless `lines`
	 * says it holds only lines. Adopted by the document as a role.
	 */
	island?: boolean;
	/**
	 * An island of lines (the code block): each direct child shows as this
	 * kind's `defaultChild` and holds no children, even when an undo or a
	 * peer's edit puts another kind or a nested block there. Needs `island`
	 * and `defaultChild`. Leave it off for an island with structure (a table
	 * of rows of cells, a callout): its children keep their kinds and nesting.
	 */
	lines?: boolean;
	/**
	 * A layout (the columns plugin's `columns`): its `defaultChild` is its
	 * item kind (a column, a container that holds any block), shown side by
	 * side. It displays only its items, an empty item does not display, and a
	 * layout showing one item or none shows as that item's blocks (`layout.*`
	 * in the delete contract). Adopted by the document as a role.
	 */
	layout?: boolean;
	/**
	 * Data paths written as one value (`data.atomic`): a top-level key, or an
	 * array of keys for a nested one. Setting `block.data.link`, or a key
	 * inside it, writes the whole `link` as one property, so two people
	 * setting it at once never merge into a value neither wrote (one wins
	 * whole); elsewhere each key merges on its own. Adopted by the document as
	 * part of the kind's role: every view of a document, a headless one and
	 * the room must declare the same paths (`semanticsOf({ card: { atomic:
	 * ['link'] } })`).
	 */
	atomic?: readonly (string | readonly string[])[];
	/**
	 * Whether the snippet renders the block's own content (`content()`).
	 * Defaults to `true`; containers that render only their children
	 * declare `false` so no caret or endpoint lands in the unrendered slot.
	 * Adopted by the document; checked in development against the snippet.
	 */
	rendersContent?: boolean;
	/**
	 * A list-like kind (Notion's bullets, numbers, to-dos, toggles): Enter at
	 * the start or end of a non-empty block opens another block of this kind
	 * (with its first preset's data), and Enter in an empty one ends the run —
	 * it outdents under a parent of a continuing kind, else turns into the
	 * parent's default child in place (at the top level, in a callout).
	 */
	continues?: boolean;
	/**
	 * A container kind (Notion's toggles, callouts, quotes): its content is a
	 * header over its children. Enter at the end of a header with children
	 * opens a first child of `defaultChild`; a closed `details` header (the
	 * browser owns `open`) opens a sibling after instead, children untouched.
	 */
	container?: boolean;
	/**
	 * The type a new child of this block takes by default (Enter inside a
	 * child, a split, an island merged out into it). Adopted by the
	 * document; two extensions declaring different values is an error.
	 */
	defaultChild?: string;
	/**
	 * A list container's flat counterpart (`numbered-list-item` for an
	 * `ordered-list`): its items show as this kind, so the menus name them by
	 * it and turning one into it keeps it in the list.
	 */
	itemKind?: string;
	/**
	 * Catalogue rows: one per way to create this kind — the slash menu,
	 * markdown shortcuts and block menus are generated from them
	 * (`edytor.kinds`). Command ids are `block.<type>`, numbered from 1 when
	 * the kind has several presets (`block.heading2`).
	 */
	presets?: KindPreset[];
	/**
	 * The content and children a conversion into this kind creates (a void
	 * has none; an island starts with a first child). With it, a conversion
	 * turns only a block that holds nothing into this kind; a block with text
	 * or children stays intact and the new block is inserted after it.
	 * Without it a conversion keeps content and children.
	 */
	empty?: Pick<JSONBlock, 'content' | 'children'>;
	/**
	 * Clipboard HTML form: a tag wrapping content then children, or a
	 * function of the block and its serialized content and children.
	 * Default `<p>{content}</p>{children}`.
	 */
	html?: string | ((block: JSONBlock, content: string, children: string) => string);
	/** Clipboard plain-text form; default content then children, one per line. */
	plain?: (block: JSONBlock, content: string, children: string) => string;
	/**
	 * HTML import: the block's data when `element` is this kind, else
	 * `undefined`. Checked before the tag tables (a preset's export form or
	 * element tag), which need no hook.
	 */
	parse?: (element: HTMLElement) => Record<string, SerializableContent> | undefined;
	/** Transform text content within the block
	 *
	 * This transformation is applied after the text is synced in to the state.
	 *
	 * You can use it to render custom marks decorations on the text like code tokens that are not stored in the document.
	 * It receives declared values, not handles: the segment's `{stringContent, value}` and the block's `{id, type, data}`.
	 */
	transformText?: TextTransform;
	/** Called when the block receives focus */
	onFocus?: (payload: { block: Block }) => void;
	/** Called when the block loses focus */
	onBlur?: (payload: { block: Block }) => void;
	/** Called when the block is selected */
	onSelect?: (payload: { block: Block }) => void;
	/** Called when the block is deselected */
	onDeselect?: (payload: { block: Block }) => void;
	/** Normalize block content
	 * Called at the end of the transaction of each operation on the block: the
	 * block is an id-only handle whose reads show the operation's writes.
	 * If you return a function, it runs in the same transaction.
	 */
	normalizeContent?: (payload: { block: Block }) => (() => void) | void;
	/** Normalize block children
	 * Called at the end of the transaction of each operation on the block: the
	 * block is an id-only handle whose reads show the operation's writes.
	 * If you return a function, it runs in the same transaction.
	 */
	normalizeChildren?: (payload: { block: Block }) => (() => void) | void;
};

/** What an inline-atom snippet receives: declared values; a suggestion's atom is never selected. */
export type InlineBlockView<D = Record<string, any>> = {
	readonly id: string;
	readonly type: string;
	readonly data: D;
	readonly selected: boolean;
	/** The atom's id-only handle; a suggested atom has none. */
	readonly handle: InlineBlock | undefined;
};

export type InlineBlockSnippetPayload<D = Record<string, any>> = {
	block: InlineBlockView<D>;
};

export type InlineBlockDefinition = {
	snippet: Snippet<[InlineBlockSnippetPayload<any>]>;
	/** Clipboard plain-text form of the atom; default none. */
	plain?: (data: JSONInlineBlock['data']) => string;
	/**
	 * Clipboard HTML form of the atom (inline markup, escaped by you); default
	 * an empty `<span data-edytor-inline-block>`.
	 */
	html?: (data: JSONInlineBlock['data']) => string;
	/**
	 * HTML import: the atom's data when `element`, met in a line's inline
	 * content, is this atom, else `undefined`. Its contents are then not read
	 * as text.
	 */
	parse?: (element: HTMLElement) => Record<string, SerializableContent> | undefined;
};

export type MarkDefinition = {
	/** Custom markup inside a core `<span data-edytor-mark>`; without one the core renders `tag`. */
	snippet?: Snippet<[MarkSnippetPayload<any>]>;
	/**
	 * The mark's element: rendered by the core (`<tag data-edytor-mark>`),
	 * written by the clipboard's HTML export and read back by HTML import —
	 * one tag, so render and export cannot disagree. Marks wrap in
	 * registration order (first innermost); a mark without a tag exports its
	 * text only.
	 */
	tag?: string;
	/** The element's attributes from the mark's value (sanitized here); `undefined` omits one. */
	attributes?: (value: any) => Record<string, string | undefined>;
	/**
	 * HTML import: the mark's value when `element` carries it, else
	 * `undefined`. Checked before the tag; a mark without `attributes` also
	 * matches its bare `tag` (value `true`).
	 */
	parse?: (element: HTMLElement) => SerializableContent | undefined;
	void?: boolean;
	/** Whether typing at the mark's edges extends it (`marksForInsertion`); default `inclusive`. */
	edge?: MarkEdge;
	/** A selection-toolbar button toggling the mark. */
	toolbar?: { label: string; icon: string };
};

/** A way to create a block kind: one slash command, markdown prefixes, one block-menu row. */
export type KindPreset = {
	label: string;
	icon?: string;
	keywords?: string[];
	/** The new block's data. */
	data?: Record<string, SerializableContent>;
	/** Typed at the start of a block's first text, each converts it (the last character triggers). */
	markdown?: string[];
	/**
	 * Shortcuts that convert a block of another kind into this preset, by
	 * that kind, typed as `markdown` is: `{ toggle: ['# '] }` makes a toggle
	 * list a toggle heading. In a block of a named kind they come before
	 * every preset's `markdown`; when several presets answer one, the one
	 * whose data shares the most values with the block's wins (a heading's
	 * level stays).
	 */
	markdownFrom?: Record<string, string[]>;
	/** The slash menu section (default `Basic blocks`). */
	group?: string;
};

export type EditorCommand = {
	id: string;
	label: string;
	icon?: string;
	keywords?: string[];
	group?: string;
	/** A shortcut shown beside the label (a markdown prefix such as `##`). */
	hint?: string;
	isEnabled?: (edytor: Edytor) => boolean;
	run: (edytor: Edytor) => unknown | Promise<unknown>;
	/**
	 * Whether the block menu's Turn into offers the command over `blocks` (the
	 * block selection as clicked); the row runs it, over that selection (the
	 * columns plugin's `columns.<n>` over `n` sibling blocks wraps them).
	 */
	turnsInto?: (blocks: Block[]) => boolean;
};

export type InitializedPlugin = ReturnType<Plugin>;

// Extension-surface note (replaces stale TODOs): the gaps this used to
// list are all covered by the contract above —
//   * `onBeforeInput` is a PluginOperations hook (line ~111).
//   * Block focus/selection lifecycle is `onFocus`/`onBlur`/`onSelect`/
//     `onDeselect` on BlockDefinition.
//   * Arrow-key and select-all behavior are hotkeys, not dedicated
//     events: `mod+a` select-all lives in hotkeys.ts and arrow handling
//     ships in the arrowMove plugin — plugins can override either via
//     the `hotkeys` definition map (prevention is first-win).
// A dedicated raw-key event hook does not exist; add one only if a real
// consumer needs more than hotkey overrides.

// ISLAND BLOCKS
// Island blocks are blocks that are independent of the document.
// They are editable
// They can be nested inside other blocks
// But their children can not be nested or merged with other blocks
// Their structure will remain as if or will not.
// In case of a merge operation, the island block will be merged with the parent block and all its children will ne unnest and set to the default block type without being added as children of the merge destination block. The same wil happen to the island's content.

// VOID BLOCKS
// Void blocks are blocks that are not editable
// They can be nested inside other blocks
// They can not accept children nor be merged with other blocks
// If the content of the void block is rendered, it will still be editable. This to allow for rendering caption of the void block. I
// In void blocks the content is treated as an island
