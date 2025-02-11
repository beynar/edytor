import { type RelativePosition } from 'yjs';
import * as Y from 'yjs';
import type { Edytor } from '../edytor.svelte.js';
import { Text } from '../text/text.svelte.js';
import {
	climb,
	climbDom,
	getRangesFromSelection,
	getTextOfNode,
	getTextsInSelection,
	getYIndex
} from './selection.utils.js';
import { Block } from '../block/block.svelte.js';
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
	// If the selection is at the start of the block
	isAtStartOfBlock?: boolean;
	// If the selection is at the end of the block
	isAtEndOfBlock?: boolean;
	// If the selection is at the start of the text
	isAtStartOfText?: boolean;
	// If the selection is at the end of the text
	isAtEndOfText?: boolean;
	startText: Text | null;
	endText: Text | null;
	startBlock: Block | null;
	endBlock: Block | null;
	texts: Text[];
	blocks: Block[];
	startNode: Node | null;
	endNode: Node | null;
	isTextSpanning: boolean;
	isBlockSpanning: boolean;
	isVoid: boolean;
	voidRoot: Block | null;
	isIsland: boolean;
	islandRoot: Block | null;
	relativePosition: RelativePosition | null;
	// TOREMOVE
	yTextContent: string;
};

export class EdytorSelection {
	edytor: Edytor;
	focusedBlocks = new SvelteSet<Block>();
	selectedBlocks = new SvelteSet<Block>();
	hasSelectedAll = $state(false);

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
		blocks: [],
		isAtStartOfBlock: false,
		isAtEndOfBlock: false,
		isAtStartOfText: false,
		isAtEndOfText: false,
		startNode: null,
		endNode: null,
		startText: null,
		endText: null,
		startBlock: null,
		endBlock: null,
		isTextSpanning: false,
		isBlockSpanning: false,
		isVoid: false,
		isIsland: false,
		islandRoot: null,
		voidRoot: null,
		relativePosition: null,
		// TOREMOVE
		yTextContent: ''
	});
	constructor(
		edytor: Edytor,
		private edytorOnSelectionChange?: (selection: EdytorSelection) => void
	) {
		this.edytor = edytor;
	}
	destroy = () => {
		document?.removeEventListener('selectionchange', this.onSelectionChange);
	};
	getTextOfNode = getTextOfNode.bind(this);
	getTextsInSelection = getTextsInSelection.bind(this);

	init = () => {
		this.edytor.undoManager.on('stack-item-added', (event: any) => {
			event.stackItem.meta.set('cursor-location', {
				id: this.state.startText?.id,
				offset: this.state.yEnd
			});
		});
		this.edytor.undoManager.on('stack-item-popped', (event: any) => {
			const cursorLocation = event.stackItem.meta.get('cursor-location');
			const text = this.edytor.getTextById(cursorLocation.id);
			text && this.setAtTextOffset(text, cursorLocation.offset);
		});

		document?.addEventListener('selectionchange', this.onSelectionChange);
	};

	handleTripleClick = async (e: MouseEvent) => {
		if (e.detail < 3) return;
		await tick();
		const { startText } = this.state;
		startText && this.setAtTextRange(startText, 0, startText.yText.length);
	};

	shift = async (length: number) => {
		this.state.yStart += length;
		this.state.yEnd += length;
		this.state.start += length;
		this.state.end += length;
		this.state.yTextContent = this.state.startText?.yText.toJSON()!;
	};
	onSelectionChange = () => {
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

		this.selectBlocks();
		this.focusBlocks(...texts.map((text) => text.parent));

		let yStart = getYIndex(startText, startNode, start);
		let yEnd = isCollapsed ? yStart : getYIndex(endText, endNode, end);

		if (yStart > yEnd) {
			[yStart, yEnd] = [yEnd, yStart];
		}

		let isIsland = false;
		let islandRoot: Block | null = null;

		climb(startText?.parent, (block) => {
			if (block instanceof Block && block.definition.island) {
				isIsland = true;
				islandRoot = block;
				return true;
			}
		});

		let isVoid = false;
		let voidRoot: Block | null = null;
		climb(startText?.parent, (block) => {
			if (block instanceof Block && block.definition.void) {
				isVoid = true;
				voidRoot = block;
				return true;
			}
		});

		if (!isVoid) {
			climbDom(startNode, (node) => {
				if (node instanceof HTMLElement && node.dataset.edytorBlock && node.dataset.edytorVoid) {
					const id = node.dataset.edytorId;
					const block = id && this.edytor.idToBlock.get(id);
					if (block) {
						isVoid = true;
						voidRoot = block;
						return true;
					}
				}
			});
		}

		console.log('voidRoot', voidRoot);

		const isAtStartOfText = yStart === 0;
		const isAtEndOfText = yEnd === endText?.yText.length;
		const isAtStartOfBlock =
			(startText && startText === startText.parent.firstText && isAtStartOfText) || false;
		const isAtEndOfBlock =
			(endText && endText === endText.parent.lastText && isAtEndOfText) || false;

		const startBlock = startText?.parent || null;
		const endBlock = endText?.parent || null;
		const { startBlock: previousStartBlock, endBlock: previousEndBlock } = this.state;
		if (
			(previousStartBlock !== startBlock || previousEndBlock !== endBlock) &&
			[previousStartBlock, previousEndBlock].some((block) => block?.suggestions)
		) {
			[previousStartBlock, previousEndBlock].forEach((block) => {
				if (block?.suggestions) {
					block.suggestions = null;
				}
			});
		}

		const isTextSpanning = startText !== endText && texts.length > 1;
		const blocks = Array.from(new Set([...texts.map((text) => text.parent)]));
		const isBlockSpanning = startBlock !== endBlock && blocks.length > 1;

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
			blocks,
			isBlockSpanning,
			startText,
			endText,
			isAtStartOfText,
			isAtEndOfText,
			isAtEndOfBlock,
			isAtStartOfBlock,
			isTextSpanning,
			startNode,
			endNode,
			startBlock,
			endBlock,
			isVoid,
			isIsland,
			islandRoot,
			voidRoot,
			relativePosition: startText
				? Y.createRelativePositionFromTypeIndex(startText.yText, yStart, -1)
				: null,
			// TOREMOVE
			yTextContent: startText?.yText.toJSON()!
		};
		this.edytorOnSelectionChange?.(this);
		this.edytor.plugins.forEach((plugin) => {
			plugin.onSelectionChange?.(this);
		});
	};

	restoreRelativePosition = (text: Text) => {
		if (text !== this.state.startText || !this.state.relativePosition) {
			return;
		}

		const absolutePosition = Y.createAbsolutePositionFromRelativePosition(
			this.state.relativePosition,
			this.edytor.doc
		);

		if (!absolutePosition) {
			return;
		}

		this.setAtTextOffset(text, absolutePosition?.index);
	};

	selectBlocks = (...blocks: Block[]) => {
		const difference = this.selectedBlocks.difference(new Set(blocks));
		difference.forEach((block) => {
			this.selectedBlocks.delete(block);
			block.definition.onBlur?.({ block });
			block.node?.removeAttribute('data-edytor-selected');
		});
		blocks.forEach((block) => {
			this.selectedBlocks.add(block);
			block.definition.onSelect?.({ block });
			block.node?.setAttribute('data-edytor-selected', 'true');
		});
		if (blocks.length === 1) {
			this.focusBlocks();
		}
	};

	focusBlocks = (...blocks: Block[]) => {
		const difference = this.focusedBlocks.difference(new Set(blocks));
		difference.forEach((block) => {
			this.focusedBlocks.delete(block);
			block.definition.onBlur?.({ block });
			block.node?.removeAttribute('data-edytor-focused');
		});
		blocks.forEach((block) => {
			this.focusedBlocks.add(block);
			block.definition.onFocus?.({ block });
			block.node?.setAttribute('data-edytor-focused', 'true');
		});
	};

	private findTextNode = (node: HTMLElement, offset: number = 0) => {
		let nodeOffset = 0;
		const treeWalker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, (node) => {
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
			if (offset >= currentOffset && offset <= endOffset) {
				textNode = currentNode;
				nodeOffset = offset - currentOffset;
				break;
			}
			currentOffset = endOffset;
			currentNode = treeWalker.nextNode();
		}

		return [textNode, nodeOffset] as const;
	};
	setAtTextOffset = async (
		textOrId: Text | string | undefined | null,
		textOffset: number | null | undefined = this.state.yStart
	) => {
		if (!textOrId || typeof textOffset !== 'number') {
			return;
		}

		const node = await this.edytor.getTextNode(textOrId);
		const [textNode, nodeOffset] = this.findTextNode(node, textOffset);

		if (textNode) {
			this.setAtNodeOffset(textNode, nodeOffset);
		}
	};

	setAtTextsRange = async (startText: Text, endText: Text) => {
		if (!startText.node || !endText.node) {
			return;
		}

		const [startTextNode, startNodeOffset] = this.findTextNode(startText.node, 0);
		const [endTextNode, endNodeOffset] = this.findTextNode(endText.node, endText.yText.length);

		if (startTextNode && endTextNode) {
			const selection = window.getSelection();
			const range = document.createRange();
			range.setStart(startTextNode, startNodeOffset);
			range.setEnd(endTextNode, endNodeOffset);
			selection?.removeAllRanges();
			selection?.addRange(range);

			startTextNode.parentElement?.focus();
		}
	};

	setAtBlockRange = async (block?: Block | null, startOffset?: number, endOffset?: number) => {
		if (!block) {
			return;
		}
		if (!startOffset) {
			startOffset = 0;
		}
		if (!endOffset) {
			endOffset = block.lastText.length;
		}

		const startNode = await this.edytor.getTextNode(block.firstText);
		const [startTextNode, startNodeOffset] = this.findTextNode(startNode, startOffset);
		const endNode = await this.edytor.getTextNode(block.lastText);
		const [endTextNode, endNodeOffset] = this.findTextNode(endNode, endOffset);

		if (startTextNode && endTextNode) {
			const selection = window.getSelection();
			const range = document.createRange();
			range.setStart(startTextNode, startNodeOffset);
			range.setEnd(endTextNode, endNodeOffset);
			selection?.removeAllRanges();
			selection?.addRange(range);
			// this.edytor.node!.focus();
			startTextNode.parentElement?.focus();
		}
	};

	setAtTextRange = async (
		text: Text | undefined | null,
		start: number | undefined | null,
		end: number | undefined | null
	) => {
		if (!text || typeof start !== 'number' || typeof end !== 'number') {
			return;
		}
		const node = await this.edytor.getTextNode(text);
		let startNode: Node | null = null;
		let startOffset = 0;
		let endNode: Node | null = null;
		let endOffset = 0;

		const treeWalker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, (node) => {
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
			// this.edytor.node!.focus();
			startNode.parentElement?.focus();
		}
	};

	setAtNodeOffset = (node: Node, offset: number) => {
		const selection = window.getSelection();
		const range = document.createRange();
		range.setStart(node, offset);
		range.collapse(true);
		selection?.removeAllRanges();
		selection?.addRange(range);
	};
}
