import { render, waitFor, type RenderResult } from '@testing-library/svelte';
import { expect } from 'vitest';
import { tick } from 'svelte';

import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONDoc } from '$lib/utils/json.js';
import { Text as ModelText } from '$lib/text/text.svelte.js';
import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
import type { Awareness, YDoc } from '$lib/crdt/index.js';
import type { EdytorSync } from '$lib/collaboration/index.js';
import type { RenderedNode } from '../jsx/types.js';
import {
	expectEdytorValue,
	findBlockAndTextAtFixturePath,
	findCursorPosition
} from '../test.utils.js';
import EdytorHarness from './EdytorHarness.svelte';

export type RenderDomEdytorOptions = {
	plugins?: Plugin[];
	readonly?: boolean;
	placeholder?: string;
	translate?: 'yes' | 'no';
	spellcheck?: boolean;
	autocorrect?: 'on' | 'off';
	autocomplete?: 'on' | 'off';
	autocapitalize?: 'off' | 'none' | 'on' | 'sentences' | 'words' | 'characters';
	doc?: YDoc;
	awareness?: Awareness;
	sync?: EdytorSync;
	value?: JSONDoc;
	autoSelectFixture?: boolean;
	onChange?: (value: JSONBlock) => void;
	onSelectionChange?: (selection: EdytorSelection) => void;
};

type BeforeInputPayload = {
	inputType: string;
	data?: string;
	text?: string;
};

type KeyDownPayload = {
	key: string;
	code?: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
};

type TextReference = ModelText | number[];

type BlockPosition = 'start' | 'center' | 'end';

type CompositionStep =
	| {
			type: 'compositionstart' | 'compositionupdate' | 'compositionend';
			data?: string;
	  }
	| {
			type: 'beforeinput';
			inputType: string;
			data?: string;
	  };

export type NativeSelectionExpectation = {
	anchorNodeType?: 'text' | 'element' | null;
	focusNodeType?: 'text' | 'element' | null;
	anchorOffset?: number;
	focusOffset?: number;
	collapsed?: boolean;
	text?: string | null;
};

const defaultPlugins = [richTextPlugin, mentionPlugin];

const findBlockAtPath = (edytor: Edytor, path: number[]) => {
	let block: Block | undefined = edytor.root;

	for (const index of path) {
		block = block?.children[index];
	}

	if (!block) {
		throw new Error(`Block not found at path ${path.join('.')}`);
	}

	return block;
};

const findTextAtPath = (edytor: Edytor, path: number[]) => {
	if (path.length < 2) {
		throw new Error(`Expected a text path, received "${path.join('.')}"`);
	}

	const block = findBlockAtPath(edytor, path.slice(0, -1));
	const part = block.content.at(path.at(-1)!);

	if (!(part instanceof ModelText)) {
		throw new Error(`Path ${path.join('.')} does not resolve to a text part`);
	}

	return part;
};

const resolveText = (edytor: Edytor, text: TextReference) => {
	if (!Array.isArray(text)) {
		return text;
	}

	return findTextAtPath(edytor, text);
};

const findDomTextNode = (node: HTMLElement, offset: number) => {
	const treeWalker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
	let currentNode = treeWalker.nextNode();
	let currentOffset = 0;

	while (currentNode) {
		const length = currentNode.textContent?.length ?? 0;
		const endOffset = currentOffset + length;
		if (offset >= currentOffset && offset <= endOffset) {
			return {
				node: currentNode,
				offset: offset - currentOffset
			};
		}
		currentOffset = endOffset;
		currentNode = treeWalker.nextNode();
	}

	return {
		node,
		offset: Math.min(offset, node.childNodes.length)
	};
};

export const flushDomUpdates = async () => {
	for (let attempt = 0; attempt < 4; attempt++) {
		await Promise.resolve();
		await tick();
	}
	await new Promise((resolve) => setTimeout(resolve, 0));
	await Promise.resolve();
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await Promise.resolve();
	await tick();
};

const setElementSelection = async (
	edytor: Edytor,
	element: Element,
	offset = 0,
	endElement = element,
	endOffset = offset,
	dispatchClick = false,
	detail = 1
) => {
	const selection = window.getSelection();

	if (!selection) {
		throw new Error('window.getSelection() is not available in the DOM test environment');
	}

	const range = document.createRange();
	range.setStart(element, offset);
	range.setEnd(endElement, endOffset);
	selection.removeAllRanges();
	selection.addRange(range);
	(element.parentElement ?? edytor.node)?.focus();
	document.dispatchEvent(new Event('selectionchange'));

	if (dispatchClick) {
		element.dispatchEvent(
			new MouseEvent('click', {
				bubbles: true,
				cancelable: true,
				detail
			})
		);
	}

	await flushDomUpdates();
};

export const setNativeSelection = async (
	edytor: Edytor,
	startText: ModelText | null | undefined,
	startOffset: number,
	endText = startText,
	endOffset = startOffset
) => {
	if (!startText || !endText) {
		throw new Error('Cannot set a native selection without mounted start and end texts');
	}

	const startNode = await edytor.getTextNode(startText);
	const endNode = await edytor.getTextNode(endText);
	const startLeaf = findDomTextNode(startNode, startOffset);
	const endLeaf = findDomTextNode(endNode, endOffset);
	const selection = window.getSelection();

	if (!selection) {
		throw new Error('window.getSelection() is not available in the DOM test environment');
	}

	const range = document.createRange();
	range.setStart(startLeaf.node, startLeaf.offset);
	range.setEnd(endLeaf.node, endLeaf.offset);
	selection.removeAllRanges();
	selection.addRange(range);
	(startLeaf.node.parentElement ?? endLeaf.node.parentElement ?? edytor.node)?.focus();
	document.dispatchEvent(new Event('selectionchange'));
	await flushDomUpdates();
};

export const renderDomEdytor = async (
	jsx: RenderedNode,
	options: RenderDomEdytorOptions = {}
): Promise<
	RenderResult<typeof EdytorHarness> & {
		edytor: Edytor;
		editor: HTMLDivElement;
		expect: (jsx: RenderedNode) => void;
		value: JSONDoc;
	}
> => {
	const value = structuredClone(options.value ?? jsx.value) as JSONDoc;
	const cursor = findCursorPosition(value);
	let edytor: Edytor | undefined;

	const rendered = render(EdytorHarness, {
		props: {
			value,
			plugins: options.plugins ?? defaultPlugins,
			readonly: options.readonly,
			placeholder: options.placeholder,
			translate: options.translate,
			spellcheck: options.spellcheck,
			autocorrect: options.autocorrect,
			autocomplete: options.autocomplete,
			autocapitalize: options.autocapitalize,
			doc: options.doc,
			awareness: options.awareness,
			sync: options.sync,
			onChange: options.onChange,
			onSelectionChange: options.onSelectionChange,
			onReady: (nextEdytor: Edytor) => {
				edytor = nextEdytor;
			}
		}
	});

	await waitFor(() => {
		if (!edytor?.root) {
			throw new Error('Editor instance is not ready yet');
		}
		if (!rendered.container.querySelector('[data-edytor]')) {
			throw new Error('Editor DOM root is not attached yet');
		}
	});

	const editor = rendered.container.querySelector('[data-edytor]') as HTMLDivElement | null;
	if (!editor || !edytor) {
		throw new Error('Failed to mount the editor DOM harness');
	}

	if (options.autoSelectFixture !== false && cursor.start) {
		const start = findBlockAndTextAtFixturePath(edytor, value, cursor.start.path);
		const end = cursor.end ? findBlockAndTextAtFixturePath(edytor, value, cursor.end.path) : start;

		await setNativeSelection(edytor, start.text, cursor.start.offset, end.text, cursor.end?.offset);
	}

	return {
		...rendered,
		edytor,
		editor,
		value,
		expect: expectEdytorValue(edytor)
	};
};

export const dispatchDomBeforeInput = async (
	target: HTMLElement,
	{ inputType, data, text }: BeforeInputPayload
) => {
	const event = new Event('beforeinput', {
		bubbles: true,
		cancelable: true
	}) as InputEvent;

	Object.defineProperties(event, {
		inputType: {
			value: inputType,
			configurable: true
		},
		data: {
			value: data ?? null,
			configurable: true
		},
		dataTransfer: {
			value:
				text === undefined
					? null
					: ({
							getData: (type: string) => (type === 'text/plain' ? text : '')
						} satisfies Pick<DataTransfer, 'getData'>),
			configurable: true
		}
	});

	const dispatched = target.dispatchEvent(event);
	await flushDomUpdates();

	return {
		defaultPrevented: event.defaultPrevented || !dispatched
	};
};

export const dispatchDomInput = async (
	target: HTMLElement,
	{
		inputType = 'insertText',
		data = null,
		isComposing = false
	}: {
		inputType?: string;
		data?: string | null;
		isComposing?: boolean;
	} = {}
) => {
	const event = new Event('input', {
		bubbles: true,
		cancelable: false
	}) as InputEvent;

	Object.defineProperties(event, {
		inputType: {
			value: inputType,
			configurable: true
		},
		data: {
			value: data,
			configurable: true
		},
		isComposing: {
			value: isComposing,
			configurable: true
		}
	});

	target.dispatchEvent(event);
	await flushDomUpdates();
};

export const dispatchPaste = async (target: HTMLElement, text: string) => {
	return dispatchDomBeforeInput(target, {
		inputType: 'insertFromPaste',
		text
	});
};

const dispatchClipboardEvent = async (target: HTMLElement, type: 'copy' | 'cut', text = '') => {
	const clipboardData = new Map<string, string>();
	const event = new Event(type, {
		bubbles: true,
		cancelable: true
	}) as ClipboardEvent;

	Object.defineProperty(event, 'clipboardData', {
		value: {
			getData: (requestedType: string) =>
				clipboardData.get(requestedType) ?? (requestedType === 'text/plain' ? text : ''),
			setData: (requestedType: string, value: string) => {
				clipboardData.set(requestedType, value);
				return true;
			}
		},
		configurable: true
	});

	const dispatched = target.dispatchEvent(event);
	await flushDomUpdates();

	return {
		defaultPrevented: event.defaultPrevented || !dispatched,
		clipboardData: Object.fromEntries(clipboardData)
	};
};

export const dispatchCut = async (target: HTMLElement, text = '') => {
	return dispatchClipboardEvent(target, 'cut', text);
};

export const dispatchCopy = async (target: HTMLElement, text = '') => {
	return dispatchClipboardEvent(target, 'copy', text);
};

export const dispatchClipboardPaste = async (target: HTMLElement, data: Record<string, string>) => {
	const event = new Event('paste', {
		bubbles: true,
		cancelable: true
	}) as ClipboardEvent;

	Object.defineProperty(event, 'clipboardData', {
		value: {
			getData: (requestedType: string) => data[requestedType] ?? ''
		} satisfies Pick<DataTransfer, 'getData'>,
		configurable: true
	});

	const dispatched = target.dispatchEvent(event);
	await flushDomUpdates();

	return {
		defaultPrevented: event.defaultPrevented || !dispatched
	};
};

export const dispatchDomKeyDown = async (
	target: Document | HTMLElement,
	{
		key,
		code = key,
		metaKey = false,
		ctrlKey = false,
		shiftKey = false,
		altKey = false
	}: KeyDownPayload
) => {
	const event = new KeyboardEvent('keydown', {
		key,
		code,
		metaKey,
		ctrlKey,
		shiftKey,
		altKey,
		bubbles: true,
		cancelable: true
	});

	const dispatchTarget =
		target instanceof Document
			? (target.querySelector<HTMLElement>('[data-edytor]') ?? target)
			: target;
	const dispatched = dispatchTarget.dispatchEvent(event);
	await flushDomUpdates();

	return {
		defaultPrevented: event.defaultPrevented || !dispatched
	};
};

export const dispatchComposition = async (target: HTMLElement, steps: CompositionStep[]) => {
	const results: Array<{ type: string; defaultPrevented: boolean }> = [];

	for (const step of steps) {
		if (step.type === 'beforeinput') {
			const result = await dispatchDomBeforeInput(target, {
				inputType: step.inputType,
				data: step.data
			});
			results.push({
				type: step.inputType,
				defaultPrevented: result.defaultPrevented
			});
			continue;
		}

		const event = new Event(step.type, {
			bubbles: true,
			cancelable: true
		}) as CompositionEvent;

		Object.defineProperty(event, 'data', {
			value: step.data ?? '',
			configurable: true
		});

		const dispatched = target.dispatchEvent(event);
		await flushDomUpdates();
		results.push({
			type: step.type,
			defaultPrevented: event.defaultPrevented || !dispatched
		});
	}

	return results;
};

export const clickText = async (edytor: Edytor, text: TextReference, offset: number) => {
	const resolvedText = resolveText(edytor, text);
	await setNativeSelection(edytor, resolvedText, offset);

	if (resolvedText.node) {
		resolvedText.node.dispatchEvent(
			new MouseEvent('click', {
				bubbles: true,
				cancelable: true,
				detail: 1
			})
		);
		await flushDomUpdates();
	}
};

export const doubleClickText = async (edytor: Edytor, text: TextReference, offset: number) => {
	const resolvedText = resolveText(edytor, text);
	const content = resolvedText.stringContent;
	let start = Math.max(0, Math.min(offset, content.length));
	let end = start;

	while (start > 0 && /\S/.test(content[start - 1] ?? '')) {
		start--;
	}

	while (end < content.length && /\S/.test(content[end] ?? '')) {
		end++;
	}

	await setNativeSelection(edytor, resolvedText, start, resolvedText, end);

	if (resolvedText.node) {
		resolvedText.node.dispatchEvent(
			new MouseEvent('dblclick', {
				bubbles: true,
				cancelable: true,
				detail: 2
			})
		);
		await flushDomUpdates();
	}
};

export const tripleClickText = async (edytor: Edytor, text: TextReference, offset: number) => {
	const resolvedText = resolveText(edytor, text);
	await setNativeSelection(edytor, resolvedText, offset);

	if (!resolvedText.node) {
		throw new Error('Cannot triple click an unmounted text');
	}

	resolvedText.node.dispatchEvent(
		new MouseEvent('click', {
			bubbles: true,
			cancelable: true,
			detail: 3
		})
	);
	await new Promise((resolve) => requestAnimationFrame(resolve));
	await new Promise((resolve) => setTimeout(resolve, 0));
	await flushDomUpdates();
};

export const clickBlock = async (
	edytor: Edytor,
	blockPath: number[],
	position: BlockPosition = 'center'
) => {
	const block = findBlockAtPath(edytor, blockPath);
	const text = position === 'end' ? block.lastText : block.firstText;
	const offset =
		position === 'start' ? 0 : position === 'end' ? text.length : Math.floor(text.length / 2);

	await clickText(edytor, text, offset);
};

export const clickPlaceholder = async (edytor: Edytor, blockPath: number[]) => {
	const block = findBlockAtPath(edytor, blockPath);
	const placeholder = block.node?.querySelector('[data-edytor-text-placeholder]');

	if (!(placeholder instanceof HTMLElement)) {
		throw new Error(`Placeholder not found for block ${blockPath.join('.')}`);
	}

	for (const type of ['mousedown', 'mouseup', 'click']) {
		placeholder.dispatchEvent(
			new MouseEvent(type, {
				bubbles: true,
				cancelable: true,
				detail: 1
			})
		);
	}

	await setNativeSelection(edytor, block.firstText, 0);
};

export const dragSelection = async (
	edytor: Edytor,
	startText: TextReference,
	startOffset: number,
	endText: TextReference,
	endOffset: number,
	options: { reverse?: boolean } = {}
) => {
	const start = resolveText(edytor, startText);
	const end = resolveText(edytor, endText);
	const startNode = await edytor.getTextNode(start);
	const endNode = await edytor.getTextNode(end);
	const startLeaf = findDomTextNode(startNode, startOffset);
	const endLeaf = findDomTextNode(endNode, endOffset);
	const selection = window.getSelection();

	if (!selection) {
		throw new Error('window.getSelection() is not available in the DOM test environment');
	}

	selection.removeAllRanges();
	if (options.reverse && typeof selection.setBaseAndExtent === 'function') {
		selection.setBaseAndExtent(endLeaf.node, endLeaf.offset, startLeaf.node, startLeaf.offset);
	} else {
		const range = document.createRange();
		range.setStart(startLeaf.node, startLeaf.offset);
		range.setEnd(endLeaf.node, endLeaf.offset);
		selection.addRange(range);
	}

	(startLeaf.node.parentElement ?? endLeaf.node.parentElement ?? edytor.node)?.focus();
	document.dispatchEvent(new Event('selectionchange'));
	await flushDomUpdates();
};

export const expectNativeSelection = (expected: NativeSelectionExpectation) => {
	const selection = window.getSelection();
	const anchorNode = selection?.anchorNode ?? null;
	const focusNode = selection?.focusNode ?? null;

	const nodeType = (node: Node | null) => {
		if (!node) {
			return null;
		}
		return node.nodeType === Node.TEXT_NODE ? 'text' : 'element';
	};

	if (expected.anchorNodeType !== undefined) {
		expect(nodeType(anchorNode)).toBe(expected.anchorNodeType);
	}
	if (expected.focusNodeType !== undefined) {
		expect(nodeType(focusNode)).toBe(expected.focusNodeType);
	}
	if (expected.anchorOffset !== undefined) {
		expect(selection?.anchorOffset ?? null).toBe(expected.anchorOffset);
	}
	if (expected.focusOffset !== undefined) {
		expect(selection?.focusOffset ?? null).toBe(expected.focusOffset);
	}
	if (expected.collapsed !== undefined) {
		expect(selection?.isCollapsed ?? null).toBe(expected.collapsed);
	}
	if (expected.text !== undefined) {
		expect(anchorNode?.textContent ?? null).toBe(expected.text);
	}
};

export const expectFocusedBlocks = (edytor: Edytor, paths: number[][]) => {
	expect(Array.from(edytor.selection.focusedBlocks).map((block) => block.path)).toEqual(paths);
};
