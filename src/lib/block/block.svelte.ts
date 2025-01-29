import { Text } from '../text/text.svelte.js';
import { Edytor } from '../edytor.svelte.js';
import { type YBlock, type JSONBlock } from '$lib/utils/json.js';
import * as Y from 'yjs';
import {
	addChild,
	addChildWithCurrentChildren,
	batch,
	mergeBlockBackward,
	mergeBlockForward,
	nest,
	remove,
	removeAndUnnestChildren,
	set,
	split,
	unNest
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

	#type = $state<string>('paragraph');

	get type() {
		return this.#type;
	}

	set type(value: string) {
		// Do something here to update the document
		this.yBlock.set('type', value);
		this.#type = value;
	}

	get index() {
		return this.parent.children.indexOf(this);
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
	get closestNextBlock(): Block {
		return this.children.at(0) || this.nextBlock;
	}
	get deepestChild(): Block {
		if (this.children.length) {
			return this.children.at(-1)!.deepestChild;
		}
		return this;
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
	addChild = this.batch(addChild.bind(this));
	addChildWithCurrentChildren = this.batch(addChildWithCurrentChildren.bind(this));
	split = this.batch(split.bind(this));
	remove = this.batch(remove.bind(this));
	removeAndUnnestChildren = this.batch(removeAndUnnestChildren.bind(this));
	unNest = this.batch(unNest.bind(this));
	mergeBlockBackward = this.batch(mergeBlockBackward.bind(this));
	mergeBlockForward = this.batch(mergeBlockForward.bind(this));
	nest = this.batch(nest.bind(this));
	set = this.batch(set.bind(this));

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
				return new Block({ parent: this, block: child });
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
		} else {
			this.yBlock = yBlock;
			this.yChildren = getSetChildren(this.yBlock);
			this.content = new Text({
				parent: this,
				yText: getSetText(this.yBlock)
			});
			this.children = this.yChildren.map((child) => {
				return new Block({ parent: this, yBlock: child });
			});
		}

		this.edytor.idToBlock.set(this.id, this);
		if (!this.edytor.readonly) {
			this.yChildren.observe(this.observeChildren);
		}
	}

	attach = (node: HTMLElement) => {
		this.node = node;
		node.setAttribute('data-edytor-id', `${this.id}`);
		node.setAttribute('data-edytor-block', `true`);

		return {
			destroy: () => {
				this.yChildren.unobserve(this.observeChildren);
				this.edytor.idToBlock.delete(this.id);
			}
		};
	};
}

export function observeChildren(this: Block, event: Y.YArrayEvent<YBlock>) {
	if (event.transaction.origin !== this.edytor.transaction) {
		let start = 0;
		event.delta.forEach(({ retain, delete: _delete, insert }) => {
			if (retain) {
				start += retain;
			}
			if (_delete) {
				this.children.splice(start, _delete);
				// start -= _delete;
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
	}
}
