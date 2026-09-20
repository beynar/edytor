import type { Edytor } from '../edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import { tick } from 'svelte';
import { getDomSelectionSnapshot } from '$lib/selection/domSelection.js';
import {
	getCollapsedDomTextSelection,
	handleNativeLineBreakTextMutation,
	handleNativeLineBreakTextValue,
	reconcileDomText,
	reconcileTextValue
} from './onInput.js';
import {
	removeStalePlaceholders,
	removeStalePlaceholdersIn
} from '$lib/text/removeStalePlaceholders.js';

const MANAGED_SELECTOR = [
	'[data-edytor]',
	'[data-edytor-block]',
	'[data-edytor-text]',
	'[data-edytor-inline-block]',
	'[data-edytor-text-placeholder]',
	'[data-edytor-text-suggestion]',
	'[data-edytor-trailing-newline]',
	'[data-edytor-mark]',
	'[data-edytor-mark-void]',
	'[data-edytor-plugin-chrome]',
	'[data-edytor-render-anchor]'
].join(',');

const EDITABLE_ISLAND_SELECTOR = [
	'[data-edytor-text]',
	'[data-edytor-inline-block]',
	'[data-edytor-text-placeholder]',
	'[data-edytor-text-suggestion]',
	'[data-edytor-trailing-newline]',
	'[data-edytor-mark]',
	'[data-edytor-mark-void]'
].join(',');
const COMPOSITION_MUTATION_IDLE_MS = 750;
const WEBKIT_CONVERTED_SPACE_SELECTOR = 'span.Apple-converted-space';
const NON_BREAKING_SPACE = '\u00A0';

const findMutatedText = (edytor: Edytor, root: Node, target: Node) => {
	let current: Node | null = target.nodeType === Node.TEXT_NODE ? target.parentNode : target;

	while (current && current !== root.parentNode) {
		const text = edytor.nodeToText.get(current);
		if (text) {
			return text;
		}

		if (current === root) {
			return null;
		}

		current = current.parentNode;
	}

	return null;
};

const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;

const isManagedNode = (node: Node) => isElement(node) && node.matches(MANAGED_SELECTOR);

const containsManagedNode = (node: Node) =>
	isElement(node) && Boolean(node.querySelector(MANAGED_SELECTOR));

const isUnmanagedLineBreak = (node: Node) => node instanceof HTMLBRElement;

const isInsideEditableIsland = (node: Node) => {
	const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
	return element instanceof Element && Boolean(element.closest(EDITABLE_ISLAND_SELECTOR));
};

const isInSubtree = (node: Node, roots: Set<Node>) => {
	for (const root of roots) {
		if (node === root || root.contains(node)) {
			return true;
		}
	}
	return false;
};

const getAddedManagedRoots = (mutations: MutationRecord[]) => {
	const roots = new Set<Node>();
	for (const mutation of mutations) {
		for (const addedNode of mutation.addedNodes) {
			if (isManagedNode(addedNode) || containsManagedNode(addedNode)) {
				roots.add(addedNode);
			}
		}
	}
	return roots;
};

const getAddedConvertedSpaceNodes = (root: HTMLElement, mutations: MutationRecord[]) => {
	const convertedSpaces: HTMLElement[] = [];

	for (const mutation of mutations) {
		for (const addedNode of mutation.addedNodes) {
			if (!root.contains(addedNode)) {
				continue;
			}

			if (isElement(addedNode) && addedNode.matches(WEBKIT_CONVERTED_SPACE_SELECTOR)) {
				convertedSpaces.push(addedNode as HTMLElement);
			}

			if (isElement(addedNode)) {
				convertedSpaces.push(
					...Array.from(addedNode.querySelectorAll<HTMLElement>(WEBKIT_CONVERTED_SPACE_SELECTOR))
				);
			}
		}
	}

	return convertedSpaces;
};

const normalizeConvertedSpaceNodes = (root: HTMLElement, mutations: MutationRecord[]) => {
	let normalized = false;
	const selection = getDomSelectionSnapshot(root);

	for (const convertedSpace of getAddedConvertedSpaceNodes(root, mutations)) {
		if (!convertedSpace.isConnected || !convertedSpace.textContent?.includes(NON_BREAKING_SPACE)) {
			continue;
		}

		const replacement = document.createTextNode(
			convertedSpace.textContent.replaceAll(NON_BREAKING_SPACE, ' ')
		);
		const anchorNode = selection?.isCollapsed ? selection.anchorNode : null;
		const anchorOffset = selection?.anchorOffset ?? 0;
		const selectionOffset =
			anchorNode && convertedSpace.contains(anchorNode)
				? getTextOffsetInside(convertedSpace, anchorNode, anchorOffset)
				: null;

		convertedSpace.replaceWith(replacement);
		normalized = true;

		if (typeof selectionOffset === 'number') {
			const range = document.createRange();
			range.setStart(replacement, Math.min(selectionOffset, replacement.data.length));
			range.collapse(true);
			const domSelection = window.getSelection();
			domSelection?.removeAllRanges();
			domSelection?.addRange(range);
		}
	}

	return normalized;
};

const getLiveManagedText = (edytor: Edytor, node: Node) => {
	if (!isElement(node) || !node.hasAttribute('data-edytor-text')) {
		return null;
	}

	const id = node.getAttribute('data-edytor-id');
	const text = id ? edytor.idToText.get(id) : undefined;
	return text?.node === node && !text.yText._item?.deleted ? text : null;
};

const getTextOffsetInside = (root: Node, target: Node, targetOffset: number) => {
	if (target.nodeType === Node.TEXT_NODE) {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let current = walker.nextNode();
		let offset = 0;

		while (current) {
			if (current === target) {
				return offset + Math.min(targetOffset, current.textContent?.length ?? 0);
			}
			offset += current.textContent?.length ?? 0;
			current = walker.nextNode();
		}
	}

	if (target.nodeType === Node.ELEMENT_NODE) {
		let offset = 0;
		for (let index = 0; index < Math.min(targetOffset, target.childNodes.length); index++) {
			offset += target.childNodes[index].textContent?.length ?? 0;
		}
		return offset;
	}

	return null;
};

const getSelectionOffsetInside = (nodes: NodeList) => {
	const selection = getDomSelectionSnapshot(nodes[0]);
	if (!selection?.isCollapsed || !selection.anchorNode) {
		return undefined;
	}

	let offset = 0;
	for (const node of nodes) {
		if (node === selection.anchorNode || node.contains(selection.anchorNode)) {
			const localOffset = getTextOffsetInside(node, selection.anchorNode, selection.anchorOffset);
			return typeof localOffset === 'number' ? offset + localOffset : undefined;
		}
		offset += node.textContent?.length ?? 0;
	}

	return undefined;
};

type TextReplacement = {
	selectionOffset?: number;
	text: Text;
	value: string;
};

const getTextReplacements = (edytor: Edytor, mutations: MutationRecord[]) => {
	const replacements: TextReplacement[] = [];

	for (const mutation of mutations) {
		if (mutation.type !== 'childList' || mutation.addedNodes.length === 0) {
			continue;
		}

		const removedTexts = Array.from(mutation.removedNodes)
			.map((node) => getLiveManagedText(edytor, node))
			.filter((text): text is Text => Boolean(text));

		if (removedTexts.length !== 1) {
			continue;
		}

		const addedNodes = Array.from(mutation.addedNodes);
		if (
			addedNodes.some(
				(node) => isUnmanagedLineBreak(node) || isManagedNode(node) || containsManagedNode(node)
			)
		) {
			continue;
		}

		const value = addedNodes.map((node) => node.textContent ?? '').join('');
		if (value.length === 0) {
			continue;
		}

		replacements.push({
			text: removedTexts[0],
			value,
			selectionOffset: getSelectionOffsetInside(mutation.addedNodes)
		});
	}

	return replacements;
};

const shouldRemoveAddedNode = (
	root: HTMLElement,
	addedNode: Node,
	addedManagedRoots: Set<Node>
) => {
	if (!root.contains(addedNode)) {
		return false;
	}

	if (isUnmanagedLineBreak(addedNode)) {
		return true;
	}

	if (isInsideEditableIsland(addedNode)) {
		return false;
	}

	if (
		isManagedNode(addedNode) ||
		containsManagedNode(addedNode) ||
		isInSubtree(addedNode, addedManagedRoots)
	) {
		return false;
	}

	// Empty text nodes outside editable islands are Svelte's {#each}/{#if}
	// fragment boundary anchors (nodes.start/nodes.end). Removing them detaches
	// the effect's DOM range and corrupts keyed-each reconciliation — the next
	// reconcile walks a fragment whose `end` is no longer reachable and spins
	// forever. A browser-injected empty text node is harmless, so keep it.
	if (addedNode.nodeType === Node.TEXT_NODE && !addedNode.textContent?.length) {
		return false;
	}

	return addedNode.nodeType === Node.TEXT_NODE || addedNode.nodeType === Node.ELEMENT_NODE;
};

const isLiveManagedElement = (edytor: Edytor, node: Node) => {
	if (!isElement(node)) {
		return false;
	}

	if (node.hasAttribute('data-edytor-text')) {
		const id = node.getAttribute('data-edytor-id');
		const text = id ? edytor.idToText.get(id) : undefined;
		return Boolean(text?.node === node && !text.yText._item?.deleted);
	}

	if (node.hasAttribute('data-edytor-block')) {
		const id = node.getAttribute('data-edytor-id');
		const block = id ? edytor.idToBlock.get(id) : undefined;
		return Boolean(block?.node === node && !block.yBlock._item?.deleted);
	}

	if (node.hasAttribute('data-edytor-inline-block')) {
		const inlineBlock = edytor.nodeToInlineBlock.get(node);
		return Boolean(inlineBlock && !inlineBlock.yBlock._item?.deleted);
	}

	if (node.hasAttribute('data-edytor-trailing-newline')) {
		const textElement = node.closest('[data-edytor-text]');
		if (!(textElement instanceof HTMLElement)) {
			return false;
		}

		const id = textElement.getAttribute('data-edytor-id');
		const text = id ? edytor.idToText.get(id) : undefined;
		return Boolean(
			text?.node === textElement && text.endsWithNewline && !text.yText._item?.deleted
		);
	}

	return (
		node.hasAttribute('data-edytor-text-placeholder') ||
		node.hasAttribute('data-edytor-text-suggestion') ||
		node.hasAttribute('data-edytor-render-anchor') ||
		node.hasAttribute('data-edytor-plugin-chrome') ||
		node.hasAttribute('data-edytor-mark') ||
		node.hasAttribute('data-edytor-mark-void')
	);
};

const containsLiveManagedElement = (edytor: Edytor, node: Node) => {
	if (!isElement(node)) {
		return false;
	}

	for (const managedElement of node.querySelectorAll(MANAGED_SELECTOR)) {
		if (isLiveManagedElement(edytor, managedElement)) {
			return true;
		}
	}

	return false;
};

const shouldRestoreRemovedNode = (edytor: Edytor, root: HTMLElement, mutation: MutationRecord) => {
	if (mutation.target !== root && !root.contains(mutation.target)) {
		return false;
	}

	if (
		Array.from(mutation.addedNodes).some(
			(addedNode) => isManagedNode(addedNode) || containsManagedNode(addedNode)
		)
	) {
		return false;
	}

	return Array.from(mutation.removedNodes).some((removedNode) => {
		if (isManagedNode(removedNode)) {
			return isLiveManagedElement(edytor, removedNode);
		}

		return containsLiveManagedElement(edytor, removedNode);
	});
};

const getRestoreReferenceNode = (mutation: MutationRecord) => {
	if (mutation.nextSibling?.parentNode === mutation.target) {
		return mutation.nextSibling;
	}

	if (mutation.previousSibling?.parentNode === mutation.target) {
		return mutation.previousSibling.nextSibling;
	}

	return null;
};

const restoreRemovedManagedNodes = (
	edytor: Edytor,
	root: HTMLElement,
	mutations: MutationRecord[]
) => {
	let restoredManagedNode = false;

	for (const mutation of mutations) {
		if (mutation.type !== 'childList' || !shouldRestoreRemovedNode(edytor, root, mutation)) {
			continue;
		}

		const referenceNode = getRestoreReferenceNode(mutation);
		for (const removedNode of mutation.removedNodes) {
			if (isManagedNode(removedNode) && !isLiveManagedElement(edytor, removedNode)) {
				continue;
			}

			if (!isManagedNode(removedNode) && !containsLiveManagedElement(edytor, removedNode)) {
				continue;
			}

			mutation.target.insertBefore(removedNode, referenceNode);
			restoredManagedNode = true;
		}
	}

	return restoredManagedNode;
};

const removeAddedUnmanagedNodes = (
	root: HTMLElement,
	mutations: MutationRecord[],
	addedManagedRoots: Set<Node>
) => {
	let removedUnmanagedNode = false;

	for (const mutation of mutations) {
		for (const addedNode of mutation.addedNodes) {
			if (!shouldRemoveAddedNode(root, addedNode, addedManagedRoots)) {
				continue;
			}

			addedNode.parentNode?.removeChild(addedNode);
			removedUnmanagedNode = true;
		}
	}

	return removedUnmanagedNode;
};

const getLiveManagedTextElement = (edytor: Edytor, node: Node) => {
	const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
	if (!(element instanceof Element)) {
		return null;
	}

	const textElement = element.closest('[data-edytor-text]');
	if (!(textElement instanceof HTMLElement)) {
		return null;
	}

	const id = textElement.getAttribute('data-edytor-id');
	const text = id ? edytor.idToText.get(id) : undefined;
	return text?.node === textElement && !text.yText._item?.deleted ? textElement : null;
};

const getLiveManagedTextFromDescendant = (edytor: Edytor, node: Node) => {
	const textElement = getLiveManagedTextElement(edytor, node);
	if (!textElement) {
		return null;
	}

	const id = textElement.getAttribute('data-edytor-id');
	return id ? (edytor.idToText.get(id) ?? null) : null;
};

/**
 * An unmanaged element injected inside a live text element (spellcheck /
 * grammar overlays, GBoard spans, translate) is exempt from
 * `removeAddedUnmanagedNodes` so its text can be adopted — but it must be
 * settled exactly once, in a way that preserves the post-flush invariant
 * `text.node.textContent === text.stringContent` (+ ZWSP rules):
 *
 * - The containing text was made model-authoritative this flush — reconcile
 *   adopted the flattened `textContent` (the wrapper's text is already part
 *   of the model render) or a repair refreshed the element from the model
 *   (the wrapper's text was deliberately reverted). Either way the element
 *   is surplus foreign DOM → REMOVE it. Unwrapping here re-materializes the
 *   same text as a second node — the defect this path exists to prevent
 *   (`HelloROGUEROGUE` while the model holds `HelloROGUE` once).
 * - No adopt/revert decision ran for the containing text this flush →
 *   UNWRAP the element to a bare text node so its content is preserved
 *   exactly once for the next flush to decide on.
 */
const settleAddedUnmanagedTextWrappers = (
	edytor: Edytor,
	mutations: MutationRecord[],
	modelAuthoritativeTexts: Set<Text>
) => {
	let settledTextWrapper = false;

	for (const mutation of mutations) {
		for (const addedNode of mutation.addedNodes) {
			if (!isElement(addedNode) || !addedNode.isConnected) {
				continue;
			}

			if (
				isUnmanagedLineBreak(addedNode) ||
				isManagedNode(addedNode) ||
				containsManagedNode(addedNode)
			) {
				continue;
			}

			const text = getLiveManagedTextFromDescendant(edytor, addedNode);
			if (!text || text.node === addedNode) {
				continue;
			}

			if (modelAuthoritativeTexts.has(text)) {
				addedNode.parentNode?.removeChild(addedNode);
				settledTextWrapper = true;
				continue;
			}

			if (addedNode.parentElement?.closest(MANAGED_SELECTOR) === text.node) {
				addedNode.parentNode?.replaceChild(
					document.createTextNode(addedNode.textContent ?? ''),
					addedNode
				);
				settledTextWrapper = true;
			}
		}
	}

	return settledTextWrapper;
};

const hasManagedSubtreeMutation = (
	edytor: Edytor,
	root: HTMLElement,
	text: Text,
	mutations: MutationRecord[]
) =>
	mutations.some((mutation) => {
		if (mutation.type !== 'childList' || findMutatedText(edytor, root, mutation.target) !== text) {
			return false;
		}

		return [...mutation.addedNodes, ...mutation.removedNodes].some(
			(node) => isManagedNode(node) || containsManagedNode(node)
		);
	});

const hasTextNodeBoundaryMutation = (
	edytor: Edytor,
	root: HTMLElement,
	text: Text,
	mutations: MutationRecord[]
) =>
	mutations.some((mutation) => {
		if (mutation.type !== 'childList' || findMutatedText(edytor, root, mutation.target) !== text) {
			return false;
		}

		return [...mutation.addedNodes, ...mutation.removedNodes].some(
			(node) => node.nodeType === Node.TEXT_NODE
		);
	});

const getNormalizedTextNodeContent = (text: Text) => {
	let value = text.node?.textContent ?? '';

	if (value === '\u200B') {
		return '';
	}

	if ((text.isEmpty || text.endsWithNewline) && value.endsWith('\u200B')) {
		value = value.slice(0, -1);
	}

	return value;
};

const refreshManagedSubtreeMutationFromModel = (
	text: Text,
	options: { refreshUnchanged?: boolean } = {}
) => {
	if (!options.refreshUnchanged && getNormalizedTextNodeContent(text) === text.stringContent) {
		return false;
	}

	text.refreshFromModel();
	return true;
};

const restoreSelectionAfterRepair = async (edytor: Edytor) => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	if (!isCollapsed || !startText) {
		return;
	}

	await edytor.selection.setAtTextOffset(startText, yStart);
};

export const observeDomTextMutations = (edytor: Edytor, root: HTMLElement) => {
	if (typeof MutationObserver === 'undefined') {
		return () => {};
	}

	const queuedTexts = new Set<Text>();
	const queuedMutations: MutationRecord[] = [];
	let isFlushScheduled = false;
	let compositionMutationTimer: ReturnType<typeof setTimeout> | null = null;
	let suppressedMutationRetryTimer: ReturnType<typeof setTimeout> | null = null;
	let shouldRestoreCompositionMutationSelection = false;
	let observer: MutationObserver;

	const cancelIdleCompositionPreview = async () => {
		const state = edytor.compositionState;
		edytor.compositionState = null;
		edytor.isComposing = false;
		edytor.hasHandledCompositionInput = false;

		if (!state || state.value.length === 0) {
			return false;
		}

		const text = edytor.getTextById(state.textId);
		if (!text) {
			return false;
		}

		const deleteLength = Math.min(state.value.length, text.length - state.startOffset);
		if (deleteLength <= 0) {
			return false;
		}

		text.yText.delete(state.startOffset, deleteLength);
		text.refreshFromModel();
		await edytor.selection.setAtTextOffset(text, state.startOffset);
		return true;
	};

	const observe = () => {
		observer.observe(root, {
			characterData: true,
			childList: true,
			subtree: true
		});
	};

	const scheduleCompositionMutationFlush = () => {
		if (compositionMutationTimer) {
			clearTimeout(compositionMutationTimer);
		}

		compositionMutationTimer = setTimeout(() => {
			compositionMutationTimer = null;
			void cancelIdleCompositionPreview().then((didCancelPreview) => {
				shouldRestoreCompositionMutationSelection = !didCancelPreview;
				queueFlush();
			});
		}, COMPOSITION_MUTATION_IDLE_MS);
	};

	const scheduleSuppressedMutationRetry = () => {
		if (suppressedMutationRetryTimer) {
			return;
		}

		suppressedMutationRetryTimer = setTimeout(() => {
			suppressedMutationRetryTimer = null;
			queueFlush();
		}, 16);
	};

	const flush = async () => {
		isFlushScheduled = false;
		const texts = Array.from(queuedTexts);
		const mutations = queuedMutations.splice(0);
		queuedTexts.clear();

		if (texts.length === 0 && mutations.length === 0) {
			return;
		}

		if (edytor.readonly) {
			return;
		}

		if (edytor.shouldSuppressObservedMutationFallback) {
			if (edytor.shouldFlushSuppressedObservedMutationFallback) {
				// Model-owned native input repairs must discard stale browser mutations.
				const addedManagedRoots = getAddedManagedRoots(mutations);
				observer.disconnect();
				try {
					removeAddedUnmanagedNodes(root, mutations, addedManagedRoots);
					restoreRemovedManagedNodes(edytor, root, mutations);
					removeStalePlaceholdersIn(root);
				} finally {
					observe();
				}
				return;
			}

			for (const text of texts) {
				queuedTexts.add(text);
			}
			queuedMutations.unshift(...mutations);
			scheduleSuppressedMutationRetry();
			return;
		}

		if (edytor.isComposing) {
			for (const text of texts) {
				queuedTexts.add(text);
			}
			scheduleCompositionMutationFlush();
			return;
		}

		const textReplacements = getTextReplacements(edytor, mutations);
		const replacedTexts = new Set(textReplacements.map((replacement) => replacement.text));
		const changedTexts = new Set<Text>();
		const shouldRestoreCompositionSelection = shouldRestoreCompositionMutationSelection;
		shouldRestoreCompositionMutationSelection = false;
		const addedManagedRoots = getAddedManagedRoots(mutations);
		const refreshedTexts = new Set<Text>();
		let removedUnmanagedNode: boolean;
		let restoredManagedNode: boolean;
		let settledTextWrapper: boolean;
		let normalizedConvertedSpace: boolean;

		observer.disconnect();
		try {
			for (const replacement of textReplacements) {
				if (await handleNativeLineBreakTextValue(edytor, replacement.text, replacement.value)) {
					changedTexts.add(replacement.text);
					continue;
				}

				if (await reconcileTextValue(edytor, replacement.text, replacement.value)) {
					changedTexts.add(replacement.text);
				}
			}
			normalizedConvertedSpace = normalizeConvertedSpaceNodes(root, mutations);
			removedUnmanagedNode = removeAddedUnmanagedNodes(root, mutations, addedManagedRoots);
			restoredManagedNode = restoreRemovedManagedNodes(edytor, root, mutations);

			const selection = getCollapsedDomTextSelection(edytor);
			for (const text of texts) {
				if (replacedTexts.has(text)) {
					continue;
				}

				if (hasManagedSubtreeMutation(edytor, root, text, mutations)) {
					refreshManagedSubtreeMutationFromModel(text, { refreshUnchanged: true });
					refreshedTexts.add(text);
					continue;
				}

				if (
					hasTextNodeBoundaryMutation(edytor, root, text, mutations) &&
					getNormalizedTextNodeContent(text) === text.stringContent
				) {
					refreshManagedSubtreeMutationFromModel(text, { refreshUnchanged: true });
					refreshedTexts.add(text);
					continue;
				}

				if (await handleNativeLineBreakTextMutation(edytor, text)) {
					changedTexts.add(text);
					continue;
				}

				const didReconcile = await reconcileDomText(
					edytor,
					text,
					selection?.text === text ? selection.offset : undefined
				);
				if (didReconcile) {
					changedTexts.add(text);
				}
			}

			for (const replacement of textReplacements) {
				if (typeof replacement.selectionOffset === 'number') {
					await edytor.selection.setAtTextOffset(replacement.text, replacement.selectionOffset);
				}
			}

			for (const text of [...texts, ...replacedTexts]) {
				removeStalePlaceholders(text);
			}

			if (shouldRestoreCompositionSelection) {
				const text = changedTexts.values().next().value;
				if (text) {
					await edytor.selection.setAtTextOffset(text, text.length);
				}
			}

			removeStalePlaceholdersIn(root);

			if (refreshedTexts.size > 0) {
				await tick();
			}

			// Injected wrappers inside a live text element are settled AFTER
			// the adopt/revert decision above — texts the model now owns lose
			// the surplus element; undecided texts keep it flattened.
			settledTextWrapper = settleAddedUnmanagedTextWrappers(
				edytor,
				mutations,
				new Set([...changedTexts, ...refreshedTexts])
			);
		} finally {
			observe();
		}

		if (
			removedUnmanagedNode ||
			restoredManagedNode ||
			settledTextWrapper ||
			normalizedConvertedSpace ||
			refreshedTexts.size > 0
		) {
			await restoreSelectionAfterRepair(edytor);
		}
	};

	const queueFlush = () => {
		if (isFlushScheduled) {
			return;
		}

		isFlushScheduled = true;
		queueMicrotask(() => {
			void flush();
		});
	};

	observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (mutation.type !== 'characterData' && mutation.type !== 'childList') {
				continue;
			}

			queuedMutations.push(mutation);
			const text = findMutatedText(edytor, root, mutation.target);
			if (text) {
				queuedTexts.add(text);
			}
		}

		if (queuedTexts.size > 0 || queuedMutations.length > 0) {
			queueFlush();
		}
	});

	observe();

	return () => {
		if (compositionMutationTimer) {
			clearTimeout(compositionMutationTimer);
		}
		if (suppressedMutationRetryTimer) {
			clearTimeout(suppressedMutationRetryTimer);
		}
		observer.disconnect();
	};
};
