import type { Snippet } from 'svelte';
import type { Edytor } from './edytor.svelte.js';
import type { Block } from './block/block.svelte.js';
import type { JSONBlock, JSONInlineBlock, JSONText } from './utils/json.js';
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

/** What a placeholder function receives (D-8): the empty block's declared values. */
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

/**
 * Function type for preventing default behavior with an optional callback.
 */
type Prevent = (cb?: () => void) => void;

/**
 * What a block snippet receives (R4, §2.4 "Snippet view objects"): declared
 * values read from the block's cell and the selection — reactive, never the
 * block's handle itself — plus the handle for document reads and commands.
 */
export type BlockView<D = Record<string, any>> = {
	readonly id: string;
	readonly type: string;
	readonly data: D;
	readonly selected: boolean;
	readonly focused: boolean;
	/** The block's id-only handle (non-reactive reads, commands). */
	readonly handle: Block;
	/** Registers the snippet's block element (the core renders it from R5). */
	attach: Block['attach'];
	void: Block['void'];
};

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
	prevent: Prevent;
	/**
	 * The prepared command's effect (blocks created, removed, merged, moved,
	 * retyped, text ranges written), on a command that is one document plan
	 * (R6, FP-6) — a hook can refuse a command by what it would do.
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
 * Function type for transforming content within a text block.
 */
export type ContentTransformer = (payload: {
	text: Text;
	block: Block;
	content: JSONText[];
}) => JSONText[];

/**
 * Defines the structure of plugin definitions including marks, blocks, inline blocks, and hotkeys.
 */
export type PluginDefinitions = {
	marks?: Record<string, MarkDefinition | Snippet<[MarkSnippetPayload<any>]>>;
	blocks?: Record<string, BlockDefinition | Snippet<[BlockSnippetPayload<any>]>>;
	inlineBlocks?: Record<string, InlineBlockDefinition | Snippet<[InlineBlockSnippetPayload<any>]>>;
	hotkeys?: Partial<Record<HotKeyCombination, HotKey>>;
	commands?: EditorCommand[];
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
	/** Called after an operation is executed */
	onAfterOperation?: <C extends Omit<ChangePayload, 'prevent'>>(payload: C) => void;
	/** Called when the editor value changes */
	onChange?: (value: JSONBlock) => void;
	/** Called when the selection changes */
	onSelectionChange?: (selection: EdytorSelection) => void;
	/** The placeholder of an empty block (D-8): rendered by a `::before` rule the library ships. */
	placeholder?: Placeholder;
	/** Called when the editor is attached to the DOM */
	onEdytorAttached?: (payload: { node: HTMLElement }) => () => void;
	/** Called when a block is attached to the DOM */
	onBlockAttached?: (payload: { node: HTMLElement; block: Block }) => () => void;
	/** Called when text is attached to the DOM */
	onTextAttached?: (payload: { node: HTMLElement; text: Text }) => () => void;
	/** Called when selected blocks are deleted */
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
	/** The block's rendering snippet */
	snippet: Snippet<[BlockSnippetPayload<any>]>;
	/** Whether the block is void (not editable)
	 *
	 * Void blocks are blocks that are not editable by the edytor.
	 * They can be nested inside other blocks
	 * They can not be merged with other blocks
	 * If the content of the void block is rendered, it will still be editable. This to allow for rendering caption of the void block. I
	 * In void blocks the content is treated as an island
	 *
	 */
	void?: boolean;
	/** Whether the block is an island.
	 *
	 * Island blocks are blocks that are independent of the document.
	 *
	 * They are editable
	 *
	 * They can be nested inside other blocks
	 *
	 * But their children can not be nested or merged with other blocks
	 *
	 * Their structure will remain as if.
	 *
	 * In case of a merge operation, the island block will be merged with the parent block and all its children will ne unnest and set to the default child type of their new parent without being added as children of the merge destination block. The same wil happen to the island's content.
	 */
	island?: boolean;
	/**
	 * Whether the snippet renders the block's own content (`content()`).
	 * Defaults to `true`; containers that render only their children
	 * declare `false` so no caret or endpoint lands in the unrendered slot.
	 * Adopted by the document; checked in development against the snippet.
	 */
	rendersContent?: boolean;
	/**
	 * The type a new child of this block takes by default (Enter inside a
	 * child, a split, an island merged out into it). Adopted by the
	 * document; two extensions declaring different values is an error.
	 */
	defaultChild?: string;
	/**
	 * Catalogue rows (O68): one per way to create this kind — the slash menu,
	 * markdown shortcuts and block menus are generated from them
	 * (`edytor.kinds`). Command ids are `block.<type>`, numbered from 1 when
	 * the kind has several presets (`block.heading2`).
	 */
	presets?: KindPreset[];
	/**
	 * The content and children a conversion into this kind replaces the
	 * block's own with (a void has none; an island starts with a first child).
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
	/** Transform text content within the block
	 *
	 * This transformation is applied after the text is synced in to the state.
	 *
	 * You can use it to render custom marks decorations on the text like code tokens that are not stored in the document.
	 * It receives declared values (R2): the segment's `{stringContent, value}` and the block's `{id, type, data}`.
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

/** What an inline-atom snippet receives (R4): declared values; a suggestion's atom is never selected. */
export type InlineBlockView<D = Record<string, any>> = {
	readonly id: string;
	readonly type: string;
	readonly data: D;
	readonly selected: boolean;
	/** The atom's id-only handle; a suggested atom has none. */
	readonly handle: InlineBlock | undefined;
	attach: (node: HTMLElement) => unknown;
};

export type InlineBlockSnippetPayload<D = Record<string, any>> = {
	block: InlineBlockView<D>;
};

export type InlineBlockDefinition = {
	snippet: Snippet<[InlineBlockSnippetPayload<any>]>;
	/** Clipboard plain-text form of the atom; default none. */
	plain?: (data: JSONInlineBlock['data']) => string;
};

export type MarkDefinition = {
	snippet: Snippet<[MarkSnippetPayload<any>]>;
	void?: boolean;
	/** Whether typing at the mark's edges extends it (O69, `marksForInsertion`); default `inclusive`. */
	edge?: MarkEdge;
	/**
	 * Clipboard HTML form: a tag, or a function of the serialized inner HTML
	 * and the mark's value. Marks wrap in registration order (first innermost);
	 * a mark without one exports its text only.
	 */
	html?: string | ((inner: string, value: SerializableContent) => string);
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
};

export type EditorCommand = {
	id: string;
	label: string;
	icon?: string;
	keywords?: string[];
	group?: string;
	isEnabled?: (edytor: Edytor) => boolean;
	run: (edytor: Edytor) => unknown | Promise<unknown>;
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
