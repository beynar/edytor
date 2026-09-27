import type { Snippet } from 'svelte';
import type { Edytor } from './edytor.svelte.js';
import type { Block } from './block/block.svelte.js';
import type { JSONBlock, JSONInlineBlock, JSONText } from './utils/json.js';
import type { Text } from './text/text.svelte.js';
import type { SerializableContent } from './utils/json.js';
import type { HotKey, HotKeyCombination } from './session/keymap.js';
import type { TextOperations } from './text/text.utils.js';
import type { BlockOperations } from './block/block.utils.js';
import type { EdytorSelection } from './selection/selection.svelte.js';
import type { InlineBlock } from './block/inlineBlock.svelte.js';
import type { PlanEffect } from './crdt/edytor-doc.js';
import type { MarkEdge } from './session/editing/text.js';

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
 * Represents the payload for block snippets with generic serializable content.
 * @template D - The type of serializable content
 */
export type BlockSnippetPayload<D extends SerializableContent = SerializableContent> = {
	block: Block;
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
	/** Placeholder content for empty blocks */
	placeholder?: string | Snippet<[{ block: Block }]>;
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
	/** Transform text content within the block
	 *
	 * This transformation is applied after the text is synced in to the state.
	 *
	 * You can use it to render custom marks decorations on the text like code tokens that are not stored in the document.
	 */
	transformText?: (payload: { text: Text; block: Block; content: JSONText[] }) => JSONText[];
	/** Called when the block receives focus */
	onFocus?: (payload: { block: Block }) => void;
	/** Called when the block loses focus */
	onBlur?: (payload: { block: Block }) => void;
	/** Called when the block is selected */
	onSelect?: (payload: { block: Block }) => void;
	/** Called when the block is deselected */
	onDeselect?: (payload: { block: Block }) => void;
	/** Normalize block content
	 * This is called after each operation on the block.
	 * You may want to work with the yjs types directly because the operation has not been synced in to the state yet.
	 * If you return a function, it will be executed otherwise it will be ignored.
	 */
	normalizeContent?: (payload: { block: Block }) => (() => void) | void;
	/** Normalize block children
	 * This is called after each operation on the block.
	 * You may want to work with the yjs types directly because the operation has not been synced in to the state yet.
	 * If you return a function, it will be executed otherwise it will be ignored.
	 */
	normalizeChildren?: (payload: { block: Block }) => (() => void) | void;
};

export type InlineBlockSnippetPayload<D extends SerializableContent = SerializableContent> = {
	block: InlineBlock;
};

export type InlineBlockDefinition = {
	snippet: Snippet<[InlineBlockSnippetPayload<any>]>;
};

export type MarkDefinition = {
	snippet: Snippet<[MarkSnippetPayload<any>]>;
	void?: boolean;
	/** Whether typing at the mark's edges extends it (O69, `marksForInsertion`); default `inclusive`. */
	edge?: MarkEdge;
};

export type EditorCommand = {
	id: string;
	label: string;
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
