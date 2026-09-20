import type { Edytor } from '../edytor.svelte.js';
import { Text } from '../text/text.svelte.js';
import {
	climb,
	climbDom,
	getInlineBlockOfNode,
	getInlineBlockInSelectedRange,
	getRangesFromSelection,
	getTextOfNode,
	getTextsInSelection,
	getYIndex
} from './selection.utils.js';
import {
	clearDomSelection,
	createDomSelectionSnapshotFromRange,
	createDomRange,
	getActiveElement,
	getDomSelection,
	getDomSelectionSnapshot,
	type DomSelectionSnapshot
} from './domSelection.js';
import { Block } from '../block/block.svelte.js';
import { SvelteSet } from 'svelte/reactivity';
import { tick } from 'svelte';
import { InlineBlock } from '../block/inlineBlock.svelte.js';
import type { JSONText } from '$lib/utils/json.js';
import {
	clearAwarenessSelection,
	publishAwarenessSelection
} from '$lib/collaboration/awarenessSelection.js';
import { isNativeFormControl } from '$lib/events/nativeInteractiveControl.js';
import type { Anchor } from '$lib/crdt/text/model.js';

/**
 * CRDT-stable anchor for a text position — `{b}` is the home block id of
 * the BACKING text the bound atom lives in (not necessarily the block that
 * displays it — merges/splits reroute display while the anchor stays on
 * the same atoms), `a` the engine anchor carrying the endpoint affinity in
 * its `a` field (`a < 0` = left, `a >= 0` = right). JSON-serializable;
 * replaces the v13 `RelativePosition`. Same wire shape as `DocAnchor` on
 * the facade (`facade.anchorAt`/`facade.resolveAnchor`).
 */
export type TextAnchor = { b: string; a: Anchor };

type SelectionState = {
	selection: DomSelectionSnapshot | null;
	yStart: number;
	yEnd: number;
	start: number;
	end: number;
	length: number;
	content: string;
	isCollapsed: boolean;
	isReversed: boolean;
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
	contentParts: (Text | InlineBlock)[];
	blocks: Block[];
	startNode: Node | null;
	endNode: Node | null;
	isTextSpanning: boolean;
	isBlockSpanning: boolean;
	isVoid: boolean;
	voidRoot: Block | null;
	isVoidEditableElement: boolean;
	isIsland: boolean;
	islandRoot: Block | null;
	relativePosition: TextAnchor | null;
	currentMarks: JSONText['marks'];
	// TOREMOVE
	yTextContent: string;
};

const SYNTHETIC_TEXT_OVERLAY_SELECTOR =
	'[data-edytor-text-placeholder], [data-edytor-text-suggestion]';
const TEXT_PLACEHOLDER_SELECTOR = '[data-edytor-text-placeholder]';

const getElementFromNode = (node: Node | null) => {
	if (!node || typeof Element === 'undefined') {
		return null;
	}

	if (node instanceof Element) {
		return node;
	}

	return node.nodeType === Node.TEXT_NODE ? node.parentElement : null;
};

const getSyntheticTextOverlayElement = (node: Node | null, offset: number) => {
	let syntheticOverlay: HTMLElement | null = null;

	climbDom(node, (currentNode) => {
		if (
			currentNode instanceof HTMLElement &&
			currentNode.matches(SYNTHETIC_TEXT_OVERLAY_SELECTOR)
		) {
			syntheticOverlay = currentNode;
			return true;
		}
	});

	if (syntheticOverlay || !(node instanceof Element)) {
		return syntheticOverlay;
	}

	for (const boundaryNode of [node.childNodes[offset], node.childNodes[offset - 1]]) {
		if (!(boundaryNode instanceof HTMLElement)) {
			continue;
		}

		if (boundaryNode.matches(SYNTHETIC_TEXT_OVERLAY_SELECTOR)) {
			return boundaryNode;
		}

		const descendant = boundaryNode.querySelector<HTMLElement>(SYNTHETIC_TEXT_OVERLAY_SELECTOR);
		if (descendant) {
			return descendant;
		}
	}

	return null;
};

const getTextPlaceholderInRange = (range: Range | undefined) => {
	if (!range) {
		return null;
	}

	const root =
		range.commonAncestorContainer instanceof Element
			? range.commonAncestorContainer
			: range.commonAncestorContainer.parentElement;
	if (!root) {
		return null;
	}

	const placeholders = [
		...(root.matches(TEXT_PLACEHOLDER_SELECTOR) ? [root] : []),
		...Array.from(root.querySelectorAll(TEXT_PLACEHOLDER_SELECTOR))
	];
	return (
		placeholders.find((placeholder) => {
			try {
				return range.intersectsNode(placeholder);
			} catch {
				return false;
			}
		}) ?? null
	);
};

const getInlineBlockBetweenBoundaryTexts = (
	startText: Text,
	endText: Text | null,
	yStart: number,
	yEnd: number
) => {
	if (!endText || startText.parent !== endText.parent) {
		return null;
	}

	if (yStart !== startText.length || yEnd !== 0) {
		return null;
	}

	const content = startText.parent.content;
	const startIndex = content.indexOf(startText);
	const endIndex = content.indexOf(endText);
	if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
		return null;
	}

	const selectedParts = content.slice(startIndex + 1, endIndex);
	return selectedParts.length === 1 && selectedParts[0] instanceof InlineBlock
		? selectedParts[0]
		: null;
};

type UndoSelectionSnapshot = {
	isCollapsed: boolean;
	isReversed: boolean;
	startTextId: string | null;
	endTextId: string | null;
	startTextPath: number[] | null;
	endTextPath: number[] | null;
	yStart: number;
	yEnd: number;
	/**
	 * U09 — backing-text anchors for both endpoints (authoritative when
	 * present). The START endpoint binds 'right' (the first atom inside
	 * the range) and END binds 'left' (the last atom inside the range) so
	 * boundary inserts stay outside the restored range; collapsed
	 * snapshots carry a 'left' caret anchor in both fields. The numeric
	 * `yStart`/`yEnd` + id/path fields remain as the compatibility
	 * fallback for anchors that can no longer resolve (deleted backing).
	 */
	startAnchor: TextAnchor | null;
	endAnchor: TextAnchor | null;
	selectedBlockIds: string[];
	selectedBlockPaths: number[][];
};

type PointerTextPoint = {
	text: Text;
	offset: number;
	clientX: number;
	clientY: number;
};

type DocumentWithCaretPoint = Document & {
	caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
	caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

const CURSOR_LOCATION_META = 'cursor-location';
const RESTORE_CURSOR_LOCATION_META = 'restore-cursor-location';

const restoreBackwardDomRange = (
	selection: Selection,
	range: Range,
	endTextNode: Node,
	endNodeOffset: number,
	startTextNode: Node,
	startNodeOffset: number
) => {
	try {
		if (typeof selection.setBaseAndExtent === 'function') {
			selection.setBaseAndExtent(endTextNode, endNodeOffset, startTextNode, startNodeOffset);
			return true;
		}
	} catch {
		selection.removeAllRanges();
	}

	try {
		if (typeof selection.extend === 'function') {
			selection.collapse(endTextNode, endNodeOffset);
			selection.extend(startTextNode, startNodeOffset);
			return true;
		}
	} catch {
		selection.removeAllRanges();
	}

	selection.addRange(range);
	return false;
};

export class EdytorSelection {
	edytor: Edytor;
	focusedBlocks = new SvelteSet<Block>();
	selectedBlocks = new SvelteSet<Block>();
	selectedInlineBlock = new SvelteSet<InlineBlock>();
	inlineBlockDeletionTarget: InlineBlock | null = null;
	hasSelectedAll = $state(false);
	nextUndoSelectionSnapshot = $state<Partial<UndoSelectionSnapshot> | null>(null);
	isRestoringHistorySelection = $state(false);
	ignoreNextSelectionChange = $state(false);
	ignoreNextSelectedBlockSelectionChange = $state(false);
	private pointerDragStart: PointerTextPoint | null = null;
	private selectionDocument: Document | null = null;
	private shouldKeepModelSelectionForNextTextInsertion = false;
	private modelSelectionPreservationBlock: Block | null = null;
	private pendingBlockRangeRequest: symbol | null = null;
	private historySelectionRestoreVersion = 0;

	state = $state<SelectionState>({
		selection: null,
		start: 0,
		end: 0,
		yStart: 0,
		yEnd: 0,
		length: 0,
		content: '',
		isCollapsed: true,
		isReversed: false,
		ranges: [],
		texts: [],
		blocks: [],
		contentParts: [],
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
		isVoidEditableElement: false,
		voidRoot: null,
		relativePosition: null,
		currentMarks: {},
		// TOREMOVE
		yTextContent: ''
	});
	constructor(
		edytor: Edytor,
		private edytorOnSelectionChange?: (selection: EdytorSelection) => void
	) {
		this.edytor = edytor;
	}
	private emitSelectionChange = () => {
		publishAwarenessSelection(this);
		this.edytorOnSelectionChange?.(this);
		this.edytor.plugins.forEach((plugin) => {
			plugin.onSelectionChange?.(this);
		});
	};
	private getTextPath = (text: Text | null) => {
		if (!text) {
			return null;
		}

		const index = text.parent.content.findIndex((part) => part === text);
		return [...text.parent.path, index === -1 ? text.index : index];
	};
	private getTextByPath = (path: number[] | null) => {
		if (!path || path.length < 2) {
			return null;
		}

		let block: Block | undefined = this.edytor.root;
		for (const index of path.slice(0, -1)) {
			block = block?.children[index];
		}

		const part = block?.content[path.at(-1)!];
		return part instanceof Text ? part : null;
	};
	private getBlockByPath = (path: number[] | null) => {
		if (!path?.length) {
			return null;
		}

		let block: Block | undefined = this.edytor.root;
		for (const index of path) {
			block = block?.children[index];
		}
		return block ?? null;
	};
	private isCurrentText = (text: Text | null | undefined) =>
		Boolean(text && this.getTextByPath(this.getTextPath(text)) === text);
	private getRestorableText = (id: string | null, path: number[] | null) => {
		// `getTextById` throws on malformed ids — a stale/corrupt snapshot
		// id must degrade to the path fallback, never crash a restore.
		let textById: Text | null;
		try {
			textById = (id ? this.edytor.getTextById(id) : null) ?? null;
		} catch {
			textById = null;
		}
		if (this.isCurrentText(textById)) {
			return textById ?? null;
		}

		return this.getTextByPath(path);
	};

	/**
	 * Resolve one stored undo-snapshot endpoint → `{text, offset}`.
	 * Anchors are authoritative (they follow moved/merged atoms and land
	 * on the documented deleted-backing fallback); the id/path + numeric
	 * offset pair is the compatibility fallback when the anchor no longer
	 * resolves (deleted target) or is absent (pre-U09 snapshots).
	 */
	private resolveSnapshotEndpoint = (
		anchor: TextAnchor | null | undefined,
		textId: string | null,
		textPath: number[] | null,
		fallbackOffset: number
	): { text: Text; offset: number } | null => {
		if (anchor) {
			const resolved = this.resolveTextAnchor(anchor);
			if (resolved) {
				return resolved;
			}
		}
		const text = this.getRestorableText(textId, textPath);
		if (!text) {
			return null;
		}
		return { text, offset: Math.min(Math.max(fallbackOffset, 0), text.length) };
	};
	private createUndoSelectionSnapshot = (
		override?: Partial<UndoSelectionSnapshot> | null
	): UndoSelectionSnapshot => ({
		isCollapsed: this.state.isCollapsed,
		isReversed: this.state.isReversed,
		startTextId: this.state.startText?.id ?? null,
		endTextId: this.state.endText?.id ?? null,
		startTextPath: this.getTextPath(this.state.startText),
		endTextPath: this.getTextPath(this.state.endText),
		yStart: this.state.yStart,
		yEnd: this.state.yEnd,
		startAnchor: this.state.startText
			? this.createTextAnchor(
					this.state.startText,
					this.state.yStart,
					this.state.isCollapsed ? 'left' : 'right'
				)
			: null,
		endAnchor: this.state.endText
			? this.createTextAnchor(this.state.endText, this.state.yEnd, 'left')
			: null,
		selectedBlockIds: Array.from(this.selectedBlocks).map((block) => block.id),
		selectedBlockPaths: Array.from(this.selectedBlocks).map((block) => [...block.path]),
		...override
	});
	queueNextUndoSelectionSnapshot = (override?: Partial<UndoSelectionSnapshot> | null) => {
		this.nextUndoSelectionSnapshot = this.createUndoSelectionSnapshot(override);
	};
	destroy = () => {
		if (this.selectionDocument) {
			this.selectionDocument.removeEventListener('selectionchange', this.onSelectionChange);
			this.selectionDocument = null;
		}
		// U09 lifecycle — drop our published caret so remote peers remove
		// it when this editor detaches (awareness state itself is owned by
		// the provider, not the component).
		clearAwarenessSelection(this.edytor.awareness);
	};
	clearInlineBlockSelection = () => {
		this.selectedInlineBlock.clear();
		this.inlineBlockDeletionTarget = null;
	};
	clearModelSelectionPreservation = () => {
		this.shouldKeepModelSelectionForNextTextInsertion = false;
		this.modelSelectionPreservationBlock = null;
	};
	private isStateBlockContentRange = (block: Block) =>
		Boolean(
			!this.state.isCollapsed &&
			this.state.startBlock === block &&
			this.state.endBlock === block &&
			this.state.startText === block.firstText &&
			this.state.endText === block.lastText &&
			this.state.yStart === 0 &&
			this.state.yEnd === block.lastText.length
		);
	consumeModelSelectionPreservationForTextInsertion = () => {
		const preservedBlock = this.modelSelectionPreservationBlock;
		const shouldKeepPreservedBlock =
			this.shouldKeepModelSelectionForNextTextInsertion &&
			preservedBlock instanceof Block &&
			this.getBlockByPath(preservedBlock.path) === preservedBlock;
		const shouldKeepSelection =
			shouldKeepPreservedBlock ||
			(this.shouldKeepModelSelectionForNextTextInsertion &&
				this.state.startBlock instanceof Block &&
				this.isStateBlockContentRange(this.state.startBlock));

		if (shouldKeepPreservedBlock) {
			this.setStateFromBlockContentRange(preservedBlock);
		}

		this.shouldKeepModelSelectionForNextTextInsertion = false;
		this.modelSelectionPreservationBlock = null;
		return shouldKeepSelection;
	};
	getTextOfNode = getTextOfNode.bind(this);
	getTextsInSelection = getTextsInSelection.bind(this);
	getInlineBlockOfNode = getInlineBlockOfNode.bind(this);
	getInlineBlockInSelectedRange = getInlineBlockInSelectedRange.bind(this);

	private getBlockOfNode = (node: Node | null) => {
		const element = getElementFromNode(node);
		const blockElement = element?.closest('[data-edytor-block]');
		if (!(blockElement instanceof HTMLElement) || !this.edytor.node?.contains(blockElement)) {
			return null;
		}

		const id = blockElement.dataset.edytorId;
		return id ? (this.edytor.idToBlock.get(id) ?? null) : null;
	};

	private isInsideEditableText = (node: Node | null) => {
		const element = getElementFromNode(node);
		return Boolean(element?.closest('[data-edytor-text]'));
	};

	private getNonNativeEditableIslandBlock = (node: Node | null) => {
		const element = getElementFromNode(node);
		const island = element?.closest('[contenteditable="false"]');
		if (!(island instanceof HTMLElement) || !this.edytor.node?.contains(island)) {
			return null;
		}
		if (island.closest('input, textarea, select, button, a[href]')) {
			return null;
		}

		return this.getBlockOfNode(island);
	};

	private getNonNativeEditableBlockChromeBlock = (node: Node | null) => {
		const element = getElementFromNode(node);
		const nonEditableElement = element?.closest('[contenteditable="false"]');
		if (
			!(nonEditableElement instanceof HTMLElement) ||
			!this.edytor.node?.contains(nonEditableElement)
		) {
			return null;
		}
		if (nonEditableElement.closest('input, textarea, select, button, a[href]')) {
			return null;
		}
		const block = this.getBlockOfNode(nonEditableElement);
		if (nonEditableElement.closest('[data-edytor-text], [data-edytor-inline-block]') || !block) {
			return null;
		}

		return block;
	};

	handleNonNativeEditableBlockChromePointerDown = (event: PointerEvent) => {
		const targetNode = event.target instanceof Node ? event.target : null;
		const targetBlock = this.getNonNativeEditableBlockChromeBlock(targetNode);
		const targetText = targetBlock?.firstText;
		if (!targetText) {
			return;
		}

		this.setCollapsedStateAtTextOffset(targetText, 0);
		void this.setAtTextOffset(targetText, 0);
		this.ignoreNextSelectionChange = true;
	};

	private restoreRangeSelectionSnapshot = async (
		cursorLocation: UndoSelectionSnapshot,
		shouldContinue: () => boolean = () => true
	) => {
		for (let attempt = 0; attempt < 10; attempt++) {
			if (!shouldContinue()) {
				return;
			}
			await tick();
			if (!shouldContinue()) {
				return;
			}

			// Anchors are re-resolved every attempt — a bound item that was
			// not yet integrated converges as remote updates land.
			const startPoint = this.resolveSnapshotEndpoint(
				cursorLocation.startAnchor,
				cursorLocation.startTextId,
				cursorLocation.startTextPath,
				cursorLocation.yStart
			);
			const endPoint = this.resolveSnapshotEndpoint(
				cursorLocation.endAnchor,
				cursorLocation.endTextId,
				cursorLocation.endTextPath,
				cursorLocation.yEnd
			);

			if (!startPoint || !endPoint) {
				continue;
			}
			const startText = startPoint.text;
			const endText = endPoint.text;

			const restoreModelRange = () => {
				if (!shouldContinue()) {
					return;
				}

				this.setRangeStateAtTextOffsets(startText, startPoint.offset, endText, endPoint.offset, {
					isReversed: cursorLocation.isReversed
				});
				this.ignoreNextSelectionChange = true;
			};

			restoreModelRange();
			await this.setAtRange(startText, startPoint.offset, endText, endPoint.offset, {
				isReversed: cursorLocation.isReversed
			});
			restoreModelRange();
			setTimeout(restoreModelRange);
			setTimeout(restoreModelRange, 30);

			if (!shouldContinue()) {
				return;
			}
			await tick();
			restoreModelRange();

			if (
				!this.state.isCollapsed &&
				this.state.startText === startText &&
				this.state.endText === endText &&
				this.state.yStart === startPoint.offset &&
				this.state.yEnd === endPoint.offset &&
				this.state.isReversed === cursorLocation.isReversed
			) {
				return;
			}
		}
	};

	init = () => {
		const persistUndoSelectionSnapshot = (event: any) => {
			const override = this.nextUndoSelectionSnapshot;
			const currentSnapshot = event.stackItem.meta.get(CURSOR_LOCATION_META);
			if (override && currentSnapshot) {
				event.stackItem.meta.set(RESTORE_CURSOR_LOCATION_META, currentSnapshot);
			}
			if (override || !event.stackItem.meta.has(CURSOR_LOCATION_META)) {
				event.stackItem.meta.set(CURSOR_LOCATION_META, this.createUndoSelectionSnapshot(override));
			}
			this.nextUndoSelectionSnapshot = null;
		};
		this.edytor.undoManager.on('stack-item-added', persistUndoSelectionSnapshot);
		this.edytor.undoManager.on('stack-item-updated', persistUndoSelectionSnapshot);
		this.edytor.undoManager.on('stack-item-popped', (event: any) => {
			const cursorLocation = (event.stackItem.meta.get(RESTORE_CURSOR_LOCATION_META) ??
				event.stackItem.meta.get(CURSOR_LOCATION_META)) as UndoSelectionSnapshot | undefined;
			event.stackItem.meta.delete(RESTORE_CURSOR_LOCATION_META);

			if (!cursorLocation) {
				return;
			}

			const restoreVersion = ++this.historySelectionRestoreVersion;
			// `stack-item-popped` fires after the undo/redo commit, so the
			// document version here already includes the history change
			// itself. Any LATER commit — a keystroke landing inside this
			// restore's async window, a remote update — makes the stored
			// offsets stale; the delayed restores below must not regress
			// the caret over newer input.
			const docVersion = this.edytor._docCommitVersion;
			const isCurrentRestore = () =>
				this.historySelectionRestoreVersion === restoreVersion &&
				this.edytor._docCommitVersion === docVersion;
			this.isRestoringHistorySelection = true;
			const clearHistoryRestoration = () => {
				if (isCurrentRestore()) {
					this.isRestoringHistorySelection = false;
				}
			};

			if (cursorLocation.selectedBlockIds.length) {
				const restoreDeletedSelectionFallback = () => {
					const firstPath = cursorLocation.selectedBlockPaths[0];
					const previousPath =
						firstPath && firstPath.at(-1)! > 0
							? [...firstPath.slice(0, -1), firstPath.at(-1)! - 1]
							: null;
					const fallbackBlock = this.getBlockByPath(previousPath) ?? this.getBlockByPath(firstPath);
					const fallbackText = fallbackBlock?.firstEditableText;
					if (!fallbackText) {
						return false;
					}

					this.setCollapsedStateAtTextOffset(fallbackText, fallbackText.length);
					void this.setAtTextOffset(fallbackText, fallbackText.length);
					return true;
				};

				if ((event as { type?: string }).type === 'redo' && restoreDeletedSelectionFallback()) {
					clearHistoryRestoration();
					return;
				}

				void (async () => {
					try {
						for (let attempt = 0; attempt < 10; attempt++) {
							if (!isCurrentRestore()) {
								return;
							}
							await tick();
							if (!isCurrentRestore()) {
								return;
							}

							const blocksById = cursorLocation.selectedBlockIds
								.map((id) => this.edytor.idToBlock.get(id))
								.filter((block): block is Block => block instanceof Block);

							if (blocksById.length) {
								if (typeof window !== 'undefined') {
									clearDomSelection(this.edytor.node);
								}
								this.selectBlocks(...blocksById);
								return;
							}

							if (attempt < 9) {
								continue;
							}

							if (restoreDeletedSelectionFallback()) {
								return;
							}
						}
					} finally {
						clearHistoryRestoration();
					}
				})();
				return;
			}

			if (!cursorLocation.isCollapsed && cursorLocation.endTextPath) {
				const startPoint = this.resolveSnapshotEndpoint(
					cursorLocation.startAnchor,
					cursorLocation.startTextId,
					cursorLocation.startTextPath,
					cursorLocation.yStart
				);
				const endPoint = this.resolveSnapshotEndpoint(
					cursorLocation.endAnchor,
					cursorLocation.endTextId,
					cursorLocation.endTextPath,
					cursorLocation.yEnd
				);
				if (startPoint && endPoint) {
					this.setRangeStateAtTextOffsets(
						startPoint.text,
						startPoint.offset,
						endPoint.text,
						endPoint.offset,
						{
							isReversed: cursorLocation.isReversed
						}
					);
				}
				void this.restoreRangeSelectionSnapshot(cursorLocation, isCurrentRestore).finally(
					clearHistoryRestoration
				);
				return;
			}

			void (async () => {
				await tick();
				if (!isCurrentRestore()) {
					return;
				}

				const startPoint = this.resolveSnapshotEndpoint(
					cursorLocation.startAnchor ?? cursorLocation.endAnchor,
					cursorLocation.startTextId,
					cursorLocation.startTextPath,
					cursorLocation.yEnd
				);

				if (!startPoint || !isCurrentRestore()) {
					return;
				}

				this.ignoreNextSelectionChange = true;
				await this.setAtTextOffset(startPoint.text, startPoint.offset);
			})().finally(clearHistoryRestoration);
		});

		if (typeof document !== 'undefined') {
			this.selectionDocument = this.edytor.node?.ownerDocument ?? document;
			this.selectionDocument.addEventListener('selectionchange', this.onSelectionChange);
		}
	};

	handleTripleClick = async (e: MouseEvent) => {
		if (e.detail < 3) return;
		const targetNode = e.target instanceof Node ? e.target : null;
		const clickedBlock = this.getBlockOfNode(targetNode);
		if (clickedBlock?.definition.void && !this.isInsideEditableText(targetNode)) {
			e.preventDefault();
			window.requestAnimationFrame(() => {
				window.setTimeout(() => {
					clearDomSelection(this.edytor.node);
					this.selectBlocks(clickedBlock);
					this.ignoreNextSelectionChange = true;
				});
			});
			return;
		}

		const targetBlock =
			targetNode instanceof Node
				? (this.getTextOfNode(targetNode)?.parent ?? this.getBlockOfNode(targetNode))
				: this.state.startText?.parent;
		if (targetBlock) {
			this.setStateFromBlockContentRange(targetBlock);
			this.shouldKeepModelSelectionForNextTextInsertion = true;
			this.modelSelectionPreservationBlock = targetBlock;
			this.ignoreNextSelectionChange = true;
		}
		window.requestAnimationFrame(() => {
			window.setTimeout(() => {
				if (!targetBlock) {
					return;
				}
				if (!this.isStateBlockContentRange(targetBlock)) {
					return;
				}

				void (async () => {
					await this.setAtBlockRange(targetBlock, undefined, undefined, {
						syncModelState: false
					});
					this.ignoreNextSelectionChange = true;
				})();
			});
		});
	};

	shift = async (length: number) => {
		this.state.yStart += length;
		this.state.yEnd += length;
		this.state.start += length;
		this.state.end += length;
		this.state.yTextContent = this.state.startText?.yText.toJSON()!;
	};

	private getTextPointFromClientPoint = (clientX: number, clientY: number) => {
		const ownerDocument = (this.edytor.node?.ownerDocument ?? document) as DocumentWithCaretPoint;
		const caretPosition = ownerDocument.caretPositionFromPoint?.(clientX, clientY);
		const caretRange = caretPosition ? null : ownerDocument.caretRangeFromPoint?.(clientX, clientY);
		const node = caretPosition?.offsetNode ?? caretRange?.startContainer ?? null;
		const domOffset = caretPosition?.offset ?? caretRange?.startOffset ?? null;
		const text = this.getTextOfNode(node, domOffset ?? undefined);

		if (!text || typeof domOffset !== 'number') {
			return null;
		}

		return {
			text,
			offset: Math.min(Math.max(getYIndex(text, node, domOffset), 0), text.length),
			clientX,
			clientY
		};
	};
	private getTextOffsetFromClientPoint = (text: Text, clientX: number, clientY: number) => {
		const ownerDocument = text.node?.ownerDocument;
		if (!text.node || !ownerDocument) {
			return 0;
		}

		const caretPoint = this.getTextPointFromClientPoint(clientX, clientY);
		if (caretPoint?.text === text) {
			return caretPoint.offset;
		}

		let closestOffset = 0;
		let closestDistance = Number.POSITIVE_INFINITY;
		for (let offset = 0; offset <= text.length; offset++) {
			const [textNode, nodeOffset] = this.findTextNode(text.node, offset);
			if (!textNode) {
				continue;
			}

			const range = ownerDocument.createRange();
			range.setStart(textNode, nodeOffset);
			range.collapse(true);
			const rect = range.getBoundingClientRect();
			const fallbackRect = text.node.getBoundingClientRect();
			const x = rect.width || rect.height ? rect.left : fallbackRect.left;
			const y = rect.width || rect.height ? rect.top + rect.height / 2 : fallbackRect.top;
			const distance = Math.hypot(clientX - x, clientY - y);
			if (distance < closestDistance) {
				closestDistance = distance;
				closestOffset = offset;
			}
		}

		return closestOffset;
	};
	setTextSelectionFromPointer = (text: Text, clientX: number, clientY: number) => {
		const offset = this.getTextOffsetFromClientPoint(text, clientX, clientY);
		this.setCollapsedStateAtTextOffset(text, offset);
		if (text.node) {
			const [textNode, nodeOffset] = this.findTextNode(text.node, offset);
			if (textNode) {
				this.setAtNodeOffset(textNode, nodeOffset);
			}
		}
	};

	capturePointerDragStart = (event: PointerEvent) => {
		if (event.button !== 0) {
			this.pointerDragStart = null;
			return;
		}

		this.pointerDragStart = this.getTextPointFromClientPoint(event.clientX, event.clientY);
	};
	clearPointerDragStart = () => {
		this.pointerDragStart = null;
	};
	collapseSelectedBlocksAtPointer = (event: PointerEvent) => {
		if (event.button !== 0 || this.selectedBlocks.size === 0) {
			return;
		}

		const point = this.getTextPointFromClientPoint(event.clientX, event.clientY);
		if (!point) {
			return;
		}

		this.setCollapsedStateAtTextOffset(point.text, point.offset);
		void this.setAtTextOffset(point.text, point.offset);
	};

	restoreInlineAtomDragRange = (event: PointerEvent) => {
		const dragStart = this.pointerDragStart;
		this.pointerDragStart = null;

		if (!dragStart || event.button !== 0) {
			return;
		}

		const dragEnd = this.getTextPointFromClientPoint(event.clientX, event.clientY);
		if (!dragEnd) {
			return;
		}

		const movement = Math.hypot(
			event.clientX - dragStart.clientX,
			event.clientY - dragStart.clientY
		);
		if (movement < 4) {
			return;
		}

		window.setTimeout(() => {
			if (dragStart.text.parent !== dragEnd.text.parent) {
				return;
			}

			const content = dragStart.text.parent.content;
			const startIndex = content.indexOf(dragStart.text);
			const endIndex = content.indexOf(dragEnd.text);
			const firstTextIndex = Math.min(startIndex, endIndex);
			const lastTextIndex = Math.max(startIndex, endIndex);
			const hasInlineAtomBetweenTextPoints = content.some(
				(part, index) =>
					part instanceof InlineBlock && index > firstTextIndex && index < lastTextIndex
			);
			if (startIndex === -1 || endIndex === -1 || !hasInlineAtomBetweenTextPoints) {
				return;
			}

			const isReversed = startIndex > endIndex;
			const rangeStart = isReversed ? dragEnd : dragStart;
			const rangeEnd = isReversed ? dragStart : dragEnd;
			void (async () => {
				this.clearInlineBlockSelection();
				await this.setAtRange(rangeStart.text, rangeStart.offset, rangeEnd.text, rangeEnd.offset, {
					isReversed
				});
				this.clearInlineBlockSelection();
			})();
		});
	};

	onSelectStart = () => {};

	onSelectionChange = () => {
		const selection = getDomSelectionSnapshot(this.edytor.node);
		if (this.isRestoringHistorySelection) {
			this.ignoreNextSelectionChange = false;
			return;
		}
		if (this.ignoreNextSelectedBlockSelectionChange) {
			this.ignoreNextSelectedBlockSelectionChange = false;
			this.ignoreNextSelectionChange = false;
			return;
		}
		if (this.selectedBlocks.size > 0) {
			this.ignoreNextSelectionChange = false;
			return;
		}
		if (this.ignoreNextSelectionChange) {
			this.ignoreNextSelectionChange = false;

			if (this.selectedInlineBlock.size > 0) {
				return;
			}
		}

		this.applySelectionSnapshot(selection);
	};

	applySelectionSnapshot = (selection: DomSelectionSnapshot | null) => {
		if (this.ignoreNextSelectedBlockSelectionChange || this.selectedBlocks.size > 0) {
			this.ignoreNextSelectedBlockSelectionChange = false;
			return;
		}

		const container = this.edytor.container;
		if (
			!selection?.anchorNode ||
			!selection.focusNode ||
			!container?.contains(selection.anchorNode as Node) ||
			!container.contains(selection.focusNode as Node)
		) {
			return;
		}

		const activeElement = getActiveElement(this.edytor.node);
		if (
			activeElement instanceof Element &&
			this.edytor.node?.contains(activeElement) &&
			isNativeFormControl(activeElement)
		) {
			return;
		}

		const { anchorNode, focusNode, anchorOffset, focusOffset, isCollapsed, direction, type } =
			selection;
		const ranges = getRangesFromSelection(selection);
		const isReversed =
			focusNode === anchorNode
				? focusOffset < anchorOffset
				: focusNode
					? Boolean(
							anchorNode.compareDocumentPosition(focusNode) & Node.DOCUMENT_POSITION_PRECEDING
						)
					: false;
		const content = selection?.toString() || '';
		const startNode = isReversed ? focusNode : anchorNode;
		const endNode = isReversed ? anchorNode : focusNode;
		const start = isReversed ? focusOffset : anchorOffset;
		const end = isReversed ? anchorOffset : focusOffset;

		const selectedInlineBlock = this.getInlineBlockInSelectedRange(ranges[0]);
		const selectionParts = selectedInlineBlock
			? { startText: null, endText: null, texts: [], inlineBlock: selectedInlineBlock }
			: this.getTextsInSelection(startNode, endNode, ranges, start, end);
		let { startText, endText, inlineBlock } = selectionParts;

		const placeholderInRange = getTextPlaceholderInRange(ranges[0]);
		if (placeholderInRange) {
			const overlayBlock = this.getBlockOfNode(placeholderInRange);
			const targetText = overlayBlock?.lastText ?? startText;
			if (targetText?.parent.isEmpty) {
				this.setCollapsedStateAtTextOffset(targetText, 0);
				return;
			}
		}

		this.selectBlocks();
		this.focusBlocks();

		if (!startText) {
			const islandBlock = this.getNonNativeEditableIslandBlock(startNode);
			if (islandBlock?.firstText) {
				return this.setAtTextOffset(islandBlock.firstText, 0);
			}

			// If the user is focusind on a white space node.
			if (this.state.startText && !inlineBlock) {
				const [textNode, nodeOffset] = this.state.startText.node
					? this.findTextNode(this.state.startText.node, this.state.yStart)
					: [null, 0];
				if (textNode) {
					this.setAtNodeOffset(textNode, nodeOffset);
				} else {
					this.setAtTextOffset(this.state.startText, this.state.yStart);
				}
				return;
			} else {
				clearDomSelection(this.edytor.node);
				this.selectedInlineBlock.clear();
				if (inlineBlock) {
					this.selectedInlineBlock.add(inlineBlock);
					this.inlineBlockDeletionTarget = inlineBlock;
				}
				return;
			}
		}

		const syntheticOverlay = getSyntheticTextOverlayElement(startNode, start);
		if (syntheticOverlay) {
			const overlayBlock = this.getBlockOfNode(syntheticOverlay);
			const targetText = overlayBlock?.lastText ?? startText;
			this.setCollapsedStateAtTextOffset(targetText, targetText.length);
			return this.setAtTextOffset(targetText, targetText.length);
		}

		this.selectedInlineBlock.clear();

		let yStart = getYIndex(startText, startNode, start);
		let yEnd = isCollapsed ? yStart : getYIndex(endText, endNode, end);

		if (
			!isCollapsed &&
			endText &&
			startText.parent !== endText.parent &&
			endText === endText.parent.firstText &&
			yEnd === 0
		) {
			const previousEndText = endText.parent.closestPreviousBlock?.lastText ?? null;
			if (previousEndText) {
				endText = previousEndText;
				yEnd = previousEndText.length;
			}
		}

		if (startText?.parent.isEmpty && yStart > startText.length) {
			// In case the placeholder or suggestion is not absolutely positioned, we need to set the selection to the start of the text because caret may be placed after the placeholder which is deceptive
			return this.setAtTextOffset(startText, startText.length);
		}

		const inlineBlockSelectedByBoundaryRange = getInlineBlockBetweenBoundaryTexts(
			startText,
			endText,
			yStart,
			yEnd
		);
		if (inlineBlockSelectedByBoundaryRange) {
			clearDomSelection(this.edytor.node);
			this.selectedInlineBlock.clear();
			this.selectedInlineBlock.add(inlineBlockSelectedByBoundaryRange);
			this.inlineBlockDeletionTarget = inlineBlockSelectedByBoundaryRange;
			return;
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

		const isTextSpanning = startText !== endText;
		const isBlockSpanning = startBlock !== endBlock;

		const blocks: Block[] = startBlock ? [startBlock] : [];
		let currentBlock: Block | null = startBlock;

		// Collect all blocks between the start and end blocks
		while (currentBlock && currentBlock !== endBlock) {
			const nextBlock: Block | null = currentBlock.closestNextBlock;
			currentBlock = nextBlock;
			if (nextBlock) {
				blocks.push(nextBlock);
			}
		}

		// Flatten the blocks into a single array of content parts
		let allContentParts = blocks.flatMap((block) => block.content);

		let contentParts: (Text | InlineBlock)[] = [];
		let currentPart: Text | InlineBlock | null = startText;
		let i = 0;
		while (currentPart && currentPart !== endText) {
			contentParts.push(currentPart);
			currentPart = allContentParts[i + 1] || null;
			i++;
		}

		if (endText) {
			contentParts.push(endText);
		}

		this.focusBlocks(...blocks);

		const isVoidEditableElement =
			isVoid && ['INPUT', 'TEXTAREA'].includes(activeElement?.tagName.toUpperCase() || '');
		this.state = {
			selection,
			start,
			end,
			yStart,
			yEnd,
			length: content.length,
			content,
			isCollapsed,
			isReversed,
			ranges,
			texts: contentParts.filter((part) => part instanceof Text),
			contentParts,
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
			isVoidEditableElement,
			isVoid,
			isIsland,
			islandRoot,
			voidRoot,
			relativePosition: startText
				? this.createTextAnchor(startText, yStart, isCollapsed ? 'left' : 'right')
				: null,
			// TOREMOVE
			yTextContent: startText?.yText.toJSON()!,
			currentMarks: (startText?.getMarksAtRange(Math.min(yStart, 0), yEnd) || []).reduce(
				(acc, mark) => {
					mark.marks && Object.assign(acc!, mark.marks);
					return acc;
				},
				{} as JSONText['marks']
			)
		};
		this.emitSelectionChange();
	};

	/**
	 * Anchor a text position into the BACKING text that owns the atom at
	 * that display position — the v14 replacement for
	 * `Y.createRelativePositionFromTypeIndex(yText, offset, -1)`.
	 *
	 * `affinity` decides which side of the position the anchor binds to
	 * (`'left'` = bound to the preceding atom, inserts at the position
	 * land on the anchor's right — the caret baseline `-1`; `'right'` =
	 * bound to the following atom, inserts land outside a range starting
	 * here). `offset` is an offset inside `text`'s display segment;
	 * `text.segStart + offset` is the block-level display offset the
	 * facade maps to the owning backing text — content routed from other
	 * blocks' backing texts (merges/splits) anchors correctly.
	 *
	 * `null` while the text isn't bound to a live block (mirrors the
	 * baseline where a non-integrated Y.Text couldn't produce an absolute
	 * position).
	 */
	createTextAnchor = (
		text: Text,
		offset: number,
		affinity: 'left' | 'right' = 'left'
	): TextAnchor | null => {
		const blockId = text.parent?._blockId;
		if (blockId == null || !text._live || !this.edytor.facade) {
			return null;
		}
		return this.edytor.facade.anchorAt(blockId, text.segStart + offset, affinity);
	};

	/**
	 * Resolve a `TextAnchor` → `{text, offset}` (offset within the text
	 * segment). The anchor is resolved through ownership — when the bound
	 * atoms moved to another block (merge/split), the returned text lives
	 * in that block; deleted atoms resolve to the gap where they lived;
	 * fully-unowned backing resolves to the owner seam. `null` when the
	 * anchor is unresolvable (deleted/hidden target or not-yet-integrated
	 * bound item — callers fall back to id/path restore).
	 */
	resolveTextAnchor = (anchor: TextAnchor): { text: Text; offset: number } | null => {
		const facade = this.edytor.facade;
		if (!facade) {
			return null;
		}
		const resolved = facade.resolveAnchor(anchor);
		if (!resolved) {
			return null;
		}
		const block = this.edytor.idToBlock.get(resolved.blockId);
		if (!block) {
			return null;
		}
		// Map the display offset onto a Text segment using the ENGINE-fresh
		// projection (`deriveContentParts` boundaries) — wrapper part
		// lengths can lag a model write until the mirror reconciles, which
		// would misplace the caret right after an edit. The live wrapper is
		// matched by `segOrd` (the segment ordinal it is bound to).
		const projected = this.edytor.projectedBlock(resolved.blockId);
		if (projected) {
			const parts = block.deriveContentParts(projected.content);
			let off = 0;
			let lastTextPart: { segOrd: number; len: number } | null = null;
			let target: { segOrd: number; offset: number } | null = null;
			for (const part of parts) {
				const len = part.kind === 'text' ? part.items.reduce((n, i) => n + i.text.length, 0) : 1;
				if (part.kind === 'text') {
					lastTextPart = { segOrd: part.segOrd, len };
					if (resolved.offset <= off + len) {
						target = {
							segOrd: part.segOrd,
							offset: Math.max(0, resolved.offset - off)
						};
						break;
					}
				} else if (resolved.offset <= off) {
					break;
				}
				off += len;
			}
			const segOrd = target?.segOrd ?? lastTextPart?.segOrd;
			const segOffset = target?.offset ?? lastTextPart?.len ?? 0;
			const wrapper =
				segOrd == null
					? null
					: (block.content.find(
							(part): part is Text => part instanceof Text && part._segOrd === segOrd
						) ?? null);
			if (wrapper) {
				return { text: wrapper, offset: Math.min(segOffset, wrapper.length) };
			}
		}
		// Fallback — no projection (or no matching live wrapper): walk the
		// wrapper parts directly. Boundary offsets prefer the left part's
		// end.
		let off = 0;
		let lastText: Text | null = null;
		for (const part of block.content) {
			const len = part instanceof Text ? part.length : 1;
			if (part instanceof Text) {
				lastText = part;
				if (resolved.offset <= off + len) {
					return { text: part, offset: Math.max(0, resolved.offset - off) };
				}
			} else if (resolved.offset <= off) {
				break;
			}
			off += len;
		}
		return lastText ? { text: lastText, offset: lastText.length } : null;
	};

	restoreRelativePosition = (text: Text) => {
		if (this.isRestoringHistorySelection) {
			return;
		}

		if (text !== this.state.startText || !this.state.relativePosition) {
			return;
		}

		const resolved = this.resolveTextAnchor(this.state.relativePosition);

		if (!resolved) {
			return;
		}

		const activeElement = getActiveElement(this.edytor.node);
		const isEditorFocused =
			typeof Node !== 'undefined' &&
			activeElement instanceof Node &&
			Boolean(this.edytor.node?.contains(activeElement));
		if (!isEditorFocused) {
			const externalActiveElement =
				typeof HTMLElement !== 'undefined' &&
				activeElement instanceof HTMLElement &&
				this.edytor.node &&
				!this.edytor.node.contains(activeElement)
					? activeElement
					: null;
			const target = resolved.text;
			const yStart = resolved.offset;
			const yEnd = this.state.isCollapsed ? yStart : this.state.yEnd;
			this.state = {
				...this.state,
				start: yStart,
				end: yEnd,
				yStart,
				yEnd,
				length: this.state.isCollapsed ? 0 : this.state.length,
				content: this.state.isCollapsed ? '' : this.state.content,
				isAtStartOfText: yStart === 0,
				isAtEndOfText: yEnd === target.yText.length,
				isAtStartOfBlock: target === target.parent.firstText && yStart === 0,
				isAtEndOfBlock: target === target.parent.lastText && yEnd === target.yText.length,
				relativePosition: this.createTextAnchor(
					target,
					yStart,
					this.state.isCollapsed ? 'left' : 'right'
				),
				yTextContent: target.yText.toJSON()
			};
			const repairBlurredNativeSelection = () => {
				const selection = getDomSelection(this.edytor.node);
				if (
					this.edytor.node &&
					((selection?.anchorNode && this.edytor.node.contains(selection.anchorNode)) ||
						(selection?.focusNode && this.edytor.node.contains(selection.focusNode)))
				) {
					clearDomSelection(this.edytor.node);
				}

				const currentActiveElement = getActiveElement(this.edytor.node);
				const ownerDocument = this.edytor.node?.ownerDocument;
				const shouldRestoreExternalFocus =
					externalActiveElement?.isConnected &&
					(currentActiveElement === null ||
						currentActiveElement === ownerDocument?.body ||
						(this.edytor.node &&
							currentActiveElement instanceof Node &&
							this.edytor.node.contains(currentActiveElement)));
				if (shouldRestoreExternalFocus) {
					externalActiveElement.focus({ preventScroll: true });
				}
			};
			void tick().then(() => {
				repairBlurredNativeSelection();
				setTimeout(repairBlurredNativeSelection);
				setTimeout(repairBlurredNativeSelection, 50);
			});
			return;
		}

		this.setAtTextOffset(resolved.text, resolved.offset);
	};

	private setStateFromSelectedBlocks = (blocks: Block[]) => {
		const firstBlock = blocks[0];
		const lastBlock = blocks.at(-1);
		if (!firstBlock || !lastBlock) {
			return;
		}

		const startText = firstBlock.firstText;
		const endText = lastBlock.lastText;
		const selectedBlocks = [firstBlock];
		let currentBlock = firstBlock;

		while (currentBlock !== lastBlock) {
			const nextBlock = currentBlock.closestNextBlock;
			if (!nextBlock) {
				break;
			}
			selectedBlocks.push(nextBlock);
			currentBlock = nextBlock;
		}

		const contentParts = selectedBlocks.flatMap((block) => block.content);
		const texts = contentParts.filter((part): part is Text => part instanceof Text);

		this.state = {
			...this.state,
			start: 0,
			end: endText.length,
			yStart: 0,
			yEnd: endText.length,
			length: texts.map((text) => text.stringContent).join('').length,
			content: texts.map((text) => text.stringContent).join(''),
			startText,
			endText,
			startBlock: firstBlock,
			endBlock: lastBlock,
			texts,
			contentParts,
			blocks: selectedBlocks,
			isCollapsed: false,
			isReversed: false,
			isTextSpanning: startText !== endText,
			isBlockSpanning: firstBlock !== lastBlock,
			isAtStartOfText: true,
			isAtEndOfText: true,
			isAtStartOfBlock: true,
			isAtEndOfBlock: true,
			relativePosition: this.createTextAnchor(startText, 0),
			currentMarks: {},
			yTextContent: startText.yText.toJSON()
		};
	};

	private setStateFromBlockContentRange = (block: Block) => {
		const startText = block.firstText;
		const endText = block.lastText;
		const contentParts = block.content;
		const texts = contentParts.filter((part): part is Text => part instanceof Text);

		let isIsland = false;
		let islandRoot: Block | null = null;
		let isVoid = false;
		let voidRoot: Block | null = null;

		climb(block, (ancestor) => {
			if (!(ancestor instanceof Block)) {
				return;
			}

			if (ancestor.definition.island) {
				isIsland = true;
				islandRoot = ancestor;
			}

			if (ancestor.definition.void) {
				isVoid = true;
				voidRoot = ancestor;
			}
		});

		this.selectBlocks();
		this.focusBlocks(block);
		this.clearInlineBlockSelection();
		this.state = {
			...this.state,
			selection: null,
			start: 0,
			end: endText.length,
			yStart: 0,
			yEnd: endText.length,
			length: texts.map((text) => text.stringContent).join('').length,
			content: texts.map((text) => text.stringContent).join(''),
			isCollapsed: false,
			isReversed: false,
			ranges: [],
			texts,
			contentParts,
			blocks: [block],
			isBlockSpanning: false,
			startText,
			endText,
			isAtStartOfText: true,
			isAtEndOfText: true,
			isAtEndOfBlock: true,
			isAtStartOfBlock: true,
			isTextSpanning: startText !== endText,
			startNode: null,
			endNode: null,
			startBlock: block,
			endBlock: block,
			isVoidEditableElement: false,
			isVoid,
			isIsland,
			islandRoot,
			voidRoot,
			relativePosition: this.createTextAnchor(startText, 0),
			currentMarks: {},
			yTextContent: startText.yText.toJSON()
		};
		this.emitSelectionChange();
	};

	selectBlocks = (...blocks: Block[]) => {
		this.pendingBlockRangeRequest = null;
		if (blocks.length === 0) {
			this.ignoreNextSelectedBlockSelectionChange = false;
		}
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
		if (blocks.length) {
			this.setStateFromSelectedBlocks(blocks);
		}
		if (blocks.length === 1) {
			this.focusBlocks();
		}
	};

	addBlockToSelection = (block: Block) => {
		this.selectedBlocks.add(block);
		block.definition.onSelect?.({ block });
		block.node?.setAttribute('data-edytor-selected', 'true');
	};

	removeBlockFromSelection = (block: Block) => {
		this.selectedBlocks.delete(block);
		block.definition.onBlur?.({ block });
		block.node?.removeAttribute('data-edytor-selected');
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

	setRangeStateAtTextOffsets = (
		startText: Text,
		startOffset: number,
		endText: Text,
		endOffset: number,
		options: { isReversed?: boolean } = {}
	) => {
		const yStart = Math.min(Math.max(startOffset, 0), startText.length);
		const yEnd = Math.min(Math.max(endOffset, 0), endText.length);
		const startBlock = startText.parent;
		const endBlock = endText.parent;
		const blocks: Block[] = [startBlock];
		let currentBlock: Block | null = startBlock;

		while (currentBlock && currentBlock !== endBlock) {
			currentBlock = currentBlock.closestNextBlock;
			if (currentBlock) {
				blocks.push(currentBlock);
			}
		}

		const allContentParts = blocks.flatMap((block) => block.content);
		const startIndex = allContentParts.indexOf(startText);
		const endIndex = allContentParts.indexOf(endText);
		const contentParts =
			startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex
				? allContentParts.slice(startIndex, endIndex + 1)
				: [startText, endText].filter(
						(part, index, parts): part is Text => parts.indexOf(part) === index
					);
		const texts = contentParts.filter((part): part is Text => part instanceof Text);
		const isCollapsed = startText === endText && yStart === yEnd;
		const content = isCollapsed
			? ''
			: texts
					.map((text) => {
						const start = text === startText ? yStart : 0;
						const end = text === endText ? yEnd : text.length;
						return text.stringContent.slice(start, end);
					})
					.join('');
		let isIsland = false;
		let islandRoot: Block | null = null;
		let isVoid = false;
		let voidRoot: Block | null = null;

		climb(startBlock, (block) => {
			if (block.definition.island) {
				isIsland = true;
				islandRoot = block;
			}
			if (block.definition.void) {
				isVoid = true;
				voidRoot = block;
			}
		});

		const activeElement = getActiveElement(this.edytor.node);
		const markEnd = startText === endText ? yEnd : startText.length;
		const markStart = yStart === markEnd ? Math.max(yStart - 1, 0) : yStart;

		this.selectBlocks();
		this.focusBlocks(...blocks);
		this.selectedInlineBlock.clear();
		this.inlineBlockDeletionTarget = null;
		this.state = {
			...this.state,
			selection: null,
			start: yStart,
			end: yEnd,
			yStart,
			yEnd,
			length: content.length,
			content,
			isCollapsed,
			isReversed: options.isReversed ?? false,
			ranges: [],
			texts,
			contentParts,
			blocks,
			isBlockSpanning: startBlock !== endBlock,
			startText,
			endText,
			isAtStartOfText: yStart === 0,
			isAtEndOfText: yEnd === endText.length,
			isAtStartOfBlock: startText === startBlock.firstText && yStart === 0,
			isAtEndOfBlock: endText === endBlock.lastText && yEnd === endText.length,
			isTextSpanning: startText !== endText,
			startNode: null,
			endNode: null,
			startBlock,
			endBlock,
			isVoidEditableElement:
				isVoid && ['INPUT', 'TEXTAREA'].includes(activeElement?.tagName.toUpperCase() || ''),
			isVoid,
			isIsland,
			islandRoot,
			voidRoot,
			relativePosition: this.createTextAnchor(startText, yStart),
			yTextContent: startText.yText.toJSON(),
			currentMarks: startText
				.getMarksAtRange(markStart, markEnd)
				.reduce<NonNullable<JSONText['marks']>>((acc, mark) => {
					mark.marks && Object.assign(acc, mark.marks);
					return acc;
				}, {})
		};
		this.emitSelectionChange();
	};

	setCollapsedStateAtTextOffset = (textOrId: Text | string, offset: number) => {
		this.clearModelSelectionPreservation();
		const text = textOrId instanceof Text ? textOrId : this.edytor.getTextById(textOrId);
		if (!text) {
			return;
		}

		const yStart = Math.min(Math.max(offset, 0), text.length);
		let isIsland = false;
		let islandRoot: Block | null = null;
		let isVoid = false;
		let voidRoot: Block | null = null;

		climb(text.parent, (block) => {
			if (!(block instanceof Block)) {
				return;
			}
			if (block.definition.island) {
				isIsland = true;
				islandRoot = block;
			}
			if (block.definition.void) {
				isVoid = true;
				voidRoot = block;
			}
		});

		this.selectBlocks();
		this.focusBlocks(text.parent);
		this.selectedInlineBlock.clear();
		this.inlineBlockDeletionTarget = null;
		this.state = {
			...this.state,
			selection: null,
			start: yStart,
			end: yStart,
			yStart,
			yEnd: yStart,
			length: 0,
			content: '',
			isCollapsed: true,
			isReversed: false,
			ranges: [],
			texts: [text],
			contentParts: [text],
			blocks: [text.parent],
			isBlockSpanning: false,
			startText: text,
			endText: text,
			isAtStartOfText: yStart === 0,
			isAtEndOfText: yStart === text.yText.length,
			isAtEndOfBlock: text === text.parent.lastText && yStart === text.yText.length,
			isAtStartOfBlock: text === text.parent.firstText && yStart === 0,
			isTextSpanning: false,
			startNode: null,
			endNode: null,
			startBlock: text.parent,
			endBlock: text.parent,
			isVoidEditableElement: false,
			isVoid,
			isIsland,
			islandRoot,
			voidRoot,
			relativePosition: this.createTextAnchor(text, yStart),
			yTextContent: text.yText.toJSON(),
			currentMarks: (text.getMarksAtRange(Math.max(yStart - 1, 0), yStart) || []).reduce<
				NonNullable<JSONText['marks']>
			>((acc, mark) => {
				mark.marks && Object.assign(acc, mark.marks);
				return acc;
			}, {})
		};
		this.edytorOnSelectionChange?.(this);
		this.edytor.plugins.forEach((plugin) => {
			plugin.onSelectionChange?.(this);
		});
	};

	private findTextNode = (node: HTMLElement, offset: number = 0) => {
		let nodeOffset = 0;
		const treeWalker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT, (node) => {
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

		for (let attempt = 0; attempt < 10; attempt++) {
			let node: HTMLElement;
			try {
				node = await this.edytor.getTextNode(textOrId);
			} catch {
				this.setCollapsedStateAtTextOffset(textOrId, textOffset);
				return;
			}
			if (!node.isConnected) {
				this.setCollapsedStateAtTextOffset(textOrId, textOffset);
				return;
			}
			const [textNode, nodeOffset] = this.findTextNode(node, textOffset);

			if (textNode) {
				this.setAtNodeOffset(textNode, nodeOffset);
				return;
			}

			await tick();
		}

		this.setCollapsedStateAtTextOffset(textOrId, textOffset);
	};

	setAtTextsRange = async (startText: Text, endText: Text) => {
		if (!startText.node || !endText.node) {
			return;
		}

		const [startTextNode, startNodeOffset] = this.findTextNode(startText.node, 0);
		const [endTextNode, endNodeOffset] = this.findTextNode(endText.node, endText.yText.length);

		if (startTextNode && endTextNode) {
			const selection = getDomSelection(startText.node);
			const range = createDomRange(startTextNode);
			range.setStart(startTextNode, startNodeOffset);
			range.setEnd(endTextNode, endNodeOffset);
			selection?.removeAllRanges();
			selection?.addRange(range);

			startTextNode.parentElement?.focus();
			this.applySelectionSnapshot(createDomSelectionSnapshotFromRange(range, selection ?? null));
		}
	};

	setAtRange = async (
		startText: Text | undefined | null,
		startOffset: number | undefined | null,
		endText: Text | undefined | null,
		endOffset: number | undefined | null,
		options: { isReversed?: boolean } = {}
	) => {
		if (
			!startText ||
			!endText ||
			typeof startOffset !== 'number' ||
			typeof endOffset !== 'number'
		) {
			return;
		}

		const startNode = await this.edytor.getTextNode(startText);
		const [startTextNode, startNodeOffset] = this.findTextNode(startNode, startOffset);
		const endNode = await this.edytor.getTextNode(endText);
		const [endTextNode, endNodeOffset] = this.findTextNode(endNode, endOffset);

		if (startTextNode && endTextNode) {
			const selection = getDomSelection(startNode);
			const range = createDomRange(startTextNode);
			range.setStart(startTextNode, startNodeOffset);
			range.setEnd(endTextNode, endNodeOffset);
			const shouldRestoreBackwardRange =
				options.isReversed ??
				(!this.state.isCollapsed &&
					this.state.isReversed &&
					this.state.startText === startText &&
					this.state.endText === endText &&
					this.state.yStart === startOffset &&
					this.state.yEnd === endOffset);
			selection?.removeAllRanges();
			let restoredBackwardRange = false;
			if (selection && shouldRestoreBackwardRange) {
				restoredBackwardRange = restoreBackwardDomRange(
					selection,
					range,
					endTextNode,
					endNodeOffset,
					startTextNode,
					startNodeOffset
				);
			} else {
				selection?.addRange(range);
			}
			startTextNode.parentElement?.focus();
			this.applySelectionSnapshot(
				(restoredBackwardRange ? getDomSelectionSnapshot(startNode) : null) ??
					createDomSelectionSnapshotFromRange(range, selection ?? null)
			);
			if (
				this.state.startText !== startText ||
				this.state.endText !== endText ||
				this.state.yStart !== startOffset ||
				this.state.yEnd !== endOffset
			) {
				this.setRangeStateAtTextOffsets(startText, startOffset, endText, endOffset, {
					isReversed: shouldRestoreBackwardRange
				});
			}
		}
	};

	setAtBlockRange = async (
		block?: Block | null,
		startOffset?: number,
		endOffset?: number,
		options: { syncModelState?: boolean } = {}
	) => {
		if (!block) {
			return;
		}
		if (!startOffset) {
			startOffset = 0;
		}
		if (!endOffset) {
			endOffset = block.lastText.length;
		}
		if (
			options.syncModelState !== false &&
			startOffset === 0 &&
			endOffset === block.lastText.length
		) {
			this.setStateFromBlockContentRange(block);
		}
		const blockRangeRequest = Symbol();
		this.pendingBlockRangeRequest = blockRangeRequest;

		const startNode = await this.edytor.getTextNode(block.firstText);
		const [startTextNode, startNodeOffset] = this.findTextNode(startNode, startOffset);
		const endNode = await this.edytor.getTextNode(block.lastText);
		const [endTextNode, endNodeOffset] = this.findTextNode(endNode, endOffset);

		if (startTextNode && endTextNode) {
			if (this.pendingBlockRangeRequest !== blockRangeRequest || this.selectedBlocks.size > 0) {
				return;
			}
			const selection = getDomSelection(startNode);
			const range = createDomRange(startTextNode);
			range.setStart(startTextNode, startNodeOffset);
			range.setEnd(endTextNode, endNodeOffset);
			selection?.removeAllRanges();
			selection?.addRange(range);
			// this.edytor.node!.focus();
			startTextNode.parentElement?.focus();
			this.applySelectionSnapshot(createDomSelectionSnapshotFromRange(range, selection ?? null));
			this.pendingBlockRangeRequest = null;
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
			const selection = getDomSelection(node);
			const range = createDomRange(node);
			range.setStart(startNode, startOffset);
			range.setEnd(endNode, endOffset);
			selection?.removeAllRanges();
			selection?.addRange(range);
			// this.edytor.node!.focus();
			startNode.parentElement?.focus();
			this.applySelectionSnapshot(createDomSelectionSnapshotFromRange(range, selection ?? null));
		}
	};

	setAtNodeOffset = (node: Node, offset: number) => {
		const selection = getDomSelection(node);
		const range = createDomRange(node);
		range.setStart(node, offset);
		range.collapse(true);
		selection?.removeAllRanges();
		selection?.addRange(range);
		this.applySelectionSnapshot(createDomSelectionSnapshotFromRange(range, selection ?? null));
	};
}
