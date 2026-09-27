import type { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import type { InlineBlockDefinition } from '$lib/plugins.js';
import { renderDeltas } from '$lib/surface/cells.js';
import { id } from '$lib/utils.js';
import type { JSONInlineBlock, JSONText } from '$lib/utils/json.js';
import type { Block } from '../block/block.svelte.js';
import type { Edytor } from '../edytor.svelte.js';
import { DEV } from 'esm-env';
import type { Text } from '$lib/text/text.svelte.js';

const createProxy = (target: any): any => {
	return new Proxy(target, {
		get(target, prop) {
			if (typeof prop === 'string' && prop in target) {
				return (target as any)[prop];
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

export const createReadonlyInlineBlock = ({
	edytor,
	parent,
	block
}: {
	edytor: Edytor;
	parent: Block;
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
	parent: Block;
	value: JSONText[];
}) => {
	return createProxy(new ReadonlyText({ value, parent, edytor })) as Text;
};

export class ReadonlyText {
	readonly = true;
	edytor: Edytor;
	parent: Block;
	value: JSONText[];
	stringContent: string;
	node: HTMLElement | undefined;
	isEmpty: boolean;
	endsWithNewline: boolean;
	id: string;
	length: number;

	/** The ghost text's render deltas, decorated by its kind's `transformText` (declared values). */
	get renderChildren() {
		const transform = this.parent.definition?.transformText;
		const { value, parent } = this;
		return renderDeltas(
			transform
				? transform({
						text: { stringContent: this.stringContent, value },
						block: { id: parent.id, type: parent.type, data: parent.data },
						content: value
					})
				: value
		);
	}

	constructor({ value, parent, edytor }: { value: JSONText[]; parent: Block; edytor: Edytor }) {
		this.value = value;
		this.stringContent = value.map((child) => child.text).join('');
		this.isEmpty = this.stringContent.length === 0;
		this.parent = parent;
		this.endsWithNewline = this.stringContent.endsWith('\n');
		this.id = id('t');
		this.edytor = edytor;
		this.length = this.stringContent.length;
	}

	attach(node: HTMLElement) {
		this.node = node;
	}
}

class ReadonlyInlineBlock {
	readonly = true;
	edytor: Edytor;
	parent: Block;
	type: string;
	id: string;
	data: JSONInlineBlock['data'];
	definition: InlineBlockDefinition;
	node: HTMLElement | undefined;

	constructor({
		parent,
		block,
		edytor
	}: {
		parent: Block;

		block: JSONInlineBlock;

		edytor: Edytor;
	}) {
		this.id = block.id || id('i');
		this.type = block.type;
		this.data = block.data ?? {};
		this.definition = edytor.getBlockDefinition('inline', this.type);
		this.parent = parent;
		this.edytor = parent.edytor;
	}

	attach(node: HTMLElement) {
		this.node = node;
	}
}
