import type { Edytor } from '$lib/edytor.svelte.js';
import * as Y from 'yjs';
import type { InlineBlockDefinition } from '$lib/plugins.js';
import type { JSONInlineBlock, YBlock } from '$lib/utils/json.js';
import type { Block } from './block.svelte.js';
import { id } from '$lib/utils.js';

export class InlineBlock {
	_def = 'inline' as const;
	readonly = false;
	parent: Block;
	data = $state<any>({});
	id: string;
	yBlock: YBlock;
	#type = $state<string>('inline');
	index = $state(0);
	definition = $state<InlineBlockDefinition>({} as InlineBlockDefinition);
	edytor: Edytor;
	node: HTMLElement | undefined;
	get type() {
		return this.#type;
	}

	set type(value: string) {
		this.#type = value;
		this.yBlock.set('type', value);
	}

	get value(): JSONInlineBlock {
		return {
			id: this.id,
			type: this.#type,
			data: this.data
		};
	}

	constructor({
		parent,
		block,
		yBlock
	}: {
		parent: Block;
	} & ({ yBlock?: undefined; block: JSONInlineBlock } | { yBlock: YBlock; block?: undefined })) {
		this.parent = parent;
		this.edytor = parent.edytor;
		this.id = (yBlock?.doc && (yBlock?.get('id') as string)) || id('i');
		if (block !== undefined) {
			this.#type = block.type;
			this.data = block.data || {};
			this.yBlock = new Y.Map(
				Object.entries({
					type: this.#type
				})
			);
		} else {
			this.yBlock = yBlock;
			this.#type = yBlock.get('type') as string;
			this.data = {};
		}

		this.definition = this.edytor.getBlockDefinition('inline', this.#type);
	}

	attach = (node: HTMLElement) => {
		node.contentEditable = 'false';
		node.dataset.edytorInlineBlock = this.#type;
		this.edytor.idToInlineBlock.set(this.id, this);
		this.node = node;
	};
}
