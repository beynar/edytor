import { Text } from '../text/text.svelte.js';
import { Edytor } from '../edytor.svelte.js';
import {
	partialBlockToJson,
	type YBlock,
	type PartialJSONBlock,
	type JSONText,
	type JSONBlock
} from '$lib/utils/json.js';
import * as Y from 'yjs';
import { addChild, nest, remove, split, unNest } from './block.utils.js';

export const getSetChildren = (yBlock: YBlock): Y.Array<YBlock> => {
	let yChildren = yBlock.get('children') as Y.Array<YBlock>;
	if (!yChildren) {
		yChildren = new Y.Array();
		yBlock.set('children', yChildren);
	}
	return yChildren;
};

export class Block {
	edytor: Edytor;
	yBlock: YBlock;
	content: Text;
	parent: Block | Edytor;
	yChildren: Y.Array<YBlock>;
	children = $state<Block[]>([]);
	id = crypto.randomUUID();
	node?: HTMLElement;

	#type = $state<string>('paragraph');

	get type() {
		return this.#type;
	}

	set type(value: string) {
		// Do something here to update the document
		this.#type = value;
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
	addChild = addChild.bind(this);
	split = split.bind(this);
	remove = remove.bind(this);
	unNest = unNest.bind(this);
	nest = nest.bind(this);

	static create = (block: JSONBlock, parent: Block | Edytor, index: number) => {
		const yBlock = new Y.Map();
		// Insert the new block inside its parent in order to integrate it with the document and allow subsequent modifications
		parent.yChildren.insert(index, [yBlock]);
		yBlock.set('type', block.type);
		yBlock.set('id', block.id || crypto.randomUUID());
		yBlock.set('children', new Y.Array());
		return new Block({ yBlock, parent, block, create: true });
	};

	constructor({
		yBlock,
		parent,
		block,
		create
	}: {
		yBlock: YBlock;
		parent: Block | Edytor;
	} & (
		| {
				block: JSONBlock;
				create: boolean;
		  }
		| { block?: undefined; create?: undefined }
	)) {
		this.parent = parent;
		this.edytor = parent.edytor;
		this.yBlock = yBlock;
		this.yChildren = yBlock.get('children') as Y.Array<YBlock>;

		if (create) {
			this.content = Text.create(block.content, this);
			this.children = block.children
				? block.children.map((child, index) => {
						return Block.create(child, this, index);
					})
				: [];
		} else {
			this.content = new Text(this.yBlock.get('content') as Y.Text, this);
			this.children = this.yChildren.map((child) => {
				return new Block({ parent: this, yBlock: child });
			});
		}

		this.yChildren.observe(this.observeChildren);
	}

	destroy = () => {
		// this.yBlock.unobserve(this.setBlock);
		// this.yChildren.unobserve(this.observe);
		// this.edytor.YElementsToNodes.delete(this.yBlock);
		// this.node && this.edytor.nodesToYElements.delete(this.node);
		// this.content.destroy();
		// this.children.forEach((child) => child.destroy());
	};

	attach = (node: HTMLElement) => {
		this.node = node;
		this.edytor.YElementsToNodes.set(this.yBlock, node);
		this.edytor.nodesToYElements.set(node, this.yBlock);

		node.setAttribute('data-edytor-id', `${this.id}`);
		node.setAttribute('data-edytor-block', `true`);
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
				const deleted = this.children.splice(start, _delete);
				deleted.forEach((block) => {
					block.destroy();
				});
				start -= _delete;
			}
			if (Array.isArray(insert)) {
				for (let i = 0; i < insert.length; i++) {
					this.children.splice(
						start,
						0,
						new Block({
							parent: this,
							yBlock: insert[i]
						})
					);
					start += 1;
				}
			}
		});
	}
}
