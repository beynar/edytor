import type { Snippet } from 'svelte';
import type { Edytor } from './edytor.svelte.js';
import type { Block } from './block/block.svelte.js';
import type { JSONBlock, JSONText } from './utils/json.js';
import type { Text } from './text/text.svelte.js';
import type { SerializableContent } from './utils/json.js';
import type { HotKey, HotKeyCombination } from './hotkeys.js';
import type { TextOperations } from './text/text.utils.js';
import type { BlockOperations } from './block/block.utils.js';
import type { EdytorSelection } from './selection/selection.svelte.js';

export type MarkSnippetPayload<D extends SerializableContent = SerializableContent> = {
	content: Snippet;
	mark: D;
	text: Text;
};

type Prevent = (cb?: () => void) => void;

export type BlockSnippetPayload<D extends SerializableContent = SerializableContent> = {
	block: Block;
	content: Snippet;
	children: Snippet | null;
};

type ChangePayload = {
	block: Block;
	text: Text;
	prevent: Prevent;
} & (
	| {
			[K in keyof TextOperations]: {
				operation: K;
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

export type ContentTransformer = (payload: {
	text: Text;
	block: Block;
	content: JSONText[];
}) => JSONText[];

export type PluginDefinitions = {
	marks?: Record<string, Snippet<[MarkSnippetPayload<any>]>>;
	blocks?: Record<string, BlockDefinition | Snippet<[BlockSnippetPayload<any>]>>;
	hotkeys?: Partial<Record<HotKeyCombination, HotKey>>;
};
export type Plugin = (editor: Edytor) => PluginDefinitions & PluginOperations;

export type PluginOperations = {
	onBeforeOperation?: <C extends ChangePayload>(payload: C) => C['payload'] | void;
	onAfterOperation?: <C extends Omit<ChangePayload, 'prevent'>>(payload: C) => void;
	onChange?: (value: JSONBlock) => void;
	onSelectionChange?: (selection: EdytorSelection) => void;
	placeholder?: Snippet<[{ block: Block; text: Text }]>;
	onEdytorAttached?: (payload: { node: HTMLElement }) => () => void;
	onBlockAttached?: (payload: { node: HTMLElement; block: Block }) => () => void;
	onTextAttached?: (payload: { node: HTMLElement; text: Text }) => () => void;
	defaultBlock?: string | ((parent: Block) => string | void);
	onDeleteSelectedBlocks?: (payload: {
		prevent: Prevent;
		e: KeyboardEvent;
		selectedBlocks: Block[];
	}) => void;
	onBeforeInput?: (payload: { prevent: Prevent; e: InputEvent }) => void;
};
export type BlockDefinition = {
	snippet: Snippet<[BlockSnippetPayload<any>]>;
	void?: boolean;
	island?: boolean;
	transformContent?: (payload: { text: Text; block: Block; content: JSONText[] }) => JSONText[];
	onFocus?: (payload: { block: Block }) => void;
	onBlur?: (payload: { block: Block }) => void;
	onSelect?: (payload: { block: Block }) => void;
	onDeselect?: (payload: { block: Block }) => void;
	// defaultChildType?: string | ((parent: Block) => string | void);
	// allowedBlockTypes?: string[];
	// minBlocks?: number;
	// maxBlocks?: number;
	// maxLength?: number;
	// transformChildren?: (payload: { children: JSONBlock[]; block: Block }) => JSONText[];
};

export type InitializedPlugin = ReturnType<Plugin>;

// TODO: add arrow events
// TODO: add onBeforeInput event
// TODO: add block focus and selection events
// TODO: add a cmd+a selection all event
//

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
