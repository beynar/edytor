/** @jsxImportSource ./jsx */
import type { RenderedNode } from './jsx/types.js';
import { Edytor } from '../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONBlock, JSONDoc, JSONText } from '$lib/utils/json.js';
import { expect } from 'vitest';
import type { Block } from '$lib/block/block.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';

export const findCursorPosition = (doc: JSONDoc) => {
	const value = doc.children;
	type CursorPosition = {
		path: number[];
		offset: number;
	};

	type CursorPositions = {
		start: CursorPosition | null;
		end: CursorPosition | null;
	};

	const findInText = (text: string): { newText: string; offset: number } | null => {
		const index = text.indexOf('|');
		if (index === -1) return null;
		return {
			newText: text.slice(0, index) + text.slice(index + 1),
			offset: index
		};
	};

	const findInBlock = (block: JSONBlock, currentPath: number[]): CursorPosition | null => {
		// Check content (text and inline blocks)
		if (block.content) {
			let accumulatedOffset = 0;
			let contentIndex = -1;
			let lastWasText = false;

			for (let i = 0; i < block.content.length; i++) {
				const item = block.content[i];

				if ('text' in item) {
					// Only increment content index if this is the start of a new text unit
					if (!lastWasText) {
						contentIndex++;
						accumulatedOffset = 0; // Reset offset for new content part
					}
					const result = findInText(item.text);
					if (result) {
						item.text = result.newText;
						return {
							path: [...currentPath, contentIndex],
							offset: accumulatedOffset + result.offset
						};
					}
					accumulatedOffset += item.text.length;
					lastWasText = true;
				} else {
					// This is an inline block
					contentIndex++;
					accumulatedOffset = 0; // Reset offset for new content part
					lastWasText = false;
				}
			}
		}

		// Check children recursively
		if (block.children) {
			for (let i = 0; i < block.children.length; i++) {
				const result = findInBlock(block.children[i], [...currentPath, i]);
				if (result) return result;
			}
		}

		return null;
	};

	// First find the start cursor
	let startPosition: CursorPosition | null = null;
	for (let i = 0; i < value.length; i++) {
		const result = findInBlock(value[i], [i]);
		if (result) {
			startPosition = result;
			break;
		}
	}

	// Then find the end cursor
	let endPosition: CursorPosition | null = null;
	if (startPosition) {
		for (let i = 0; i < value.length; i++) {
			const result = findInBlock(value[i], [i]);
			if (result) {
				endPosition = result;
				break;
			}
		}
	}

	return {
		start: startPosition,
		end: endPosition
	};
};

export const createTestEdytor = (
	jsx: RenderedNode
): { edytor: Edytor; expect: (jsx: RenderedNode) => void } => {
	const { value } = jsx;

	// Find and remove the cursor character, getting its position
	const cursorPosition = findCursorPosition(value);

	const edytor = new Edytor({
		value,
		plugins: [richTextPlugin]
	});

	const getBlockAndTextAtPath = findBlockAndTextAtPath(edytor);
	if (cursorPosition.start) {
		const { path, offset } = cursorPosition.start;
		const { text: startText, block: startBlock } = getBlockAndTextAtPath(path);
		console.log(startText);
		console.log(startBlock);

		edytor.selection.state = {
			...edytor.selection.state,
			startBlock,
			start: offset,
			end: offset,
			endBlock: startBlock,
			yStart: offset,
			yEnd: offset,
			isCollapsed: true,
			yTextContent: startText?.yText.toJSON() || ''
		};
	}

	return { edytor, expect: expectEydorValue(edytor) };
};

export const removeIds = (value: JSONBlock[]) => {
	return value.map((block) => {
		if (block.id) {
			delete block.id;
		}
		if (block.children) {
			block.children = removeIds(block.children);
		}
		return block;
	});
};

export const expectEydorValue = (edytor: Edytor) => (jsx: RenderedNode) => {
	const { children } = jsx.value as { children: JSONBlock[] };

	const value = removeIds(edytor.root?.value.children || []);

	console.dir(value, { depth: null });
	console.dir(children, { depth: null });
	expect(value).toEqual(children);
};

export const findBlockAndTextAtPath =
	(edytor: Edytor) =>
	(path: number[]): { block: Block; text: Text } => {
		let block = edytor.root;
		const textIndex = path.pop()!;

		path.forEach((index) => {
			block = block?.children[index];
		});

		if (!block) {
			throw new Error('Block not found');
		}
		const content = block.content;
		const text = content.at(textIndex) as Text;
		if (!text) {
			throw new Error('Text not found');
		}
		return { block, text };
	};
