import { Text } from '../text/text.svelte.js';
import { Edytor } from '../edytor.svelte.js';
import {
	type YBlock,
	type JSONBlock,
	type JSONText,
	type JSONInlineBlock
} from '$lib/utils/json.js';
import * as Y from 'yjs';
import {
	batch,
	removeInlineBlock,
	addChildBlock,
	insertBlockAfter,
	insertBlockBefore,
	pushContentIntoBlock,
	mergeBlockBackward,
	mergeBlockForward,
	nestBlock,
	removeBlock,
	setBlock,
	splitBlock,
	addChildBlocks,
	unNestBlock,
	moveBlock,
	normalizeContent,
	groupContent,
	addInlineBlock,
	acceptSuggestedText,
	suggestText,
	deleteContentAtRange
} from './block.utils.js';
import { id } from '$lib/utils.js';
import type { BlockDefinition } from '$lib/plugins.js';
import { climb } from '$lib/selection/selection.utils.js';
import { InlineBlock } from './inlineBlock.svelte.js';
import { createReadonlyText } from '$lib/components/readonlyElements.svelte.js';
import { createReadonlyInlineBlock } from '$lib/components/readonlyElements.svelte.js';

export const getSetArray = <T = YBlock>(
	yBlock: YBlock,
	key: 'children' | 'content' = 'children'
): Y.Array<T> => {
	let yChildren = yBlock.get(key) as Y.Array<T>;
	if (!yChildren) {
		yChildren = new Y.Array();
		yBlock.set(key, yChildren);
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
	readonly = false;
	edytor: Edytor;
	yBlock: YBlock;
	parent: Block | Edytor;
	yChildren: Y.Array<YBlock>;
	children = $state<Block[]>([]);
	yContent: Y.Array<YBlock | Y.Text>;
	content = $state<(Text | InlineBlock)[]>([]);
	id = $state<string>(id('b'));
	node?: HTMLElement;
	definition = $state<BlockDefinition>({} as BlockDefinition);

	get selected() {
		this.yBlock._item?.id;
		return this.edytor.selection.selectedBlocks.has(this) || this.edytor.selection.hasSelectedAll;
	}
	get focused() {
		return this.edytor.selection.focusedBlocks.has(this) && !this.selected;
	}

	get insideIsland(): boolean {
		let insideIslands = false;
		climb(this.parent, (block) => {
			if (block instanceof Block && block.definition?.island) {
				insideIslands = true;
				return true;
			}
		});
		return insideIslands;
	}

	get firstEditableText(): Text | undefined {
		if (this.content.length && this.content.some((part) => part instanceof Text && part.node)) {
			return this.content.find((part) => part instanceof Text) as Text;
		}
		return this.children.at(0)?.firstEditableText;
	}

	get lastEditableText(): Text | undefined {
		if (this.content.length && this.content.some((part) => part instanceof Text && part.node)) {
			return this.content.findLast((part) => part instanceof Text) as Text;
		}
		return this.children.at(-1)?.lastEditableText;
	}

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
		this.definition = this.edytor.getBlockDefinition('block', value);
	}

	#depth = $state<number | null>(null);
	get depth(): number {
		if (this.#depth === null) {
			return this.parent instanceof Block ? this.parent.depth + 1 : 0;
		}
		return this.#depth;
	}

	get path(): number[] {
		const start = [this.index];
		console.log({ start });
		let current = this.parent;
		while (current instanceof Block) {
			start.push(current.index);
			current = current.parent;
		}
		return start.toReversed();
	}

	#suggestions = $state<(JSONText[] | JSONInlineBlock)[] | null>(null);

	get suggestions(): (Text | InlineBlock)[] | null {
		if (!this.#suggestions) {
			return null;
		}
		return this.#suggestions.map((suggestion) => {
			if ('type' in suggestion) {
				return createReadonlyInlineBlock({
					block: suggestion,
					edytor: this.edytor,
					parent: this
				});
			} else {
				return createReadonlyText({
					value: suggestion,
					parent: this,
					edytor: this.edytor
				}) as Text;
			}
		});
	}

	set suggestions(value: (JSONText[] | JSONInlineBlock)[] | null) {
		this.#suggestions = value;
	}

	get nextBlock() {
		return this.parent.children[this.index + 1];
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
				let closestPreviousBlock = previousBlock.children.at(-1) || null;
				while (closestPreviousBlock && closestPreviousBlock?.children.length > 0) {
					closestPreviousBlock = closestPreviousBlock.children.at(-1) || null;
				}
				return closestPreviousBlock || null;
			} else {
				return this.previousBlock;
			}
		}
	}

	get closestNextBlock(): Block | null {
		if (this.hasChildren) {
			return this.children.at(0) || null;
		}
		if (this.nextBlock) {
			return this.nextBlock;
		} else {
			if (this.parent instanceof Block) {
				return this.parent.parent.children.at(this.parent.index + 1) || null;
			} else {
				return null;
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
		return (
			this.content.length > 0 && this.content.some((part) => part instanceof Text && !part.isEmpty)
		);
	}

	get isEmpty(): boolean {
		return !this.hasContent && !this.hasChildren;
	}

	get value(): JSONBlock {
		const children = this.children.map((child) => child.value);
		const value: JSONBlock = {
			type: this.type,
			id: this.id,
			children,
			content: this.content.map((part) => part.value).flat()
		};
		if (!children.length) {
			delete value.children;
		}
		return value;
	}

	get firstText(): Text {
		if (this.content.length) {
			return this.content.find((part) => part instanceof Text)!;
		}
		return this.children.at(0)?.firstText!;
	}

	get lastText(): Text {
		if (this.content.length) {
			return this.content.findLast((part) => part instanceof Text)!;
		}
		return this.children.at(0)!.lastText!;
	}

	private observeContent = observeContent.bind(this);
	private observeChildren = observeChildren.bind(this);
	private batch = batch.bind(this);
	addChildBlock = this.batch('addChildBlock', addChildBlock.bind(this));
	addChildBlocks = this.batch('addChildBlocks', addChildBlocks.bind(this));
	insertBlockAfter = this.batch('insertBlockAfter', insertBlockAfter.bind(this));
	insertBlockBefore = this.batch('insertBlockBefore', insertBlockBefore.bind(this));
	splitBlock = this.batch('splitBlock', splitBlock.bind(this));
	removeBlock = this.batch('removeBlock', removeBlock.bind(this));
	unNestBlock = this.batch('unNestBlock', unNestBlock.bind(this));
	mergeBlockBackward = this.batch('mergeBlockBackward', mergeBlockBackward.bind(this));
	mergeBlockForward = this.batch('mergeBlockForward', mergeBlockForward.bind(this));
	nestBlock = this.batch('nestBlock', nestBlock.bind(this));
	setBlock = this.batch('setBlock', setBlock.bind(this));
	moveBlock = this.batch('moveBlock', moveBlock.bind(this));
	pushContentIntoBlock = this.batch('pushContentIntoBlock', pushContentIntoBlock.bind(this));
	removeInlineBlock = this.batch('removeInlineBlock', removeInlineBlock.bind(this));
	addInlineBlock = this.batch('addInlineBlock', addInlineBlock.bind(this));
	normalizeContent = this.batch('normalizeContent', normalizeContent.bind(this));
	suggestText = this.batch('suggestText', suggestText.bind(this));
	acceptSuggestedText = this.batch('acceptSuggestedText', acceptSuggestedText.bind(this));
	deleteContentAtRange = this.batch('deleteContentAtRange', deleteContentAtRange.bind(this));

	void = (node: HTMLElement) => {
		node.setAttribute('data-edytor-void', `true`);
		node.style.userSelect = 'none';
		node.contentEditable = 'false';
	};

	constructor({
		parent,
		block,
		yBlock
	}: {
		parent: Block | Edytor;
	} & ({ yBlock?: undefined; block: JSONBlock } | { yBlock: YBlock; block?: undefined })) {
		this.parent = parent;
		this.edytor = parent.edytor;
		this.id = (yBlock?.doc && (yBlock?.get('id') as string)) || id('b');

		if (block !== undefined) {
			this.#type = block.type;
			// If block is provided we need to initialize the block with the value;
			// It's mean that we want to create a new block from a JSONBlock that does not exist yet in the document
			this.children = (block.children || []).map((child, index) => {
				const block = new Block({ parent: this, block: child });
				block.index = index;
				return block;
			});
			const groupedContent = groupContent(block.content);

			this.content = groupedContent.map((part, index) => {
				const isInlineBlock = 'type' in part;
				if (isInlineBlock) {
					const block = new InlineBlock({ parent: this, block: part });
					block.index = index;
					return block;
				} else {
					const text = new Text({ parent: this, content: part });
					text.index = index;
					return text;
				}
			});
			this.yChildren = Y.Array.from(this.children.map((child) => child.yBlock));
			this.yContent = Y.Array.from(
				this.content.map((part) => (part instanceof Text ? part.yText : part.yBlock))
			);

			this.yBlock = new Y.Map(
				Object.entries({
					type: block.type,
					id: this.id,
					children: this.yChildren,
					content: this.yContent
				})
			);
		} else {
			this.yBlock = yBlock;
			this.#type = this.yBlock.get('type') || this.edytor.getDefaultBlock(parent);
			this.yChildren = getSetArray(this.yBlock);
			this.yContent = getSetArray(this.yBlock, 'content');
			this.children = this.yChildren.map((child, index) => {
				const block = new Block({ parent: this, yBlock: child });
				block.index = index;
				return block;
			});
			this.content = this.yContent.map((part, index) => {
				if (part instanceof Y.Map) {
					const block = new InlineBlock({ parent: this, yBlock: part });
					block.index = index;
					return block;
				} else {
					const text = new Text({ parent: this, yText: part });
					text.index = index;
					return text;
				}
			});
		}
		this.definition = this.edytor.getBlockDefinition('block', this.#type);
		this.edytor.idToBlock.set(this.id, this);
		if (!this.edytor.readonly) {
			this.yChildren.observe(this.observeChildren);
			this.yContent.observe(this.observeContent);
		}
	}

	attach = (node: HTMLElement) => {
		this.node = node;
		node.setAttribute('data-edytor-id', `${this.id}`);
		node.setAttribute('data-edytor-block', `true`);
		node.setAttribute('data-edytor-type', `${this.#type}`);

		const pluginDestroy = this.edytor.plugins.reduce(
			(acc, plugin) => {
				const action = plugin.onBlockAttached?.({ node, block: this });
				action && acc.push(action);
				return acc;
			},
			[] as (() => void)[]
		);
		if (this.definition.void) {
			this.void(node);
		}
		return {
			destroy: () => {
				this.yChildren.unobserve(this.observeChildren);
				this.yContent.unobserve(this.observeContent);
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
export function observeContent(this: Block, event: Y.YArrayEvent<YBlock | Y.Text>) {
	let start = 0;
	event.delta.forEach(({ retain, delete: _delete, insert }) => {
		if (retain) {
			start += retain;
		}
		if (_delete) {
			this.content.splice(start, _delete);
		}
		if (Array.isArray(insert)) {
			for (let i = 0; i < insert.length; i++) {
				const yElement = insert[i] as YBlock | Y.Text;
				if (yElement instanceof Y.Text) {
					const text = new Text({ parent: this, yText: yElement });
					this.content.splice(start, 0, text);
				} else {
					const inlineBlock = new InlineBlock({ parent: this, yBlock: yElement });
					this.content.splice(start, 0, inlineBlock);
				}
				start += 1;
			}
		}
	});

	this.content.forEach((part, index) => {
		part.index = index;
	});
}
