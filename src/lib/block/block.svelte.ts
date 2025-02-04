import { Text } from '../text/text.svelte.js';
import { Edytor } from '../edytor.svelte.js';
import { type YBlock, type JSONBlock } from '$lib/utils/json.js';
import * as Y from 'yjs';
import {
	batch,
	addBlock,
	insertBlockAfter,
	insertBlockBefore,
	mergeBlockBackward,
	mergeBlockForward,
	nestBlock,
	removeBlock,
	setBlock,
	splitBlock,
	addBlocks,
	unNestBlock
} from './block.utils.js';
import { id } from '$lib/utils.js';

export const getSetChildren = (yBlock: YBlock): Y.Array<YBlock> => {
	let yChildren = yBlock.get('children') as Y.Array<YBlock>;
	if (!yChildren) {
		yChildren = new Y.Array();
		yBlock.set('children', yChildren);
	}
	return yChildren;
};

export const getSetText = (yBlock: YBlock): Y.Text => {
	let yText = yBlock.get('content') as Y.Text;
	if (!yText) {
		yText = new Y.Text();
		yBlock.set('content', yText);
	}
	return yText;
};

export class Block {
	edytor: Edytor;
	yBlock: YBlock;
	content: Text;
	parent: Block | Edytor;
	yChildren: Y.Array<YBlock>;
	children = $state<Block[]>([]);
	id: string;
	node?: HTMLElement;
	isVoid = $state(false);
	#index = $state<number | null>(null);

	get index(): number {
		if (this.#index === null) {
			return this.parent.children.indexOf(this);
		}
		return this.#index;
	}

	set index(value: number) {
		this.#index = value;
	}

	#type = $state<string>('paragraph');
	get type() {
		return this.#type;
	}
	set type(value: string) {
		// Do something here to update the document
		this.yBlock.set('type', value);
		this.#type = value;
	}

	#depth = $state<number | null>(null);

	get depth(): number {
		if (this.#depth === null) {
			return this.parent instanceof Block ? this.parent.depth + 1 : 0;
		}
		return this.#depth;
	}

	get nextBlock() {
		const index = this.index;
		return this.parent.children[index + 1];
	}

	get previousBlock() {
		return this.parent.children[this.index - 1];
	}

	get closestPreviousBlock(): Block | null {
		const previousBlock = this.previousBlock;
		if (this.index === 0) {
			return this.parent instanceof Block ? this.parent : null;
		} else {
			if (previousBlock?.children.length > 0) {
				return previousBlock.children.at(-1) || null;
			} else {
				return this.previousBlock;
			}
		}
	}

	get closestNextBlock(): Block | undefined {
		if (this.nextBlock) {
			return this.nextBlock;
		} else {
			if (this.hasChildren) {
				return this.children.at(-1);
			} else {
				if (this.parent instanceof Block) {
					return this.parent.parent.children.at(-1);
				} else {
					return undefined;
				}
			}
		}
	}
	get deepestChild(): Block {
		if (this.children.length) {
			return this.children.at(-1)!.deepestChild;
		}
		return this;
	}

	get hasChildren(): boolean {
		return this.children.length > 0;
	}

	get hasContent(): boolean {
		return this.content.isEmpty;
	}

	get isEmpty(): boolean {
		return this.hasContent && !this.hasChildren;
	}

	get value(): JSONBlock {
		return {
			type: this.type,
			id: this.id,
			children: this.children.map((child) => child.value),
			content: this.content.value
		};
	}

	private observeChildren = observeChildren.bind(this);
	private batch = batch.bind(this);
	addBlock = this.batch('addBlock', addBlock.bind(this));
	addBlocks = this.batch('addBlocks', addBlocks.bind(this));
	insertBlockAfter = this.batch('insertBlockAfter', insertBlockAfter.bind(this));
	insertBlockBefore = this.batch('insertBlockBefore', insertBlockBefore.bind(this));
	splitBlock = this.batch('splitBlock', splitBlock.bind(this));
	removeBlock = this.batch('removeBlock', removeBlock.bind(this));
	unNestBlock = this.batch('unNestBlock', unNestBlock.bind(this));
	mergeBlockBackward = this.batch('mergeBlockBackward', mergeBlockBackward.bind(this));
	mergeBlockForward = this.batch('mergeBlockForward', mergeBlockForward.bind(this));
	nestBlock = this.batch('nestBlock', nestBlock.bind(this));
	setBlock = this.batch('setBlock', setBlock.bind(this));

	constructor({
		parent,
		block,
		yBlock
	}: {
		parent: Block | Edytor;
	} & ({ yBlock?: undefined; block: JSONBlock } | { yBlock: YBlock; block?: undefined })) {
		this.parent = parent;
		this.edytor = parent.edytor;

		this.id = (yBlock?.doc && (yBlock?.get('id') as string)) || id('block');
		if (block !== undefined) {
			// If block is provided we need to initialize the block with the value;
			this.children = (block.children || []).map((child, index) => {
				const block = new Block({ parent: this, block: child });
				block.index = index;
				return block;
			});
			this.yChildren = Y.Array.from(this.children.map((child) => child.yBlock));

			this.content = new Text({
				parent: this,
				content: block.content || ''
			});

			this.yBlock = new Y.Map(
				Object.entries({
					type: block.type,
					id: this.id,
					children: this.yChildren,
					content: this.content.yText
				})
			);
			this.#type = block.type;
		} else {
			this.yBlock = yBlock;
			this.yChildren = getSetChildren(this.yBlock);
			this.content = new Text({
				parent: this,
				yText: getSetText(this.yBlock)
			});
			this.#type = this.yBlock.get('type') || 'paragraph';
			this.children = this.yChildren.map((child, index) => {
				const block = new Block({ parent: this, yBlock: child });
				block.index = index;
				return block;
			});
		}

		this.edytor.idToBlock.set(this.id, this);
		if (!this.edytor.readonly) {
			this.yChildren.observe(this.observeChildren);
		}
	}

	attach = (node: HTMLElement, isVoid: boolean = false) => {
		this.node = node;
		node.setAttribute('data-edytor-id', `${this.id}`);
		node.setAttribute('data-edytor-block', `true`);

		if (isVoid) {
			this.isVoid = true;
			node.setAttribute('data-edytor-void', `true`);
			node.contentEditable = 'false';
		}

		let pluginDestroy = this.edytor.plugins.reduce(
			(acc, plugin) => {
				const action = plugin.onBlockAttached?.({ node, block: this });

				action && acc.push(action);

				return acc;
			},
			[] as (() => void)[]
		);

		return {
			destroy: () => {
				this.yChildren.unobserve(this.observeChildren);
				this.edytor.idToBlock.delete(this.id);
				pluginDestroy.forEach((destroy) => destroy());
			}
		};
	};
}

export function observeChildren(this: Block, event: Y.YArrayEvent<YBlock>) {
	let start = 0;
	event.delta.forEach(({ retain, delete: _delete, insert }) => {
		if (retain) {
			start += retain;
		}
		if (_delete) {
			this.children.splice(start, _delete);
		}
		if (Array.isArray(insert)) {
			for (let i = 0; i < insert.length; i++) {
				const yBlock = insert[i] as YBlock;
				const block =
					this.edytor.idToBlock.get(yBlock.get('id') as string) ||
					new Block({
						parent: this,
						yBlock
					});

				this.children.splice(start, 0, block);
				start += 1;
			}
		}
	});
	this.children.forEach((child, index) => {
		child.index = index;
	});
}
