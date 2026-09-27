/** @jsxImportSource ./jsx */
/**
 * JSX DSL fixtures are a model-layer harness only.
 *
 * Limits to keep explicit:
 * - `|` is reserved fixture syntax and cannot represent literal pipe text.
 * - Fixture-derived selections are text-anchored. They model block/text ranges, not full DOM behavior.
 * - These helpers do not prove browser selection mapping, `beforeinput`, or attachment hooks.
 */
import type { RenderedNode } from './jsx/types.js';
import { Edytor } from '../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONBlock, JSONDoc, JSONInlineBlock, JSONText } from '$lib/utils/json.js';
import { expect } from 'vitest';
import { Block } from '$lib/block/block.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import type { Plugin } from '$lib/plugins.js';
import type { SerializableContent } from '$lib/utils/json.js';
import { onKeyDown } from '$lib/events/onKeyDown.js';
import type { Awareness, YDoc } from '$lib/crdt/index.js';

type CursorPosition = {
	path: number[];
	offset: number;
};

export type ContentPart = Text | InlineBlock;

export type SelectionExpectation = {
	startBlockPath?: number[];
	endBlockPath?: number[];
	startTextPath?: number[];
	endTextPath?: number[];
	blockPaths?: number[][];
	textPaths?: number[][];
	selectedBlockPaths?: number[][];
	focusedBlockPaths?: number[][];
	yStart?: number;
	yEnd?: number;
	length?: number;
	content?: string;
	isCollapsed?: boolean;
	isTextSpanning?: boolean;
	isBlockSpanning?: boolean;
};

export type OperationResultExpectation =
	| { kind: 'void' }
	| { kind: 'null' }
	| { kind: 'block'; path: number[]; type?: string }
	| { kind: 'text'; path: number[]; content?: string }
	| { kind: 'inline-block'; path: number[]; type?: string }
	| { kind: 'blocks'; paths: number[][] }
	| { kind: 'cursor'; path: number[]; offset: number };

export type TestEdytorOptions = {
	plugins?: Plugin[];
	readonly?: boolean;
	value?: JSONDoc;
	doc?: YDoc;
	awareness?: Awareness;
	sync?: boolean;
};

export type BeforeInputOptions = {
	inputType: InputEvent['inputType'];
	data?: string;
	text?: string;
};

export type MarkStateExpectation = {
	pending?: Record<string, SerializableContent | null> | undefined;
	range?: {
		start: number;
		end: number;
		value: JSONText[];
	};
};

const defaultPlugins = [richTextPlugin, mentionPlugin];

const getAncestorBlockByDefinition = (
	block: Block | null,
	key: 'island' | 'void'
): Block | null => {
	let current = block;
	while (current) {
		if (current.definition?.[key]) {
			return current;
		}
		current = current.parent ?? null;
	}

	return null;
};

export const findCursorPosition = (doc: JSONDoc) => {
	const value = doc.children;
	const cursorCount = JSON.stringify(value).split('|').length - 1;

	if (cursorCount > 2) {
		throw new Error('JSX DSL fixtures support at most two "|" cursor markers');
	}

	const findInText = (text: string): { newText: string; offset: number } | null => {
		const index = text.indexOf('|');
		if (index === -1) {
			return null;
		}

		return {
			newText: text.slice(0, index) + text.slice(index + 1),
			offset: index
		};
	};

	const findInBlock = (block: JSONBlock, currentPath: number[]): CursorPosition | null => {
		if (block.content) {
			let accumulatedOffset = 0;
			let contentIndex = -1;
			let lastWasText = false;

			for (const item of block.content) {
				if ('text' in item) {
					if (!lastWasText) {
						contentIndex++;
						accumulatedOffset = 0;
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
					continue;
				}

				contentIndex++;
				accumulatedOffset = 0;
				lastWasText = false;
			}
		}

		if (block.children) {
			for (const [index, child] of block.children.entries()) {
				const result = findInBlock(child, [...currentPath, index]);
				if (result) {
					return result;
				}
			}
		}

		return null;
	};

	let startPosition: CursorPosition | null = null;
	for (const [index, block] of value.entries()) {
		const result = findInBlock(block, [index]);
		if (result) {
			startPosition = result;
			break;
		}
	}

	let endPosition: CursorPosition | null = null;
	if (startPosition) {
		for (const [index, block] of value.entries()) {
			const result = findInBlock(block, [index]);
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

const findBlockAtPath = (edytor: Edytor, p: number[]) => {
	let block = edytor.root;
	for (const index of p) {
		block = block?.children[index];
	}

	if (!block) {
		throw new Error(`Block not found at path ${p.join('.')}`);
	}

	return block;
};

const findJSONBlockAtPath = (doc: JSONDoc, p: number[]) => {
	let block: JSONBlock | undefined = doc.children[p[0]];
	for (const index of p.slice(1)) {
		block = block?.children?.[index];
	}

	if (!block) {
		throw new Error(`Fixture block not found at path ${p.join('.')}`);
	}

	return block;
};

const getGroupedContentIndexMap = (content: (JSONText | JSONInlineBlock)[] = []) => {
	if (content.length === 0) {
		return [0];
	}

	const grouped: ('text' | 'inline')[] = [];
	const logicalToGroupedIndex: number[] = [];
	let logicalIndex = -1;
	let lastWasText = false;

	for (const part of content) {
		const isInlineBlock = 'type' in part;
		const lastGroupedPart = grouped.at(-1);

		if (isInlineBlock) {
			logicalIndex++;
			if (lastGroupedPart === 'inline') {
				grouped.push('text');
			}
			logicalToGroupedIndex[logicalIndex] = grouped.length;
			grouped.push('inline');
			lastWasText = false;
			continue;
		}

		if (!lastWasText) {
			logicalIndex++;
			if (lastGroupedPart !== 'text') {
				grouped.push('text');
			}
			logicalToGroupedIndex[logicalIndex] = grouped.length - 1;
		}

		lastWasText = true;
	}

	if (grouped[0] === 'inline') {
		return logicalToGroupedIndex.map((index) => index + 1);
	}

	return logicalToGroupedIndex;
};

export const findBlockAndTextAtFixturePath = (edytor: Edytor, doc: JSONDoc, path: number[]) => {
	if (path.length < 2) {
		throw new Error(`Expected a block content path, received "${path.join('.')}"`);
	}

	const blockPath = path.slice(0, -1);
	const logicalPartIndex = path.at(-1)!;
	const block = findBlockAtPath(edytor, blockPath);
	const fixtureBlock = findJSONBlockAtPath(doc, blockPath);
	const groupedIndex = getGroupedContentIndexMap(fixtureBlock.content)[logicalPartIndex];

	if (groupedIndex === undefined) {
		throw new Error(`Fixture content part not found at path ${path.join('.')}`);
	}

	const part = block.content.at(groupedIndex);
	if (!(part instanceof Text)) {
		throw new Error(`Fixture path ${path.join('.')} did not resolve to a text part`);
	}

	return { block, text: part };
};

const getPartPath = (part: ContentPart) => {
	const actualIndex = part.parent.content.findIndex((candidate) => {
		if (candidate === part) {
			return true;
		}

		return 'id' in candidate && 'id' in part && candidate.id === part.id;
	});
	return [...part.parent.path, actualIndex === -1 ? part.index : actualIndex];
};

const getSelectedContent = (
	texts: Text[],
	startText: Text,
	endText: Text,
	startOffset: number,
	endOffset: number
) => {
	if (texts.length === 0) {
		return '';
	}

	if (texts.length === 1) {
		return startText.stringContent.slice(startOffset, endOffset);
	}

	return texts
		.map((text, index) => {
			if (index === 0) {
				return text.stringContent.slice(startOffset);
			}
			if (text === endText) {
				return text.stringContent.slice(0, endOffset);
			}
			return text.stringContent;
		})
		.join('');
};

const getBlocksInSelection = (startBlock: Block, endBlock: Block) => {
	const blocks = startBlock.edytor.blocksBetween(startBlock, endBlock);
	if (blocks.at(-1) !== endBlock) {
		throw new Error('Failed to resolve block range from JSX DSL fixture');
	}
	return blocks;
};

const getContentPartsInSelection = (blocks: Block[], startText: Text, endText: Text) => {
	const contentParts = blocks.flatMap((block) => block.content);
	const startIndex = contentParts.indexOf(startText);
	const endIndex = contentParts.indexOf(endText);

	if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
		throw new Error('Failed to resolve content parts from JSX DSL fixture');
	}

	return contentParts.slice(startIndex, endIndex + 1);
};

const assertBlockInvariants = (block: Block) => {
	expect(block.content.length).toBeGreaterThan(0);
	expect(block.content[0]).toBeInstanceOf(Text);
	expect(block.content.at(-1)).toBeInstanceOf(Text);

	for (const [index, part] of block.content.entries()) {
		const nextPart = block.content[index + 1];
		if (!nextPart) {
			continue;
		}

		expect(part instanceof Text && nextPart instanceof Text).toBe(false);
		expect(part instanceof InlineBlock && nextPart instanceof InlineBlock).toBe(false);
	}

	for (const child of block.children) {
		assertBlockInvariants(child);
	}
};

export const createTestEdytor = (
	jsx: RenderedNode,
	options: TestEdytorOptions = {}
): { edytor: Edytor; expect: (jsx: RenderedNode) => void } => {
	const value = structuredClone(options.value ?? jsx.value) as JSONDoc;
	const { start, end } = findCursorPosition(value);
	const edytor = new Edytor({
		value,
		plugins: options.plugins ?? defaultPlugins,
		readonly: options.readonly,
		doc: options.doc,
		awareness: options.awareness,
		sync: options.sync
	});

	if (start) {
		const { path: startPath, offset: startOffset } = start;
		const { path: endPath, offset: endOffset } = end ?? { path: startPath, offset: startOffset };
		const { text: startText } = findBlockAndTextAtFixturePath(edytor, value, startPath);
		const { text: endText } = findBlockAndTextAtFixturePath(edytor, value, endPath);
		edytor.selection.setRangeStateAtTextOffsets(startText, startOffset, endText, endOffset);
	}

	return { edytor, expect: expectEdytorValue(edytor) };
};

const setSelectionState = (
	edytor: Edytor,
	startText: Text,
	startOffset: number,
	endText: Text = startText,
	endOffset: number = startOffset,
	isReversed = false
) =>
	edytor.selection.setRangeStateAtTextOffsets(startText, startOffset, endText, endOffset, {
		isReversed
	});

const patchOperationSelectionApis = (edytor: Edytor) => {
	edytor.selection.setAtTextOffset = async (
		textOrId,
		textOffset = edytor.selection.state.yStart
	) => {
		if (!textOrId || typeof textOffset !== 'number') {
			return;
		}

		const text = textOrId instanceof Text ? textOrId : edytor.idToText.get(textOrId);
		if (!text) {
			return;
		}

		setSelectionState(edytor, text, Math.max(0, Math.min(textOffset, text.length)));
	};

	edytor.selection.setAtTextsRange = async (startText, endText) => {
		setSelectionState(edytor, startText, 0, endText, endText.length);
	};

	edytor.selection.setAtBlockRange = async (
		block,
		startOffset = 0,
		endOffset = block?.lastText!.length
	) => {
		if (!block) {
			return;
		}

		setSelectionState(edytor, block.firstText!, startOffset, block.lastText!, endOffset);
	};

	edytor.selection.setAtRange = async (startText, startOffset, endText, endOffset, options) => {
		if (
			!startText ||
			!endText ||
			typeof startOffset !== 'number' ||
			typeof endOffset !== 'number'
		) {
			return;
		}

		setSelectionState(edytor, startText, startOffset, endText, endOffset, options?.isReversed);
	};
};

export const createOperationEdytor = (jsx: RenderedNode, options: TestEdytorOptions = {}) => {
	const testEdytor = createTestEdytor(jsx, options);

	patchOperationSelectionApis(testEdytor.edytor);
	testEdytor.edytor.selection.init();

	return testEdytor;
};

/**
 * Canonicalization for value comparisons — serialized text values may
 * arrive segmented at CRDT-item or normalization boundaries even when the
 * marks match. Fixtures describe structure, not segmentation, so value
 * comparisons re-merge adjacent equal-mark text — the same treatment
 * `removeIds` already gives volatile block ids.
 */
const marksKey = (marks: unknown): string =>
	marks == null
		? ''
		: JSON.stringify(
				Object.entries(marks as Record<string, unknown>)
					.filter(([, v]) => v !== undefined)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			);

export const stripAttribution = <T extends object>(items: readonly T[]): T[] => {
	const out: Record<string, unknown>[] = [];
	for (const item of items) {
		const { attribution: _attribution, ...rest } = item as Record<string, unknown>;
		const prev = out[out.length - 1];
		if (
			prev !== undefined &&
			'text' in rest &&
			'text' in prev &&
			marksKey(prev.marks) === marksKey(rest.marks)
		) {
			prev.text = String(prev.text) + String(rest.text);
			continue;
		}
		out.push(rest);
	}
	return out as T[];
};

export const removeIds = (value: JSONBlock[]) => {
	return value.map((block) => {
		if (block.id) {
			delete block.id;
		}
		if (block.children) {
			block.children = removeIds(block.children);
		}
		if (block.content) {
			block.content = stripAttribution(
				block.content.map((content) => {
					if ('id' in content) {
						delete content.id;
					}
					return content;
				})
			);
		}
		return block;
	});
};

export const expectBlockInvariantSnapshot = (subject: Block | Edytor) => {
	const block = subject instanceof Edytor ? subject.root : subject;
	if (!block) {
		throw new Error('Expected an initialized editor root before asserting invariants');
	}

	assertBlockInvariants(block);
};

export const expectTextValue = (text: Text, expected: JSONText[]) => {
	expect(stripAttribution(structuredClone(text.value))).toEqual(stripAttribution(expected));
};

export const expectMarksState = (text: Text, expected: MarkStateExpectation) => {
	if ('pending' in expected) {
		expect(text.edytor.selection.pending).toEqual(expected.pending);
	}

	if (expected.range) {
		expect(text.getMarksAtRange(expected.range.start, expected.range.end)).toEqual(
			expected.range.value
		);
	}
};

export const expectEdytorValue = (edytor: Edytor) => (jsx: RenderedNode) => {
	const { children } = jsx.value as { children: JSONBlock[] };

	expectBlockInvariantSnapshot(edytor);
	const value = removeIds(
		JSON.parse(JSON.stringify(edytor.root?.value.children ?? [])) as JSONBlock[]
	);
	const expected = removeIds(JSON.parse(JSON.stringify(children)) as JSONBlock[]);

	expect(value).toEqual(expected);
};

export const expectEydorValue = expectEdytorValue;

/**
 * `edytor.value` normalized for fixture comparison — strips volatile ids
 * and U7 attribution provenance, re-merging authorship-boundary text
 * splits. Use where a result object embeds `edytor.value` for
 * `toMatchObject`/`toEqual` assertions (see history policy fixtures).
 */
export const canonicalValue = <T extends { children?: JSONBlock[] }>(value: T): T => ({
	...value,
	children: value.children ? removeIds(structuredClone(value.children)) : value.children
});

export const findBlockAndPartAtPath =
	(edytor: Edytor) =>
	(path: number[]): { block: Block; part: ContentPart } => {
		if (path.length < 2) {
			throw new Error(`Expected a block content path, received "${path.join('.')}"`);
		}

		const block = findBlockAtPath(edytor, path.slice(0, -1));
		const partIndex = path.at(-1)!;
		const part = block.content.at(partIndex);

		if (!part) {
			throw new Error(`Content part not found at path ${path.join('.')}`);
		}

		return { block, part };
	};

export const findBlockAndTextAtPath =
	(edytor: Edytor) =>
	(path: number[]): { block: Block; text: Text } => {
		const { block, part } = findBlockAndPartAtPath(edytor)(path);

		if (!(part instanceof Text)) {
			throw new Error(
				`Path ${path.join('.')} resolves to an inline block; use findBlockAndPartAtPath instead`
			);
		}

		return { block, text: part };
	};

export const expectSelection = (edytor: Edytor, expected: SelectionExpectation) => {
	const { state } = edytor.selection;

	if (expected.startBlockPath) {
		expect(state.startBlock?.path).toEqual(expected.startBlockPath);
	}
	if (expected.endBlockPath) {
		expect(state.endBlock?.path).toEqual(expected.endBlockPath);
	}
	if (expected.startTextPath) {
		expect(state.startText ? getPartPath(state.startText) : null).toEqual(expected.startTextPath);
	}
	if (expected.endTextPath) {
		expect(state.endText ? getPartPath(state.endText) : null).toEqual(expected.endTextPath);
	}
	if (expected.blockPaths) {
		expect(state.blocks.map((block) => block.path)).toEqual(expected.blockPaths);
	}
	if (expected.textPaths) {
		expect(state.texts.map((text) => getPartPath(text))).toEqual(expected.textPaths);
	}
	if (expected.selectedBlockPaths) {
		expect(Array.from(edytor.selection.selectedBlocks).map((block) => block.path)).toEqual(
			expected.selectedBlockPaths
		);
	}
	if (expected.focusedBlockPaths) {
		expect(Array.from(edytor.selection.focusedBlocks).map((block) => block.path)).toEqual(
			expected.focusedBlockPaths
		);
	}
	if (expected.yStart !== undefined) {
		expect(state.yStart).toBe(expected.yStart);
	}
	if (expected.yEnd !== undefined) {
		expect(state.yEnd).toBe(expected.yEnd);
	}
	if (expected.length !== undefined) {
		expect(state.length).toBe(expected.length);
	}
	if (expected.content !== undefined) {
		expect(state.content).toBe(expected.content);
	}
	if (expected.isCollapsed !== undefined) {
		expect(state.isCollapsed).toBe(expected.isCollapsed);
	}
	if (expected.isTextSpanning !== undefined) {
		expect(state.isTextSpanning).toBe(expected.isTextSpanning);
	}
	if (expected.isBlockSpanning !== undefined) {
		expect(state.isBlockSpanning).toBe(expected.isBlockSpanning);
	}
};

export const expectOperationResult = (
	result: Block | Text | InlineBlock | Block[] | readonly [Text | null, number] | null | void,
	expected: OperationResultExpectation
) => {
	switch (expected.kind) {
		case 'void':
			expect(result).toBeUndefined();
			return;
		case 'null':
			expect(result).toBeNull();
			return;
		default:
			break;
	}

	if (expected.kind === 'block') {
		expect(result).toBeInstanceOf(Block);
		if (!(result instanceof Block)) {
			throw new Error('Expected a block result');
		}
		expect(result.path).toEqual(expected.path);
		if (expected.type) {
			expect(result.type).toBe(expected.type);
		}
		return;
	}

	if (expected.kind === 'text') {
		expect(result).toBeInstanceOf(Text);
		if (!(result instanceof Text)) {
			throw new Error('Expected a text result');
		}
		expect(getPartPath(result)).toEqual(expected.path);
		if (expected.content !== undefined) {
			expect(result.stringContent).toBe(expected.content);
		}
		return;
	}

	if (expected.kind === 'inline-block') {
		expect(result).toBeInstanceOf(InlineBlock);
		if (!(result instanceof InlineBlock)) {
			throw new Error('Expected an inline block result');
		}
		expect(getPartPath(result)).toEqual(expected.path);
		if (expected.type) {
			expect(result.type).toBe(expected.type);
		}
		return;
	}

	if (expected.kind === 'blocks') {
		expect(Array.isArray(result)).toBe(true);
		if (!Array.isArray(result)) {
			throw new Error('Expected a block array result');
		}
		expect(result.every((block) => block instanceof Block)).toBe(true);
		expect(result.map((block) => block.path)).toEqual(expected.paths);
		return;
	}

	if (expected.kind === 'cursor') {
		expect(Array.isArray(result)).toBe(true);
		if (!Array.isArray(result)) {
			throw new Error('Expected a cursor tuple result');
		}
		const [text, offset] = result as unknown as readonly [Text | null, number];
		if (!text) {
			throw new Error('Expected a text cursor target');
		}
		expect(text).toBeInstanceOf(Text);
		expect(getPartPath(text)).toEqual(expected.path);
		expect(offset).toBe(expected.offset);
	}
};

const flushOperations = async () => {
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
};

export const runBeforeInput = async (
	edytor: Edytor,
	{ inputType, data, text }: BeforeInputOptions
) => {
	const event = new Event('beforeinput', {
		bubbles: true,
		cancelable: true
	}) as InputEvent;

	Object.defineProperties(event, {
		inputType: {
			value: inputType
		},
		data: {
			value: data ?? null
		},
		dataTransfer: {
			value: text
				? {
						getData: (type: string) => (type === 'text/plain' ? text : '')
					}
				: null
		}
	});

	await edytor.onBeforeInput(event);
	await flushOperations();

	return {
		event,
		defaultPrevented: event.defaultPrevented
	};
};

const keyboardEventInitFromCombo = (combo: string): KeyboardEventInit => {
	const parts = combo.toLowerCase().split('+');
	const key = parts.at(-1) ?? '';

	return {
		key:
			key === 'space'
				? ' '
				: key === 'arrowup'
					? 'ArrowUp'
					: key === 'arrowdown'
						? 'ArrowDown'
						: key === 'arrowleft'
							? 'ArrowLeft'
							: key === 'arrowright'
								? 'ArrowRight'
								: key === 'enter'
									? 'Enter'
									: key === 'backspace'
										? 'Backspace'
										: key === 'delete'
											? 'Delete'
											: key === 'escape'
												? 'Escape'
												: key === 'tab'
													? 'Tab'
													: key,
		ctrlKey: parts.includes('mod') || parts.includes('ctrl'),
		metaKey: false,
		altKey: parts.includes('alt'),
		shiftKey: parts.includes('shift'),
		bubbles: true,
		cancelable: true
	};
};

export const runHotkey = async (
	edytor: Edytor,
	combo: string,
	overrides: KeyboardEventInit = {}
) => {
	const init = { ...keyboardEventInitFromCombo(combo), ...overrides };
	const event =
		typeof KeyboardEvent !== 'undefined'
			? new KeyboardEvent('keydown', init)
			: (() => {
					const fallbackEvent = {
						...init,
						defaultPrevented: false,
						preventDefault() {
							this.defaultPrevented = true;
						},
						stopPropagation() {}
					};

					return fallbackEvent as KeyboardEvent;
				})();

	onKeyDown.call(edytor, event);
	await flushOperations();

	return {
		event,
		defaultPrevented: event.defaultPrevented
	};
};
