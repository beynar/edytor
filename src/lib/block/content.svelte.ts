import type { YBlock } from '$lib/utils/json.js';
import type { Block } from './block.svelte.js';
import { InlineBlock } from './inlineBlock.svelte.js';
import { Text } from '../text/text.svelte.js';
import * as Y from 'yjs';
import { batch, normalizeContent } from './block.utils.js';

export class Content {
	parent: Block;
	content: (Text | InlineBlock)[];

	constructor({ parent, content }: { parent: Block; content: (Text | InlineBlock)[] }) {
		this.parent = parent;
		this.content = content;
	}
}

export function observeContent(this: Content, event: Y.YArrayEvent<YBlock | Y.Text>) {
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
					const text = new Text({ parent: this.parent, yText: yElement });
					this.content.splice(start, 0, text);
				} else {
					const inlineBlock = new InlineBlock({ parent: this.parent, yBlock: yElement });
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
