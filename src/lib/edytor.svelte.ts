import { getContext, hasContext, setContext, tick, type Snippet, onMount } from 'svelte';
import * as Y from 'yjs';
import { onBeforeInput } from './events/onBeforeInput.js';
import {
	type JSONBlock,
	type JSONDoc,
	type YBlock,
	type SerializableContent
} from '$lib/utils/json.js';
import { onKeyDown } from '$lib/events/onKeyDown.js';
import { EdytorSelection } from './selection/selection.svelte.js';
import { Block } from './block/block.svelte.js';
import { Text } from './text/text.svelte.js';
import { SvelteMap } from 'svelte/reactivity';
import { Awareness } from 'y-protocols/awareness.js';
import { batch } from './block/block.utils.js';
import type {
	Plugin,
	BlockSnippetPayload,
	InitializedPlugin,
	MarkSnippetPayload,
	BlockDefinition,
	MarkDefinition,
	InlineBlockDefinition,
	InlineBlockSnippetPayload
} from './plugins.js';
import { on } from 'svelte/events';
import { HotKeys, type HotKey } from './hotkeys.js';
import { TRANSACTION } from './constants.js';
import type { InlineBlock } from './block/inlineBlock.svelte.js';
import { deleteContentWithinSelection } from './edytor.utils.js';

export type Snippets = {
	[K in `${string}Block` | `${string}Mark`]: K extends `${string}Block`
		? Snippet<
				[
					{
						block: Block;
						children: Snippet | null;
						content: Snippet;
					}
				]
			>
		: Snippet<
				[
					{
						mark: SerializableContent;
						text: Text;
						content: Snippet;
					}
				]
			>;
};

export type EdytorOptions = {
	readonly?: boolean;
	snippets?: Snippets;
	hotKeys?: Record<string, HotKey>;
	plugins?: Plugin[];
	doc?: Y.Doc;
	awareness?: Awareness;
	sync?: boolean;
	value?: JSONDoc;
	onChange?: (value: JSONBlock) => void;
	onSelectionChange?: (selection: EdytorSelection) => void;
	placeholder?: string | Snippet<[{ block: Block }]>;
};

export type RootBlock = Block & {
	readonly type: 'root';
	readonly id: 'root';
	readonly depth: 0;
};

export class Edytor {
	node?: HTMLElement;
	marks = new Map<string, MarkDefinition>();
	blocks = new Map<string, BlockDefinition>();
	inlineBlocks = new Map<string, InlineBlockDefinition>();
	plugins: InitializedPlugin[];
	container = $state<HTMLDivElement>();
	idToBlock = new SvelteMap<string, Block>();
	idToInlineBlock = new SvelteMap<string, InlineBlock>();
	idToText = new SvelteMap<string, Text>();
	nodeToText = new SvelteMap<Node, Text>();
	transaction = new TRANSACTION();
	hotKeys: HotKeys;
	initialized = $state(false);
	readonly = $state(false);
	yRootBlock: YBlock;
	root = $state<Block>();
	synced = $state(false);
	edytor = this;
	selection: EdytorSelection;
	defaultType = 'paragraph';
	private off: (() => void)[] = [];
	private onChange?: (value: JSONBlock) => void;
	placeholder?: string | Snippet<[{ block: Block }]>;

	// YJS Stuff
	doc: Y.Doc = new Y.Doc();
	undoManager: Y.UndoManager;
	awareness: Awareness;

	transact = <T>(cb: () => T): T => {
		return this.doc.transact(() => {
			const result = cb();
			return result;
		}, this.transaction);
	};

	constructor({
		snippets,
		readonly,
		hotKeys,
		plugins,
		doc = this.doc,
		awareness = new Awareness(doc),
		sync,
		value,
		onSelectionChange,
		placeholder,
		onChange
	}: EdytorOptions) {
		this.readonly = readonly || false;
		this.doc = doc;
		this.yRootBlock = this.doc.getMap('content') as YBlock;
		this.awareness = awareness;
		this.onChange = onChange;

		// Initialize plugins
		this.plugins = (plugins || []).map((plugin) => {
			const initializedPlugin = plugin(this);

			initializedPlugin.marks &&
				Object.entries(initializedPlugin.marks).forEach(([key, snippet]) => {
					if (typeof snippet === 'object') {
						this.marks.set(key, snippet);
					} else {
						this.marks.set(key, { snippet });
					}
				});

			initializedPlugin.blocks &&
				Object.entries(initializedPlugin.blocks).forEach(([key, definition]) => {
					if (typeof definition === 'object') {
						this.blocks.set(key, definition);
					} else {
						this.blocks.set(key, { snippet: definition });
					}
				});
			initializedPlugin.inlineBlocks &&
				Object.entries(initializedPlugin.inlineBlocks).forEach(([key, definition]) => {
					if (typeof definition === 'object') {
						this.inlineBlocks.set(key, definition);
					} else {
						this.inlineBlocks.set(key, { snippet: definition });
					}
				});
			return initializedPlugin;
		});

		// We set the custom snippets after plugins are initialized in order to be able to override the plugins snippets
		Object.entries(snippets || {}).forEach(([key, snippet]) => {
			const isMark = key.endsWith('Mark');
			const isInlineBlock = key.endsWith('InlineBlock');
			const isBlock = key.endsWith('Block');
			if (isMark) {
				this.marks.set(key, { snippet: snippet as Snippet<[MarkSnippetPayload]> });
			} else if (isInlineBlock) {
				// this.inlineBlocks.set(key, { snippet: snippet as Snippet<[InlineBlockSnippetPayload]> });
			} else if (isBlock) {
				this.blocks.set(key, { snippet: snippet as Snippet<[BlockSnippetPayload]> });
			}
		});

		this.placeholder =
			placeholder || this.plugins.find((plugin) => plugin.placeholder)?.placeholder;

		if (readonly || !sync) {
			this.sync(value || { children: [] });
		}

		this.selection = new EdytorSelection(this, onSelectionChange);
		this.hotKeys = new HotKeys(this, hotKeys, this.plugins);
		this.undoManager = new Y.UndoManager(this.yRootBlock, {
			trackedOrigins: new Set([this.transaction, null])
		});
	}

	getBlockDefinition = <M extends 'inline' | 'block'>(
		mode: M,
		type: string
	): M extends 'block' ? BlockDefinition : InlineBlockDefinition => {
		const definition = mode === 'block' ? this.blocks.get(type) : this.inlineBlocks.get(type);
		if (type === 'root') {
			return {} as any;
		}
		if (!definition) {
			throw new Error(`Block type ${type} is not defined`);
		}
		return definition as M extends 'block' ? BlockDefinition : InlineBlockDefinition;
	};

	get value(): JSONBlock {
		return {
			type: 'root',
			children: this.root?.value.children || []
		};
	}

	getDefaultBlock = (
		parent: Block | Edytor | undefined = this.selection.state.startText?.parent
	) => {
		if (!parent || parent instanceof Edytor) {
			return 'paragraph';
		}
		for (const plugin of this.plugins) {
			if (plugin.defaultBlock) {
				const defaultBlock =
					typeof plugin.defaultBlock === 'function'
						? plugin.defaultBlock(parent)
						: plugin.defaultBlock;
				if (defaultBlock) {
					return defaultBlock;
				}
			}
		}
		return 'paragraph';
	};
	sync = ({ children = [] }: JSONDoc = { children: [] }) => {
		if (this.synced) {
			return;
		}
		if (this.readonly) {
			// children.forEach((child) => {
			// 	const block = new Block({ parent: this.root, block: child });
			// 	this.root.yChildren.push([block.yBlock]);
			// });
		} else {
			const INITIALIZED = 'INITIALIZED';
			const initializedText = this.doc.getText(INITIALIZED);
			this.initialized = initializedText?.toJSON() === INITIALIZED;
			if (this.initialized) {
				// this.yRootBlock =
				// Root block already exists and has its children
				this.root = new Block({
					edytor: this,
					yBlock: this.yRootBlock,
					block: {
						type: 'root',
						id: 'root',
						children
					}
				});
			} else {
				this.root = new Block({
					edytor: this,
					yBlock: this.yRootBlock,
					block: {
						type: 'root',
						id: 'root',
						children
					}
				});
			}
			initializedText.delete(0, initializedText.length);
			initializedText.insert(0, INITIALIZED);
		}

		this.synced = true;
		this.doc.on('update', () => {
			const value = this.value;
			this.onChange?.(value);
			this.plugins.forEach((plugin) => {
				plugin.onChange?.(value);
			});
		});
	};

	onBeforeInput = onBeforeInput.bind(this);
	batch = batch.bind(this);

	deleteContentWithinSelection = this.batch(
		'deleteContentWithinSelection',
		deleteContentWithinSelection.bind(this)
	);

	getTextById = (id: string) => {
		const isText = id.startsWith('t');
		if (!isText) {
			throw new Error('Invalid id, expected text id');
		}

		return this.idToText.get(id);
	};

	getBlockByIdOrContent = (idOrContent: string | Text): Block | undefined => {
		if (typeof idOrContent === 'string') {
			const isText = idOrContent.startsWith('t');
			const isBlock = idOrContent.startsWith('b');
			if (isBlock) {
				return this.idToBlock.get(idOrContent);
			} else if (isText) {
				const text = this.idToText.get(idOrContent);
				return text?.parent;
			}
		} else if (idOrContent instanceof Text) {
			return idOrContent.parent || undefined;
		}
		return undefined;
	};

	getTextNode = async (idOrText: string | Text): Promise<HTMLElement> => {
		await tick();
		const text = idOrText instanceof Text ? idOrText : this.getTextById(idOrText);
		let node = text?.node;
		let breakCount = 0;
		while (!node) {
			await tick();
			node = text?.node;
			breakCount++;
			if (breakCount > 10) {
				throw new Error('Failed to find text node');
			}
		}
		return node;
	};

	attach = (node: HTMLDivElement) => {
		this.node = node;
		this.container = node;
		this.selection.init();
		this.hotKeys.init();
		this.off.push(
			on(document, 'keydown', onKeyDown.bind(this)),
			on(node, 'click', this.selection.handleTripleClick),
			on(node, 'beforeinput', this.onBeforeInput)
		);

		this.plugins.forEach((plugin) => {
			const action = plugin.onEdytorAttached?.({ node });
			action && this.off.push(action);
		});

		return {
			destroy: () => {
				this.selection.destroy();
				this.off.forEach((off) => off());
			}
		};
	};
}

export const useEdytor = () => {
	const hasEdytorContext = hasContext('edytor');

	if (hasEdytorContext) {
		return getContext<Edytor>('edytor');
	}
	throw new Error('No Edytor found');
};
