import { getContext, hasContext, setContext, tick, type Snippet, onMount } from 'svelte';
import * as Y from 'yjs';
import { onBeforeInput } from './events/onBeforeInput.js';
import { moveCursor } from '$lib/utils/setCursor.js';
import {
	type JSONBlock,
	type JSONDoc,
	type YBlock,
	type SerializableContent
} from '$lib/utils/json.js';
import { onKeyDown, type HotKeys } from '$lib/events/onKeyDown.js';
import { browser } from '$app/environment';
import { EdytorSelection } from './selection/selection.svelte.js';
import { Buffer } from './buffer.svelte.js';
import { TRANSACTION } from './utils/constants.js';
import { Block, getSetChildren, observeChildren } from './block/block.svelte.js';
import type { Text } from './text/text.svelte.js';
import { SvelteMap } from 'svelte/reactivity';
import { Awareness } from 'y-protocols/awareness.js';
import { addChild } from './block/block.utils.js';

export type Snippets = {
	[K in `${string}Block` | `${string}Mark`]: K extends `${string}Block`
		? Snippet<
				[
					{
						block: Block;
						children: Snippet;
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
	doc: Y.Doc;
	nodesToYElements = $state(new Map<Node, Y.Text | YBlock>());
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
	yChildren: Y.Array<YBlock>;
	yBlock: YBlock;
	undoManager: Y.UndoManager;
	edytor = this;
	awareness: Awareness;
	selection: EdytorSelection;
	transaction = new TRANSACTION();

	observeChilren = observeChildren.bind(this);

	constructor({
		snippets,
		readonly,
		hotKeys,
		doc = new Y.Doc(),
		awareness = new Awareness(doc),
		sync,
		value
	}: EdytorOptions) {
		this.readonly = readonly;
		this.doc = doc;
		this.awareness = awareness;
		this.snippets = snippets;
		this.hotKeys = hotKeys;

		if (sync) {
			this.sync(value || { children: [] }, false);
		}

		this.selection = new EdytorSelection(this);
	}

	get value(): JSONBlock {
		return {
			type: 'root',
			children: this.children.map((child) => child.value)
		};
	}

	sync = ({ children = [] }: JSONDoc = { children: [] }, reset = true) => {
		this.yBlock = this.doc.getMap('content') as YBlock;
		this.yChildren = getSetChildren(this.yBlock);
		const INITIALIZED = 'INITIALIZED';
		const text = this.doc.getText(INITIALIZED);
		this.initialized = text?.toJSON() === INITIALIZED;
		console.log({ block: this.initialized });
		if (this.initialized) {
			this.children = this.yChildren.map((yBlock) => {
				return new Block({ parent: this, yBlock });
			});
		} else {
			this.children = children.map((block, index) => {
				return Block.create(block, this, index);
			});
			text.delete(0, text.length);
			text.insert(0, INITIALIZED);
		}

		this.synced = true;
		this.yChildren.observe(this.observeChilren);
		this.undoManager = new Y.UndoManager(this.yChildren);

		this.selection.init();
	};

	transact = <T>(fn: () => T, transact: boolean = true): T => {
		if (transact) {
			return this.doc.transact((transaction) => {
				const result = fn();
				this.undoManager.captureTransaction(transaction);
				return result;
			}, this.transaction);
		} else {
			return fn();
		}
	};

	onBeforeInput = onBeforeInput.bind(this);
	addChild = addChild.bind(this);

	attach = (node: HTMLDivElement) => {
		this.node = node;
		this.container = node;

		// this.container.contentEditable = 'true';
		// document.addEventListener('keydown', onKeyDown.bind(this));

		node.addEventListener('beforeinput', this.onBeforeInput);
		node.setAttribute('contenteditable', 'true');

		return {
			destroy: () => {
				this.selection.destroy();
				document.removeEventListener('keydown', onKeyDown.bind(this));
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
