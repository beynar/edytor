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
import type { JSONDelta } from './text/deltas.js';

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
	edytor: Edytor;
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

export type Plugin = (editor: Edytor) => {
	marks?: Record<string, Snippet<[MarkSnippetPayload<any>]>>;
	blocks?: Record<string, Snippet<[BlockSnippetPayload<any>]>>;
	hotkeys?: Partial<Record<HotKeyCombination, HotKey>>;
	onBeforeOperation?: <C extends ChangePayload>(payload: C) => C['payload'] | void;
	onAfterOperation?: <C extends Omit<ChangePayload, 'prevent'>>(payload: C) => void;
	onChange?: (value: JSONBlock) => void;
	onSelectionChange?: (selection: EdytorSelection) => void;
	placeholder?: Snippet<[{ block: Block; text: Text }]>;
	onEnter?: (paylaod: { prevent: Prevent; e: InputEvent }) => void;
	onTab?: (paylaod: { prevent: Prevent; e: KeyboardEvent }) => void;
	onBlockAttached?: (payload: { node: HTMLElement; block: Block }) => () => void;
	onTextAttached?: (payload: { node: HTMLElement; text: Text }) => () => void;
	transformContent?: Record<string, (payload: { text: Text; block: Block }) => JSONText[]>;
};

export type InitializedPlugin = ReturnType<Plugin>;

export type Rules = {
	headingBlock?: string;
	trailingBlock?: string;
	defaultBlock?: string | ((payload: ChangePayload) => string);
	maximumNesting?: number | ((payload: ChangePayload) => number);
	blockRules?: Record<string, BlockRules>;
};

export type BlockRules = {
	headingBlock?: string;
	trailingBlock?: string;
	defaultBlock?: string | ((payload: ChangePayload) => string);
	allowedBlockTypes?: string[];
	minBlocks?: number;
	maxBlocks?: number;
	maxLength?: number;
};
