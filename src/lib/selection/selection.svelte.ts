import { createAbsolutePositionFromRelativePosition, type RelativePosition } from 'yjs';
import { setCursorAtPosition } from '../utils/setCursor.js';
import { getId } from '../utils/getId.js';
import * as Y from 'yjs';
import type { Edytor } from '../edytor.svelte.js';
import { Text } from '../text/text.svelte.js';
import {
	getRangesFromSelection,
	getTextOfNode,
	getTextsInSelection,
	getYIndex
} from './selection.utils.js';
import type { Block } from '../block/block.svelte.js';
import { SvelteSet } from 'svelte/reactivity';
import { tick } from 'svelte';

type SelectionState = {
	selection: Selection | null;
	yStart: number;
	yEnd: number;
	start: number;
	end: number;
	length: number;
	content: string;
	isCollapsed: boolean;
	ranges: Range[];
	// If the selection is at the start of the yText
	isAtStart?: boolean;
	// If the selection is at the end of the yText
	isAtEnd?: boolean;
	startText: Text | null;
	endText: Text | null;
	texts: Text[];
	startNode: Node | null;
	endNode: Node | null;
	isTextSpanning: boolean;
};

type SavedPosition = {
	offset: number;
	range: Range;
	textNode: Text;
};
export class EdytorSelection {
	edytor: Edytor;
	focusedBlocks = new SvelteSet<Block>();
	selectedBlocks = new SvelteSet<Block>();
	state = $state<SelectionState>({
		selection: null,
		start: 0,
		end: 0,
		yStart: 0,
		yEnd: 0,
		length: 0,
		content: '',
		isCollapsed: true,
		ranges: [],
		texts: [],
		isAtStart: false,
		startNode: null,
		endNode: null,
		startText: null,
		endText: null,
		isAtEnd: false,
		isTextSpanning: false
	});
	constructor(edytor: Edytor) {
		this.edytor = edytor;
	}
	destroy = () => {
		document?.removeEventListener('selectionchange', this.onSelectionChange);
	};
	getTextOfNode = getTextOfNode.bind(this);
	getTextsInSelection = getTextsInSelection.bind(this);

	private getRelativeCursorLocation = () => {
		return {
			yStart: this.state.yStart,
			yStartElement: this.state.startText?.node,
			length: this.state.length
		};
	};

	init = () => {
		this.edytor.undoManager.on('stack-item-added', (event: any) => {
			console.log('stack-item-added', event);
			// event.stackItem.meta.set('cursor-location', this.getRelativeCursorLocation());
		});
		this.edytor.undoManager.on('stack-item-popped', (event: any) => {
			console.log('stack-item-popped', event);
			// this.restoreCursorLocation(event.stackItem.meta.get('cursor-location'));
		});

		document?.addEventListener('selectionchange', this.onSelectionChange);
	};

	private restoreCursorLocation = (cursorLocation: {
		yStart: RelativePosition | null;
		yStartElement: Y.Text;
		length: number;
	}) => {
		// if (!cursorLocation.yStart) return;
		// const pos = createAbsolutePositionFromRelativePosition(cursorLocation.yStart, this.edytor.doc);
		// if (!pos || !cursorLocation.yStartElement) return;
		// setCursorAtPosition(
		// 	`${getId(cursorLocation.yStartElement)}`,
		// 	pos.index + cursorLocation.length
		// );
	};

	private onSelectionChange = () => {
		const selection = window.getSelection();

		if (!selection?.anchorNode || !this.edytor.container?.contains(selection.anchorNode as Node)) {
			return;
		}

		const { anchorNode, focusNode, anchorOffset, focusOffset, isCollapsed } = selection;
		const ranges = getRangesFromSelection(selection);
		const isReversed = !isCollapsed && anchorOffset > focusOffset;
		const content = selection?.toString() || '';
		const startNode = isReversed ? focusNode : anchorNode;
		const endNode = isReversed ? anchorNode : focusNode;
		const start = isReversed ? focusOffset : anchorOffset;
		const end = isReversed ? anchorOffset : focusOffset;

		const { startText, endText, texts } = this.getTextsInSelection(startNode, endNode, ranges);
		const focusedBlocks = new Set(texts.map((text) => text.parent));
		const difference = this.focusedBlocks.difference(focusedBlocks);
		difference.forEach((block) => {
			this.focusedBlocks.delete(block);
			// block.content.setChildren();
		});
		focusedBlocks.forEach((block) => this.focusedBlocks.add(block));

		let yStart = getYIndex(startText, startNode, start);
		let yEnd = isCollapsed ? yStart : getYIndex(endText, endNode, end);

		this.state = {
			selection,
			start,
			end,
			yStart,
			yEnd,
			length: content.length,
			content,
			isCollapsed,
			ranges,
			texts,
			startText,
			endText,
			isAtEnd: yEnd === endText?.yText.length,
			isAtStart: yStart === 0,
			isTextSpanning: startText !== endText,
			startNode,
			endNode
		};
	};

	setAtTextOffset = async (text: Text, textOffset: number) => {
		await tick();
		let nodeOffset = 0;
		const treeWalker = document.createTreeWalker(text.node!, NodeFilter.SHOW_TEXT, (node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				return NodeFilter.FILTER_ACCEPT;
			}
			return NodeFilter.FILTER_SKIP;
		});
		let currentNode = treeWalker.nextNode();
		let textNode: Node | null = null;
		let currentOffset = 0;
		while (currentNode) {
			const endOffset = currentOffset + (currentNode as any).length;
			if (textOffset >= currentOffset && textOffset <= endOffset) {
				textNode = currentNode;
				nodeOffset = textOffset - currentOffset;
				break;
			}
			currentOffset = endOffset;
			currentNode = treeWalker.nextNode();
		}
		if (textNode) {
			this.setAtNodeOffset(textNode, nodeOffset);
		}
	};

	setSelectionAtTextRange = async (text: Text, start: number, end: number) => {
		await tick();
		let startNode: Node | null = null;
		let startOffset = 0;
		let endNode: Node | null = null;
		let endOffset = 0;

		const treeWalker = document.createTreeWalker(text.node!, NodeFilter.SHOW_TEXT, (node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				return NodeFilter.FILTER_ACCEPT;
			}
			return NodeFilter.FILTER_SKIP;
		});

		let currentNode = treeWalker.nextNode();
		let currentOffset = 0;

		while (currentNode) {
			const nodeLength = currentNode.textContent?.length || 0;
			const endPosition = currentOffset + nodeLength;

			// Find start position
			if (!startNode && start >= currentOffset && start <= endPosition) {
				startNode = currentNode;
				startOffset = start - currentOffset;
			}

			// Find end position
			if (!endNode && end >= currentOffset && end <= endPosition) {
				endNode = currentNode;
				endOffset = end - currentOffset;
			}

			if (startNode && endNode) {
				break;
			}

			currentOffset = endPosition;
			currentNode = treeWalker.nextNode();
		}

		if (startNode && endNode) {
			const selection = window.getSelection();
			const range = document.createRange();
			range.setStart(startNode, startOffset);
			range.setEnd(endNode, endOffset);
			selection?.removeAllRanges();
			selection?.addRange(range);
			this.edytor.node!.focus();
		}
	};

	setAtNodeOffset = async (node: Node, offset: number) => {
		await tick();
		const selection = window.getSelection();
		const range = document.createRange();
		range.setStart(node, offset);
		range.collapse(true);
		selection?.removeAllRanges();
		selection?.addRange(range);
		this.edytor.node!.focus();
	};
}
