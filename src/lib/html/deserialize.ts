import type { Edytor } from '../edytor.svelte.js';
import type { JSONBlock, JSONInlineBlock, JSONText, SerializableContent } from '../utils/json.js';
import HTMLNode, { type HTMLNodeInterface, type ElementSets } from './parser.js';

// Element type definitions for creating the output JSON structure
export interface ElementDefinitions {
	blocks: { [tagName: string]: (node: HTMLNodeInterface) => { type: string; [key: string]: any } };
	marks: { [tagName: string]: (node: HTMLNodeInterface) => { type: string; [key: string]: any } };
	inlineBlocks: {
		[tagName: string]: (node: HTMLNodeInterface) => { type: string; [key: string]: any };
	};
}

// Default element type mappings
const blocks = {
	p: (node: HTMLNodeInterface) => ({
		type: 'paragraph'
	}),
	blockquote: (node: HTMLNodeInterface) => ({
		type: 'block-quote'
	}),
	code: (node: HTMLNodeInterface) => ({
		type: 'code'
	})
};

const marks = {
	strong: (node: HTMLNodeInterface) => ({
		type: 'bold'
	}),
	em: (node: HTMLNodeInterface) => ({
		type: 'italic'
	}),
	u: (node: HTMLNodeInterface) => ({
		type: 'underline'
	})
};

const inlineBlocks = {
	cite: (node: HTMLNodeInterface) => ({
		type: 'citation'
	})
};

// Default element type mappings
const defaultDefinitions: ElementDefinitions = {
	blocks,
	marks,
	inlineBlocks
};

/**
 * Traverses the HTML node structure and converts it to a JSONBlock array
 */
const deserialize = (nodes: HTMLNodeInterface[], definitions: ElementDefinitions): JSONBlock[] => {
	if (nodes.length === 0) {
		// Return default empty paragraph
		return [
			{
				type: 'paragraph',
				content: [{ text: '' }]
			}
		];
	}

	const blocks: JSONBlock[] = [];

	// Process each root node
	for (const node of nodes) {
		const deserializedBlocks = deserializeNode(node);
		blocks.push(...deserializedBlocks);
	}

	return blocks;

	// Inner function to deserialize a single node to JSONBlock(s)
	function deserializeNode(node: HTMLNodeInterface): JSONBlock[] {
		// If this is a block element (marked as such by the parser)
		if (node.isBlock) {
			// Get the block type from our definitions
			const blockType = getElementType(node, 'blocks');
			return [createBlock(node, blockType)];
		}

		// Handle marks at the top level
		if (node.isMark) {
			// Get the mark type from our definitions
			const markType = getElementType(node, 'marks');

			// Create a paragraph with the marked content
			const content: (JSONText | JSONInlineBlock)[] = [];
			const result: JSONBlock = {
				type: 'paragraph',
				content
			};

			// Process the node with the mark applied
			const marksObj: Record<string, SerializableContent> = {};
			marksObj[markType] = true;

			// Add text content with the mark
			if (node.textContent) {
				content.push({
					text: node.textContent,
					marks: marksObj
				});
			}

			// Process inline content with the mark
			for (const inlineElement of node.content) {
				const inlineContent = processInlineNode(inlineElement);
				for (const item of inlineContent) {
					if ('text' in item) {
						// Apply the mark to text nodes
						const itemMarks = { ...(item.marks || {}) };
						itemMarks[markType] = true;
						content.push({
							text: item.text,
							marks: itemMarks
						});
					} else {
						// Pass through inline blocks
						content.push(item);
					}
				}
			}

			return [result];
		}

		// Handle text nodes (no tag name)
		if (!node.tagName && node.textContent) {
			return [
				{
					type: 'paragraph',
					content: [{ text: node.textContent }]
				}
			];
		}

		// Handle other elements that might contain blocks
		const childBlocks: JSONBlock[] = [];
		for (const child of node.children) {
			const nestedBlocks = deserializeNode(child);
			childBlocks.push(...nestedBlocks);
		}

		// If no blocks were created from children but we have inline content,
		// create a paragraph block
		if (childBlocks.length === 0 && (node.textContent || node.content.length > 0)) {
			return [
				{
					type: 'paragraph',
					content: processInlineContent(node)
				}
			];
		}

		return childBlocks;
	}

	// Helper function to get element type from definitions by calling the appropriate definition function
	function getElementType(
		node: HTMLNodeInterface,
		category: 'blocks' | 'marks' | 'inlineBlocks'
	): string {
		const tagName = node.tagName.toLowerCase();
		if (tagName in definitions[category]) {
			// Call the definition function with the node
			const result = definitions[category][tagName](node);
			return result.type;
		}
		// Default fallbacks based on category
		if (category === 'blocks') return 'paragraph';
		if (category === 'marks') return 'bold';
		return 'citation'; // Default for inlineBlocks
	}

	// Create a JSON block from an HTML node
	function createBlock(node: HTMLNodeInterface, blockType: string): JSONBlock {
		const block: JSONBlock = { type: blockType };

		// Process inline content (text and inline elements)
		const inlineContent = processInlineContent(node);
		if (inlineContent.length > 0) {
			block.content = inlineContent;
		}

		// Process child blocks
		const childBlocks: JSONBlock[] = [];
		for (const child of node.children) {
			// Only process children that are blocks
			if (child.isBlock) {
				const nestedBlocks = deserializeNode(child);
				childBlocks.push(...nestedBlocks);
			}
		}

		if (childBlocks.length > 0) {
			block.children = childBlocks;
		}

		return block;
	}

	// Process node's inline content
	function processInlineContent(node: HTMLNodeInterface): (JSONText | JSONInlineBlock)[] {
		const result: (JSONText | JSONInlineBlock)[] = [];

		// Add initial text if present
		if (node.textContent) {
			result.push({ text: node.textContent });
		}

		// Process each inline content element
		for (const child of node.content) {
			const childContent = processInlineNode(child);
			result.push(...childContent);
		}

		return result;
	}

	// Process an inline node
	function processInlineNode(node: HTMLNodeInterface): (JSONText | JSONInlineBlock)[] {
		const tagName = node.tagName?.toLowerCase() || '';

		// Handle special case for line breaks
		if (tagName === 'br') {
			return [{ text: '\n' }];
		}

		// Handle inline blocks (like citation)
		if (node.isInlineBlock) {
			const inlineType = getElementType(node, 'inlineBlocks');
			const inlineBlock: JSONInlineBlock = { type: inlineType, data: {} };
			return [inlineBlock];
		}

		// Handle marks (formatting)
		if (node.isMark) {
			const markType = getElementType(node, 'marks');
			const result: (JSONText | JSONInlineBlock)[] = [];

			// Apply the mark to the node's content
			if (node.textContent) {
				const marksObject: Record<string, SerializableContent> = {};
				marksObject[markType] = true;

				const text: JSONText = {
					text: node.textContent,
					marks: marksObject
				};
				result.push(text);
			}

			// Process children and apply the mark to them
			for (const child of node.content) {
				const childContent = processInlineNode(child);

				for (const item of childContent) {
					if ('text' in item) {
						// Apply the mark to text nodes
						const marksObject: Record<string, SerializableContent> = { ...(item.marks || {}) };
						marksObject[markType] = true;

						const text: JSONText = {
							text: item.text,
							marks: marksObject
						};
						result.push(text);
					} else {
						// Pass through inline blocks
						result.push(item);
					}
				}
			}

			return result;
		}

		// For text nodes (no tag), just return the text
		if (!node.tagName && node.textContent) {
			return [{ text: node.textContent }];
		}

		// For generic inline elements
		const result: (JSONText | JSONInlineBlock)[] = [];

		// Add direct content
		if (node.textContent) {
			result.push({ text: node.textContent });
		}

		// Process children
		for (const child of node.content) {
			const childContent = processInlineNode(child);
			result.push(...childContent);
		}

		return result;
	}
};

export function parseHtml(
	this: Edytor,
	html: string,
	options: Partial<ElementDefinitions> = {}
): JSONBlock[] {
	// Merge provided options with defaults
	const definitions: ElementDefinitions = {
		blocks: { ...blocks, ...options.blocks },
		marks: { ...marks, ...options.marks },
		inlineBlocks: { ...inlineBlocks, ...options.inlineBlocks }
	};

	// Create sets of element tags for the parser to use for classification
	const elementSets: ElementSets = {
		blocks: new Set(Object.keys(definitions.blocks)),
		marks: new Set(Object.keys(definitions.marks)),
		inlineBlocks: new Set(Object.keys(definitions.inlineBlocks))
	};

	// Parse HTML with element classification sets
	const nodes = HTMLNode.create(html, elementSets);

	// Deserialize using full element definitions for type mapping
	return deserialize(nodes, definitions);
}
