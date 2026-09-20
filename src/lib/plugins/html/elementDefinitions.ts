import type { Edytor } from '../../edytor.svelte.js';
import type { HTMLNodeInterface } from './parser.js';

export type ElementDefinitionResult = { type: string; data?: unknown } & Record<string, unknown>;

export type ElementDefinition = {
	[tagName: string]: (node: HTMLNodeInterface) => ElementDefinitionResult;
};

export interface ElementDefinitions {
	blocks: ElementDefinition;
	marks: ElementDefinition;
	inlineBlocks: ElementDefinition;
}

export type ElementCategory = keyof ElementDefinitions;
export type ResolvedElementDefinition = { type: string; data?: unknown };
type ElementDefinitionResolver = (node: HTMLNodeInterface) => ElementDefinitionResult;

const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isElementDefinitionResolver = (value: unknown): value is ElementDefinitionResolver =>
	typeof value === 'function';

const createValidationNode = (tagName: string, parent?: HTMLNodeInterface): HTMLNodeInterface => ({
	tagName,
	attributes: {},
	children: [],
	content: [],
	isSelfClosing: false,
	parent: parent ?? null,
	isBlock: false,
	isInlineBlock: false,
	isMark: false,
	html: () => `<${tagName}></${tagName}>`,
	text: () => ''
});

const createListItemValidationNodes = () => [
	createValidationNode('li', createValidationNode('ul')),
	createValidationNode('li', createValidationNode('ol')),
	createValidationNode('li')
];

const createElementValidationNodes = (tagName: string): HTMLNodeInterface[] => {
	if (tagName === 'li') {
		return createListItemValidationNodes();
	}

	return [createValidationNode(tagName)];
};

const getRegistry = (edytor: Edytor, category: ElementCategory) => {
	if (category === 'blocks') {
		return edytor.blocks;
	}
	if (category === 'marks') {
		return edytor.marks;
	}
	return edytor.inlineBlocks;
};

export const validateRegisteredType = (
	edytor: Edytor,
	category: ElementCategory,
	tagName: string,
	type: string
): string => {
	const registry = getRegistry(edytor, category);

	if (!(registry instanceof Map)) {
		throw new Error(
			`Cannot validate HTML <${tagName}> ${category} mapping because the editor ${category} registry is unavailable`
		);
	}

	if (!registry.has(type)) {
		throw new Error(
			`HTML <${tagName}> ${category} mapping returned "${type}", but that type is not registered on the editor`
		);
	}

	return type;
};

export const getElementDefinitionResolver = (
	definitions: ElementDefinitions,
	category: ElementCategory,
	tagName: string
): ElementDefinitionResolver => {
	const resolve = definitions[category][tagName];
	if (typeof resolve !== 'function') {
		throw new Error(`HTML <${tagName}> ${category} mapping must be a function`);
	}
	return resolve;
};

export const resolveElementDefinition = (
	edytor: Edytor,
	category: ElementCategory,
	tagName: string,
	result: unknown
): ResolvedElementDefinition => {
	if (!isRecord(result) || typeof result.type !== 'string' || result.type.trim() === '') {
		throw new Error(`HTML <${tagName}> ${category} mapping must return a non-empty type`);
	}

	const type = result.type.trim();
	validateRegisteredType(edytor, category, tagName, type);

	return { type, data: result.data };
};

export const validateElementDefinitions = (definitions: ElementDefinitions, edytor: Edytor) => {
	for (const category of Object.keys(definitions) as ElementCategory[]) {
		for (const tagName of Object.keys(definitions[category])) {
			const resolve = getElementDefinitionResolver(definitions, category, tagName);
			for (const validationNode of createElementValidationNodes(tagName)) {
				resolveElementDefinition(edytor, category, tagName, resolve(validationNode));
			}
		}
	}
};

const normalizeElementDefinition = (
	category: ElementCategory,
	definition: unknown = {}
): ElementDefinition => {
	if (!isRecord(definition)) {
		throw new Error(`HTML ${category} mappings must be an object`);
	}

	const normalized: ElementDefinition = {};

	for (const [tagName, resolve] of Object.entries(definition)) {
		const normalizedTagName = tagName.trim().toLowerCase();
		if (!normalizedTagName) {
			throw new Error('HTML mapping tag names must be non-empty');
		}
		if (hasOwn(normalized, normalizedTagName)) {
			throw new Error(`Duplicate HTML mapping for <${normalizedTagName}>`);
		}
		if (!isElementDefinitionResolver(resolve)) {
			throw new Error(`HTML <${normalizedTagName}> ${category} mapping must be a function`);
		}
		normalized[normalizedTagName] = resolve;
	}

	return normalized;
};

const blocks = {
	p: () => ({
		type: 'paragraph'
	}),
	h1: () => ({
		type: 'heading',
		data: { level: 'h1' }
	}),
	h2: () => ({
		type: 'heading',
		data: { level: 'h2' }
	}),
	h3: () => ({
		type: 'heading',
		data: { level: 'h3' }
	}),
	h4: () => ({
		type: 'heading',
		data: { level: 'h3' }
	}),
	h5: () => ({
		type: 'heading',
		data: { level: 'h3' }
	}),
	h6: () => ({
		type: 'heading',
		data: { level: 'h3' }
	}),
	blockquote: () => ({
		type: 'quote'
	}),
	ul: () => ({
		type: 'bulleted-list-item'
	}),
	ol: () => ({
		type: 'numbered-list-item'
	}),
	li: (node: HTMLNodeInterface) => ({
		type: node.parent?.tagName === 'ol' ? 'numbered-list-item' : 'bulleted-list-item'
	}),
	pre: () => ({
		type: 'paragraph'
	}),
	hr: () => ({
		type: 'divider'
	})
};

const marks = {
	a: (node: HTMLNodeInterface) => ({
		type: 'link',
		data: {
			href: node.attributes.href ?? '',
			...(node.attributes.target ? { target: node.attributes.target } : {})
		}
	}),
	strong: () => ({
		type: 'bold'
	}),
	b: () => ({
		type: 'bold'
	}),
	em: () => ({
		type: 'italic'
	}),
	i: () => ({
		type: 'italic'
	}),
	u: () => ({
		type: 'underline'
	}),
	s: () => ({
		type: 'strike'
	}),
	strike: () => ({
		type: 'strike'
	}),
	del: () => ({
		type: 'strike'
	}),
	sup: () => ({
		type: 'superscript'
	}),
	sub: () => ({
		type: 'subscript'
	}),
	mark: () => ({
		type: 'highlight',
		data: 'yellow'
	}),
	code: () => ({
		type: 'code'
	})
};

const inlineBlocks = {};

export const defaultDefinitions: ElementDefinitions = {
	blocks,
	marks,
	inlineBlocks
};

export const mergeElementDefinitions = ({
	blocks,
	marks,
	inlineBlocks
}: Partial<ElementDefinitions> = {}): ElementDefinitions => ({
	blocks: { ...defaultDefinitions.blocks, ...normalizeElementDefinition('blocks', blocks) },
	marks: { ...defaultDefinitions.marks, ...normalizeElementDefinition('marks', marks) },
	inlineBlocks: {
		...defaultDefinitions.inlineBlocks,
		...normalizeElementDefinition('inlineBlocks', inlineBlocks)
	}
});
