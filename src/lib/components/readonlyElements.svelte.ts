import type { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import type { BlockDefinition, InlineBlockDefinition } from '$lib/plugins.js';
import { deltaToJson, jsonToDelta, toDeltas, type JSONDelta } from '$lib/text/deltas.js';
import { id } from '$lib/utils.js';
import type { JSONBlock, JSONInlineBlock, JSONText } from '$lib/utils/json.js';
import type { Block } from '../block/block.svelte.js';
import type { Edytor } from '../edytor.svelte.js';
import { DEV } from 'esm-env';
import type { Text } from '$lib/text/text.svelte.js';

class ReadonlyBlock {
	readonly = true;
	edytor: Edytor;
	parent: ReadonlyBlock | Block | Edytor;
	type: string;
	value: JSONBlock;
	children: ReadonlyBlock[];
	content: (ReadonlyText | ReadonlyInlineBlock)[];
	id: string;
	definition: BlockDefinition;
	selected = false;
	focused = false;
	insideIsland = false;
	isEmpty: boolean;
	hasChildren: boolean;
	hasContent: boolean;
	node: HTMLElement | undefined;
	suggestions = undefined;
	constructor({
		block,
		edytor,
		parent
	}: {
		edytor: Edytor;
		parent: ReadonlyBlock | Block | Edytor;
		block: JSONBlock;
	}) {
		this.definition = edytor.getBlockDefinition('block', block.type);
		this.id = block.id || id('b');
		this.type = block.type;
		this.edytor = edytor;
		this.parent = parent;
		this.value = block;
		this.children =
			block.children?.map((block) => new ReadonlyBlock({ block, edytor, parent })) || [];
		this.content =
			block.content?.map((child) => {
				if ('type' in child) {
					return new ReadonlyInlineBlock({
						block: child,
						parent,
						edytor
					});
				} else {
					return new ReadonlyText({ value: [child], parent: this, edytor });
				}
			}) || [];
		this.hasChildren = this.children.length > 0;
		this.hasContent =
			this.content.length > 0 &&
			this.content.some((part) => part instanceof ReadonlyText && !part.isEmpty);
		this.isEmpty = !this.hasChildren && !this.hasContent;
	}

	attach(node: HTMLElement) {
		node.contentEditable = 'false';
		this.node = node;
	}
	void = (node: HTMLElement) => {
		// node.contentEditable = 'false';
	};
}

const createProxy = (target: any): any => {
	return new Proxy(target, {
		get(target, prop) {
			if (typeof prop === 'string' && prop in target) {
				const value = (target as any)[prop];
				console.log({ value });
				// Handle functions by binding them to the target
				return value;
			}
			if (DEV) {
				console.warn(
					`[ReadonlyBlock] Access to property "${String(prop)}" is forbidden in readonly mode`
				);
			}
			// Return a proxy for undefined to allow for safe chaining
			return createProxy({});
		},
		apply(target, thisArg, args) {
			if (typeof target === 'function') {
				return target.apply(thisArg, args);
			}
			if (DEV) {
				console.warn(`[ReadonlyBlock] Attempted to call a non-function value in readonly mode`, {
					target
				});
			}
			return createProxy({});
		}
	});
};

export const createReadonlyBlock = ({
	edytor,
	parent,
	block
}: {
	edytor: Edytor;
	parent: ReadonlyBlock | Block | Edytor;
	block: JSONBlock;
}) => {
	return createProxy(new ReadonlyBlock({ block, edytor, parent })) as Block;
};

export const createReadonlyInlineBlock = ({
	edytor,
	parent,
	block
}: {
	edytor: Edytor;
	parent: ReadonlyBlock | Block | Edytor;
	block: JSONInlineBlock;
}) => {
	return createProxy(new ReadonlyInlineBlock({ block, edytor, parent })) as InlineBlock;
};

export const createReadonlyText = ({
	edytor,
	parent,
	value
}: {
	edytor: Edytor;
	parent: ReadonlyBlock | Block;
	value: JSONText[];
}) => {
	return createProxy(new ReadonlyText({ value, parent, edytor })) as Text;
};

export class ReadonlyText {
	readonly = true;
	edytor: Edytor;
	parent: ReadonlyBlock | Block;
	#children;
	stringContent: string;
	node: HTMLElement | undefined;
	isEmpty: boolean;
	endsWithNewline: boolean;
	id: string;
	length: number;

	get value(): JSONText[] {
		return deltaToJson(this.#children);
	}

	get children() {
		const transformer = this.parent.definition?.transformText;
		return transformer
			? jsonToDelta(
					// @ts-expect-error
					transformer({ text: this, block: this.parent, content: deltaToJson(this.#children) })
				)
			: this.#children;
	}

	constructor({
		value,
		parent,
		edytor
	}: {
		value: JSONText[];
		parent: ReadonlyBlock | Block;
		edytor: Edytor;
	}) {
		this.#children = jsonToDelta(value);
		this.stringContent = value.map((child) => child.text).join('');
		this.isEmpty = this.stringContent.length === 0;
		this.parent = parent;
		this.endsWithNewline = this.stringContent.endsWith('\n');
		this.id = id('t');
		this.edytor = edytor;
		this.length = this.children.reduce((acc, child) => acc + child.text.length, 0);
	}

	attach(node: HTMLElement) {
		this.node = node;
	}
}

class ReadonlyInlineBlock {
	readonly = true;
	edytor: Edytor;
	parent: ReadonlyBlock | Block | Edytor;
	type: string;
	data = {};
	definition: InlineBlockDefinition;

	constructor({
		parent,
		block,
		edytor
	}: {
		parent: ReadonlyBlock | Block | Edytor;

		block: JSONInlineBlock;

		edytor: Edytor;
	}) {
		this.type = block.type;
		this.definition = edytor.getBlockDefinition('inline', this.type);
		this.parent = parent;
		this.edytor = parent.edytor;
	}
}
