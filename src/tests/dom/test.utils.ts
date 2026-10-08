import { render, waitFor, type RenderResult } from '@testing-library/svelte';
import { expect } from 'vitest';
import { tick } from 'svelte';

import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { mentionPlugin } from '../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONDoc } from '$lib/utils/json.js';
import { Text as ModelText } from '$lib/text/text.svelte.js';
import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
import type { Awareness, DocChange, EdytorDocument, YDoc } from '$lib/crdt/index.js';
import type { EdytorSync, PresenceOptions } from '$lib/collaboration/index.js';
import type { RenderedNode } from '../jsx/types.js';
import {
	expectEdytorValue,
	findBlockAndTextAtFixturePath,
	findCursorPosition
} from '../test.utils.js';
import EdytorHarness from './EdytorHarness.svelte';
import { compareAllCells } from './cellsShadow.js';

export type RenderDomEdytorOptions = {
	plugins?: Plugin[];
	readonly?: boolean;
	placeholder?: string;
	translate?: 'yes' | 'no';
	spellcheck?: boolean;
	autocorrect?: 'on' | 'off';
	autocomplete?: 'on' | 'off';
	autocapitalize?: 'off' | 'none' | 'on' | 'sentences' | 'words' | 'characters';
	inputmode?: 'none' | 'text' | 'decimal' | 'numeric' | 'tel' | 'search' | 'email' | 'url';
	enterkeyhint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send';
	doc?: YDoc;
	awareness?: Awareness;
	document?: EdytorDocument;
	sync?: EdytorSync;
	/** The view's presence options (rows about what is published pass `{ throttle: 0 }`). */
	presence?: PresenceOptions;
	value?: JSONDoc;
	autoSelectFixture?: boolean;
	onChange?: (value: JSONDoc) => void;
	onDocChange?: (change: DocChange) => void;
	onSelectionChange?: (selection: EdytorSelection) => void;
	/** The root textbox's name and id, forwarded by `<Edytor>`. */
	label?: {
		'aria-label'?: string;
		'aria-labelledby'?: string;
		'aria-describedby'?: string;
		id?: string;
	};
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

/** The mounted element of a text, once its cell mounted (a few flushes at most). */
export const textNodeOf = async (text: ModelText | null | undefined): Promise<HTMLElement> => {
	for (let attempt = 0; attempt <= 10 && !text?.node; attempt++) await tick();
	if (!text?.node) throw new Error('Failed to find text node');
	return text.node;
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
	compareAllCells('flush');
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

/**
 * Canonical block JSON for oracle assertions: full descendant structure —
 * type, data, content parts (text + marks, or inline type + data), and
 * recursive children. `canonicalBlock(block, true)` also carries block and
 * inline ids; `assertCanonicalTree` compares an expected tree against the
 * id-carrying actual tree, stripping an actual id only where the expected
 * node does not pin one — so fixtures may assert exact identity at any
 * node they choose while staying concise elsewhere.
 */
export type CanonicalBlock = {
	type: string;
	id?: string;
	data?: Record<string, unknown>;
	content?: (
		| { text: string; marks?: Record<string, unknown> }
		| { type: string; id?: string; data?: Record<string, unknown> }
	)[];
	children?: CanonicalBlock[];
};

export const canonicalBlock = (block: JSONBlock, withIds = false): CanonicalBlock => ({
	type: block.type,
	...(withIds && block.id ? { id: block.id } : {}),
	...(block.data && Object.keys(block.data).length ? { data: block.data } : {}),
	...(block.content?.length
		? {
				content: block.content.map((part) =>
					'text' in part
						? { text: part.text, ...(part.marks ? { marks: part.marks } : {}) }
						: {
								type: part.type,
								...(withIds && part.id ? { id: part.id } : {}),
								...(part.data ? { data: part.data } : {})
							}
				)
			}
		: {}),
	...(block.children?.length
		? { children: block.children.map((child) => canonicalBlock(child, withIds)) }
		: {})
});

export const canonicalTree = (edytor: Edytor, withIds = false): CanonicalBlock[] =>
	edytor.value.children?.map((block) => canonicalBlock(block, withIds)) ?? [];

/** Strip actual-side ids the expected tree does not pin, recursively. */
const scrubUnpinnedIds = (
	actual: CanonicalBlock,
	expected: CanonicalBlock | undefined
): CanonicalBlock => {
	const node: CanonicalBlock = { ...actual };
	if (expected?.id === undefined) delete node.id;
	node.content = actual.content?.map((part, index) => {
		const expectedPart = expected?.content?.[index] as { id?: string } | undefined;
		const copy = { ...part } as { id?: string };
		if (expectedPart?.id === undefined) delete copy.id;
		return copy;
	}) as CanonicalBlock['content'];
	node.children = actual.children?.map((child, index) =>
		scrubUnpinnedIds(child, expected?.children?.[index])
	);
	return node;
};

/** The single assertion golden programs and defect canaries share.
 * Expected nodes pin `id` wherever identity must match; unpinned nodes
 * compare structure only. */
export const assertCanonicalTree = (edytor: Edytor, expected: CanonicalBlock[]) =>
	expect(
		canonicalTree(edytor, true).map((block, index) => scrubUnpinnedIds(block, expected[index]))
	).toEqual(expected);

/** path-joined id map (`"0"`→id, `"1.2"`→id) for survivor-identity checks. */
export const blockIdMap = (edytor: Edytor): Map<string, string> => {
	const map = new Map<string, string>();
	const walk = (blocks: JSONBlock[] | undefined, prefix: string) => {
		blocks?.forEach((block, index) => {
			const path = prefix === '' ? `${index}` : `${prefix}.${index}`;
			if (block.id) map.set(path, block.id);
			walk(block.children, path);
		});
	};
	walk(edytor.value.children, '');
	return map;
};

export const setNativeSelection = async (
	edytor: Edytor,
	startText: ModelText | null | undefined,
	startOffset: number,
	endText = startText,
	endOffset = startOffset,
	options: { reversed?: boolean } = {}
) => {
	if (!startText || !endText) {
		throw new Error('Cannot set a native selection without mounted start and end texts');
	}

	// A fixture placement IS a user decision — mark the gesture so the
	// projector classifies it as intent, not as render drift.
	edytor.markUserGesture();
	const startNode = await textNodeOf(startText);
	const endNode = await textNodeOf(endText);
	const startLeaf = findDomTextNode(startNode, startOffset);
	const endLeaf = findDomTextNode(endNode, endOffset);
	const selection = window.getSelection();

	if (!selection) {
		throw new Error('window.getSelection() is not available in the DOM test environment');
	}

	if (options.reversed) {
		// A Range can only hold the forward document order — a reversed
		// selection needs the anchor at the logical END and the focus at
		// the logical START, which only `setBaseAndExtent` expresses.
		selection.setBaseAndExtent(endLeaf.node, endLeaf.offset, startLeaf.node, startLeaf.offset);
	} else {
		const range = document.createRange();
		range.setStart(startLeaf.node, startLeaf.offset);
		range.setEnd(endLeaf.node, endLeaf.offset);
		selection.removeAllRanges();
		selection.addRange(range);
	}
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
			inputmode: options.inputmode,
			enterkeyhint: options.enterkeyhint,
			doc: options.doc,
			awareness: options.awareness,
			document: options.document,
			sync: options.sync,
			presence: options.presence,
			onChange: options.onChange,
			onDocChange: options.onDocChange,
			onSelectionChange: options.onSelectionChange,
			label: options.label,
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
	const text = position === 'end' ? block.lastText! : block.firstText!;
	const offset =
		position === 'start' ? 0 : position === 'end' ? text.length : Math.floor(text.length / 2);

	await clickText(edytor, text, offset);
};

export const clickPlaceholder = async (edytor: Edytor, blockPath: number[]) => {
	const block = findBlockAtPath(edytor, blockPath);
	const placeholder = block.node?.querySelector('[data-edytor-text][data-placeholder]');

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

	await setNativeSelection(edytor, block.firstText!, 0);
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
	const startNode = await textNodeOf(start);
	const endNode = await textNodeOf(end);
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
