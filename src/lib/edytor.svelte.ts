import { getContext, hasContext, setContext, tick, type Snippet, onMount } from 'svelte';
import * as Y from 'yjs';
import { onBeforeInput } from './events/onBeforeInput.js';

import {
	type JSONBlock,
	type JSONDoc,
	type YBlock,
	type SerializableContent
} from '$lib/utils/json.js';
import { onKeyDown, type HotKeys } from '$lib/events/onKeyDown.js';
import { EdytorSelection } from './selection/selection.svelte.js';
import { TRANSACTION } from './constants.js';
import { Block, getSetChildren, observeChildren } from './block/block.svelte.js';
import { Text } from './text/text.svelte.js';
import { SvelteMap } from 'svelte/reactivity';
import { Awareness } from 'y-protocols/awareness.js';
import { addChild } from './block/block.utils.js';

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

type EdytorOptions = {
	readonly: boolean;
	snippets: Snippets;
	hotKeys: HotKeys;
	doc?: Y.Doc;
	awareness?: Awareness;
	sync?: boolean;
	value?: JSONDoc;
};
export class Edytor {
	node?: HTMLElement;
	snippets: Snippets;
	lastInsert: string | null = null;
	container = $state<HTMLDivElement>();

	nodesToYElements = $state(new Map<Node, Y.Text | YBlock>());
	idToBlock = $state(new Map<string, Block>());
	idToText = $state(new Map<string, Text>());
	hotKeys: HotKeys;
	initialized = $state(false);
	YElementsToNodes = $state(new Map<Y.Text | YBlock, Node>());
	textToNode = new SvelteMap<Text, Node>();
	blockToNode = new SvelteMap<Block, Node>();
	nodeToBlock = new SvelteMap<Node, Block>();
	nodeToText = new SvelteMap<Node, Text>();
	readonly = $state(false);
	children = $state<Block[]>([]);
	synced = $state(false);

	edytor = this;
	selection: EdytorSelection;
	transaction = new TRANSACTION();

	// @ts-expect-error
	observeChilren = observeChildren.bind(this);

	// YJS Stuff
	doc: Y.Doc = new Y.Doc();
	yChildren: Y.Array<YBlock> = this.doc.getArray('children') as Y.Array<YBlock>;
	yBlock: YBlock = new Y.Map<YBlock>();
	undoManager: Y.UndoManager = new Y.UndoManager(this.yChildren);

	awareness: Awareness;

	constructor({
		snippets,
		readonly,
		hotKeys,
		doc = this.doc,
		awareness = new Awareness(doc),
		sync,
		value
	}: EdytorOptions) {
		this.readonly = readonly;
		this.doc = doc;
		this.yBlock = this.doc.getMap('content') as YBlock;
		this.yChildren = getSetChildren(this.yBlock);
		this.awareness = awareness;
		this.snippets = snippets;
		this.hotKeys = hotKeys;
		this.selection = new EdytorSelection(this);

		if (readonly || !sync) {
			this.sync(value || { children: [] });
		}
	}

	get value(): JSONBlock {
		return {
			type: 'root',
			children: this.children.map((child) => child.value)
		};
	}

	sync = ({ children = [] }: JSONDoc = { children: [] }) => {
		console.log('sync');
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
	};

	transactRemote = <T>(fn: () => T, transact: boolean = true): T => {
		if (transact) {
			return this.doc.transact(() => {
				return fn();
			}, this.transaction);
		} else {
			return fn();
		}
	};

	batch = <T>(fn: () => T) => {
		return this.doc.transact(() => {
			return fn();
		});
	};

	onBeforeInput = onBeforeInput.bind(this);
	addChild = addChild.bind(this);

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
		console.log({ idOrTextOrBlock });
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

		// this.container.contentEditable = 'true';
		this.selection.init();
		document.addEventListener('keydown', onKeyDown.bind(this));
		node.addEventListener('click', this.selection.handleTripleClick);
		node.addEventListener('beforeinput', this.onBeforeInput);
		node.setAttribute('contenteditable', !this.readonly ? 'true' : 'false');

		return {
			destroy: () => {
				this.selection.destroy();
				document.removeEventListener('keydown', onKeyDown.bind(this));
				node.removeEventListener('click', this.selection.handleTripleClick);
				node.removeEventListener('beforeinput', this.onBeforeInput);
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
