import { getContext, hasContext, setContext, tick, type Snippet, onMount } from 'svelte';
import * as Y from 'yjs';
import { onBeforeInput } from './events/onBeforeInput.js';

import {
	type JSONBlock,
	type JSONDoc,
	type YBlock,
	type SerializableContent,
	type JSONText
} from '$lib/utils/json.js';
import { onKeyDown } from '$lib/events/onKeyDown.js';
import { EdytorSelection } from './selection/selection.svelte.js';
import { Block, getSetChildren, observeChildren } from './block/block.svelte.js';
import { Text } from './text/text.svelte.js';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Awareness } from 'y-protocols/awareness.js';
import { addBlock, batch } from './block/block.utils.js';
import type {
	Plugin,
	BlockSnippetPayload,
	InitializedPlugin,
	MarkSnippetPayload,
	BlockDefinition
} from './plugins.js';
import { on } from 'svelte/events';
import { HotKeys, type HotKey } from './hotkeys.js';
import { TRANSACTION } from './constants.js';

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
};
export class Edytor {
	node?: HTMLElement;
	marks = new Map<string, Snippet<[MarkSnippetPayload]>>();
	blocks = new Map<string, BlockDefinition>();
	plugins: InitializedPlugin[];
	container = $state<HTMLDivElement>();
	idToBlock = new SvelteMap<string, Block>();
	idToText = new SvelteMap<string, Text>();
	nodeToText = new SvelteMap<Node, Text>();
	transaction = new TRANSACTION();
	hotKeys: HotKeys;
	initialized = $state(false);
	readonly = $state(false);
	children = $state<Block[]>([]);
	synced = $state(false);
	edytor = this;
	selection: EdytorSelection;
	voidBlocks = new SvelteSet<Block>();
	voidElements = new SvelteSet<HTMLElement>();
	defaultType = 'paragraph';
	private off: (() => void)[] = [];
	private onChange?: (value: JSONBlock) => void;

	// @ts-expect-error
	observeChilren = observeChildren.bind(this);

	// YJS Stuff
	doc: Y.Doc = new Y.Doc();
	yChildren: Y.Array<YBlock> = this.doc.getArray('children') as Y.Array<YBlock>;
	yBlock: YBlock = new Y.Map<YBlock>();
	undoManager: Y.UndoManager = new Y.UndoManager(this.yChildren);

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
		onChange
	}: EdytorOptions) {
		this.readonly = readonly || false;
		this.doc = doc;
		this.yBlock = this.doc.getMap('content') as YBlock;
		this.yChildren = getSetChildren(this.yBlock);
		this.awareness = awareness;
		this.onChange = onChange;

		// Initialize plugins
		this.plugins = (plugins || []).map((plugin) => {
			const initializedPlugin = plugin(this);

			initializedPlugin.marks &&
				Object.entries(initializedPlugin.marks).forEach(([key, snippet]) => {
					this.marks.set(key, snippet);
				});

			initializedPlugin.blocks &&
				Object.entries(initializedPlugin.blocks).forEach(([key, definition]) => {
					if (typeof definition === 'object') {
						this.blocks.set(key, definition);
					} else {
						this.blocks.set(key, { snippet: definition });
					}
				});
			return initializedPlugin;
		});

		// We set the custom snippets after plugins are initialized in order to be able to override the plugins snippets
		Object.entries(snippets || {}).forEach(([key, snippet]) => {
			const isMark = key.endsWith('Mark');
			const isBlock = key.endsWith('Block');
			if (isMark) {
				this.marks.set(key, snippet as Snippet<[MarkSnippetPayload]>);
			} else if (isBlock) {
				this.blocks.set(key, { snippet: snippet as Snippet<[BlockSnippetPayload]> });
			}
		});

		if (readonly || !sync) {
			this.sync(value || { children: [] });
		}

		this.selection = new EdytorSelection(this, onSelectionChange);
		this.hotKeys = new HotKeys(this, hotKeys, this.plugins);
	}

	get value(): JSONBlock {
		const value: JSONBlock = {
			type: 'root',
			children: this.children.map((child) => child.value)
		};
		return value;
	}

	selectAll = () => {
		// TODO: Implement this in EdytorSelection;
		const { startText } = this.selection.state;
		const block = startText?.parent;
	};

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
			this.children = children.map((child) => {
				const block = new Block({ parent: this, block: child });
				this.yChildren.push([block.yBlock]);
				return block;
			});
		} else {
			const INITIALIZED = 'INITIALIZED';
			const initializedText = this.doc.getText(INITIALIZED);
			this.initialized = initializedText?.toJSON() === INITIALIZED;
			if (this.initialized) {
				this.yChildren = getSetChildren(this.yBlock);
				this.children = this.yChildren.map((yBlock) => {
					return new Block({ parent: this, yBlock });
				});
			} else {
				this.yChildren = getSetChildren(this.yBlock);
				this.children = children.map((child) => {
					const block = new Block({ parent: this, block: child });
					this.yChildren.push([block.yBlock]);
					return block;
				});

				initializedText.delete(0, initializedText.length);
				initializedText.insert(0, INITIALIZED);
			}
		}

		this.synced = true;
		this.yChildren.observe(this.observeChilren);
		this.undoManager = new Y.UndoManager(this.yChildren, {
			trackedOrigins: new Set([this.transaction, null])
		});
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
	addBlock = this.batch('addBlock', addBlock.bind(this));

	getTextByIdOrParent = (idOrParent: string | Block) => {
		if (typeof idOrParent === 'string') {
			const isText = idOrParent.startsWith('text');
			const isBlock = idOrParent.startsWith('block');
			if (isText) {
				return this.idToText.get(idOrParent);
			} else if (isBlock) {
				const block = this.idToBlock.get(idOrParent);
				return block?.content;
			}
			return undefined;
		} else if (idOrParent instanceof Block) {
			return idOrParent.content;
		}
		return undefined;
	};

	getBlockByIdOrContent = (idOrContent: string | Text): Block | undefined => {
		if (typeof idOrContent === 'string') {
			const isText = idOrContent.startsWith('text');
			const isBlock = idOrContent.startsWith('block');
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

	getTextNode = async (idOrTextOrBlock: string | Text | Block): Promise<HTMLElement> => {
		await tick();
		const text =
			idOrTextOrBlock instanceof Text ? idOrTextOrBlock : this.getTextByIdOrParent(idOrTextOrBlock);
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

		node.setAttribute('contenteditable', !this.readonly ? 'true' : 'false');

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
	return null;
};
