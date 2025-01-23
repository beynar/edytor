import { Block } from '$lib/block/block.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';

import type { JSONBlock, JSONText } from '$lib/utils/json.js';
import { tick } from 'svelte';

export type Autofocus = 'START' | 'END' | number | null;

export function addChild(
	this: Block | Edytor,
	block: JSONBlock,
	index: number = this.yChildren.length
) {
	const newBlock = Block.create(block, this, index);
	this.children.splice(index, 0, newBlock);
	return newBlock;
}

export function split(this: Block, index: number = this.yChildren.length) {
	const { yStart } = this.edytor.selection.state;
	let offset = 0;
	let content: JSONText[] = [];
	const beforeContent: JSONText[] = [];

	for (const child of this.content.value) {
		const textLength = child.text.length;
		const nextOffset = offset + textLength;

		if (nextOffset <= index) {
			// Text fully before split point
			beforeContent.push({
				text: child.text,
				marks: child.marks
			});
		} else if (offset < index) {
			// Text spans the split point
			beforeContent.push({
				text: child.text.slice(0, index - offset),
				marks: child.marks
			});
			content.push({
				text: child.text.slice(index - offset),
				marks: child.marks
			});
		} else {
			// Text fully after split point
			content.push({
				text: child.text,
				marks: child.marks
			});
		}
		offset = nextOffset;
	}

	// Update current block's content

	const newBlock = this.edytor.transact(() => {
		return this.parent.addChild(
			{ type: this.type, content },
			this.parent.children.indexOf(this) + 1
		);
	});
	this.content.yText.delete(index, this.content.yText.length - yStart);

	return newBlock;
}

export function remove(this: Block): Text {
	const index = this.parent.children.indexOf(this);
	const prev = this.parent.children[index - 1];
	const next = this.parent.children[index + 1];
	const blockToFocus = prev || next;

	this.parent.children.splice(index, 1);
	this.parent.yChildren.delete(index, 1);
	// this.content.yText.delete(0, this.content.yText.length);
	// this.content.forceUpdate();

	return blockToFocus.content;
}

export function unNest(this: Block) {}

export function nest(this: Block) {}
