import type { Edytor } from '../../edytor.svelte.js';
import type {
	JSONBlock,
	JSONInlineBlock,
	JSONText,
	SerializableContent
} from '../../utils/json.js';
import {
	defaultDefinitions,
	getElementDefinitionResolver,
	mergeElementDefinitions,
	resolveElementDefinition,
	validateElementDefinitions,
	validateRegisteredType,
	type ElementCategory,
	type ElementDefinitions,
	type ResolvedElementDefinition
} from './elementDefinitions.js';
import HTMLNode, { type ElementSets, type HTMLNodeInterface } from './parser.js';

export type {
	ElementDefinition,
	ElementDefinitions,
	ElementDefinitionResult
} from './elementDefinitions.js';

const isWhitespaceText = (part: JSONText | JSONInlineBlock) =>
	'text' in part && part.text.trim() === '';

const hasMeaningfulInlineContent = (content: (JSONText | JSONInlineBlock)[]) =>
	content.some((part) => !isWhitespaceText(part));

const usesDefaultListMappings = (definitions: ElementDefinitions) =>
	definitions.blocks.ul === defaultDefinitions.blocks.ul &&
	definitions.blocks.ol === defaultDefinitions.blocks.ol &&
	definitions.blocks.li === defaultDefinitions.blocks.li;

const isDefaultListContainer = (definitions: ElementDefinitions, node: HTMLNodeInterface) =>
	usesDefaultListMappings(definitions) && (node.tagName === 'ul' || node.tagName === 'ol');

/**
 * Traverses the HTML node structure and converts it to a JSONBlock array
 */
const deserialize = (
	nodes: HTMLNodeInterface[],
	definitions: ElementDefinitions,
	edytor: Edytor
): JSONBlock[] => {
	if (nodes.length === 0) {
		// Return default empty paragraph
		return [
			{
				type: validateRegisteredType(edytor, 'blocks', 'p', 'paragraph'),
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

	// Post-process to merge trailing marks into previous blocks
	const mergedBlocks = mergeTrailingMarks(blocks);

	return mergedBlocks;

	// Function to merge trailing marks into the previous block
	function mergeTrailingMarks(blocks: JSONBlock[]): JSONBlock[] {
		if (blocks.length < 2) return blocks;

		const result: JSONBlock[] = [];

		// Keep track of trailing fragments to potentially merge
		let pendingMerge: JSONBlock | null = null;

		for (let i = 0; i < blocks.length; i++) {
			const currentBlock = blocks[i];
			const nextBlock = i < blocks.length - 1 ? blocks[i + 1] : null;

			// Check if the next block is a fragment with marked content
			const isNextBlockMarkFragment =
				nextBlock &&
				nextBlock.type === '$fragment' &&
				nextBlock.content?.some(
					(item) => 'text' in item && item.marks && Object.keys(item.marks).length > 0
				);

			// Check if this is the last regular block before trailing marks
			const isLastRegularBlock =
				isNextBlockMarkFragment &&
				(i === blocks.length - 2 ||
					blocks
						.slice(i + 2)
						.every(
							(b) =>
								b.type === '$fragment' &&
								b.content?.some(
									(item) => 'text' in item && item.marks && Object.keys(item.marks).length > 0
								)
						));

			// If this is a fragment with marks that needs to be merged with the previous block
			if (
				pendingMerge &&
				currentBlock.type === '$fragment' &&
				currentBlock.content?.some(
					(item) => 'text' in item && item.marks && Object.keys(item.marks).length > 0
				)
			) {
				// Skip this block as it will be merged
				continue;
			}

			// If this is the last regular block and the next is a fragment with marks
			if (isLastRegularBlock && currentBlock.content && !nextBlock.children) {
				// Create a copy of the current block
				const mergedBlock = { ...currentBlock };

				// Merge the content from the next block into this one
				mergedBlock.content = [...(mergedBlock.content || []), ...(nextBlock.content || [])];

				result.push(mergedBlock);
				pendingMerge = nextBlock;
				i++; // Skip the next block since we merged it
			} else {
				// Just add the current block as is
				result.push(currentBlock);
			}
		}

		return result;
	}

	// Inner function to deserialize a single node to JSONBlock(s)
	function deserializeNode(node: HTMLNodeInterface): JSONBlock[] {
		// If this is a block element (marked as such by the parser)
		if (node.isBlock) {
			if (isDefaultListContainer(definitions, node)) {
				return createDefaultListBlocks(node);
			}

			// Get the block type from our definitions
			const blockDefinition = getElementDefinition(node, 'blocks');
			return [createBlock(node, blockDefinition)];
		}

		if (node.isInlineBlock) {
			const content = processInlineNode(node);
			return content.length > 0 ? [{ type: '$fragment', content }] : [];
		}

		// Handle marks at the top level
		if (node.isMark) {
			// Get the mark type from our definitions
			const markDefinition = getElementDefinition(node, 'marks');
			const markValue = getMarkValue(markDefinition);
			const markType = markDefinition.type;

			// Create a fragment with the marked content (for consistency with plain text nodes)
			// This ensures both plain text and marked text at the beginning of HTML are treated consistently
			const content: (JSONText | JSONInlineBlock)[] = [];
			const result: JSONBlock = {
				type: '$fragment',
				content
			};

			// Process the node with the mark applied
			const marksObj: Record<string, SerializableContent> = {};
			marksObj[markType] = markValue;

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
						itemMarks[markType] = markValue;
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
					type: '$fragment',
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
					type: validateRegisteredType(edytor, 'blocks', 'p', 'paragraph'),
					content: processInlineContent(node)
				}
			];
		}

		return childBlocks;
	}

	// Helper function to get element type from definitions by calling the appropriate definition function
	function getElementDefinition(
		node: HTMLNodeInterface,
		category: ElementCategory
	): ResolvedElementDefinition {
		const tagName = node.tagName.toLowerCase();
		const categoryDefinitions = definitions[category];
		if (
			!categoryDefinitions ||
			!Object.prototype.hasOwnProperty.call(categoryDefinitions, tagName)
		) {
			throw new Error(`No HTML <${tagName}> ${category} mapping is defined`);
		}

		const resolve = getElementDefinitionResolver(definitions, category, tagName);
		return resolveElementDefinitionForNode(category, tagName, resolve(node));
	}

	function resolveElementDefinitionForNode(
		category: ElementCategory,
		tagName: string,
		result: unknown
	): ResolvedElementDefinition {
		return resolveElementDefinition(edytor, category, tagName, result);
	}

	// Create a JSON block from an HTML node
	function createBlock(node: HTMLNodeInterface, definition: ResolvedElementDefinition): JSONBlock {
		const block: JSONBlock = { type: definition.type };
		if (definition.data && typeof definition.data === 'object' && !Array.isArray(definition.data)) {
			block.data = definition.data as JSONBlock['data'];
		}

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

	function createDefaultListBlocks(node: HTMLNodeInterface): JSONBlock[] {
		const listDefinition = getElementDefinition(node, 'blocks');
		const blocks: JSONBlock[] = [];
		const inlineContent = processInlineContent(node);

		if (hasMeaningfulInlineContent(inlineContent)) {
			blocks.push(createBlock(node, listDefinition));
		}

		for (const child of node.children) {
			if (child.isBlock) {
				blocks.push(...deserializeNode(child));
			}
		}

		return blocks.length > 0 ? blocks : [createBlock(node, listDefinition)];
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
			const inlineDefinition = getElementDefinition(node, 'inlineBlocks');
			const data =
				inlineDefinition.data &&
				typeof inlineDefinition.data === 'object' &&
				!Array.isArray(inlineDefinition.data)
					? inlineDefinition.data
					: {};
			const inlineBlock: JSONInlineBlock = {
				type: inlineDefinition.type,
				data
			};
			return [inlineBlock];
		}

		// Handle marks (formatting)
		if (node.isMark) {
			const markDefinition = getElementDefinition(node, 'marks');
			const markValue = getMarkValue(markDefinition);
			const markType = markDefinition.type;
			const result: (JSONText | JSONInlineBlock)[] = [];

			// Apply the mark to the node's content
			if (node.textContent) {
				const marksObject: Record<string, SerializableContent> = {};
				marksObject[markType] = markValue;

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
						marksObject[markType] = markValue;

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

	function getMarkValue(definition: ResolvedElementDefinition): SerializableContent {
		return definition.data === undefined ? true : (definition.data as SerializableContent);
	}
};

export function parseHtml(
	this: Edytor,
	html: string,
	options: Partial<ElementDefinitions> = {}
): JSONBlock[] {
	const definitions = validateHtmlMappings.call(this, options);

	// Create sets of element tags for the parser to use for classification
	const elementSets: ElementSets = {
		blocks: new Set(Object.keys(definitions.blocks)),
		marks: new Set(Object.keys(definitions.marks)),
		inlineBlocks: new Set(Object.keys(definitions.inlineBlocks))
	};

	// Parse HTML with element classification sets
	const nodes = HTMLNode.create(html, elementSets);

	// Deserialize using full element definitions for type mapping
	return deserialize(nodes, definitions, this);
}

export function validateHtmlMappings(
	this: Edytor,
	options: Partial<ElementDefinitions> = {}
): ElementDefinitions {
	const definitions = mergeElementDefinitions(options);
	validateElementDefinitions(definitions, this);
	return definitions;
}
