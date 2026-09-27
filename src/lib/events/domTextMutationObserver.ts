import type { Edytor } from '../edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import { Block } from '../block/block.svelte.js';
import type { InlineBlock } from '../block/inlineBlock.svelte.js';
import { tick } from 'svelte';
import {
	getActiveElement,
	getDomSelection,
	getDomSelectionSnapshot
} from '$lib/selection/domSelection.js';
import { climb } from '$lib/selection/selection.utils.js';
import { isNestedForeignEditableTarget } from './nativeInteractiveControl.js';
import {
	getCollapsedDomTextSelection,
	getNormalizedDomText,
	handleNativeLineBreakTextMutation,
	handleNativeLineBreakTextValue,
	removeUnmanagedLineBreaks
} from './onInput.js';
import { scheduleRemoveStalePlaceholders } from '$lib/text/removeStalePlaceholders.js';
import { diffText } from '$lib/utils/diffText.js';
import { activeMarks } from '$lib/session/editing/text.js';
import { INTENTS } from '$lib/session/attempt.js';
import { jsonValuesEqual } from '$lib/collaboration/awarenessSelection.js';

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
// cf. Quill's MAX_OPTIMIZE_ITERATIONS — bounded repair so a foreign writer
// (or our own heals) cannot spin an unbounded observer/repair loop.
const MAX_MUTATION_REPAIR_CYCLES = 100;
const MUTATION_REPAIR_WINDOW_MS = 250;

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

const isInsideEditableIsland = (edytor: Edytor, node: Node) => {
	const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
	if (!(element instanceof Element)) {
		return false;
	}
	const island = element.closest(EDITABLE_ISLAND_SELECTOR);
	// The island exemption exists for foreign content inside OUR managed
	// surfaces — a spoofed marker (an injected element carrying
	// `data-edytor-text` itself) must not self-claim island status, so
	// the island element is verified against the live bindings too.
	return island !== null && isLiveAddedManagedElement(edytor, island);
};

const isInSubtree = (node: Node, roots: Set<Node>) => {
	for (const root of roots) {
		if (node === root || root.contains(node)) {
			return true;
		}
	}
	return false;
};

const getAddedManagedRoots = (edytor: Edytor, mutations: MutationRecord[]) => {
	const roots = new Set<Node>();
	for (const mutation of mutations) {
		for (const addedNode of mutation.addedNodes) {
			if (
				isLiveAddedManagedNode(edytor, addedNode) ||
				containsLiveAddedManagedElement(edytor, addedNode)
			) {
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
	return text?.node === node && text.isInDocument ? text : null;
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
	edytor: Edytor,
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

	if (isInsideEditableIsland(edytor, addedNode)) {
		return false;
	}

	// Content added inside an ALREADY-LIVE plugin-chrome host (tooltips,
	// dynamic handle content) belongs to the plugin's own DOM — only the
	// host's first commit needed the managed-roots exemption. A spoofed
	// chrome marker resolves dead here, so it can't shield its children.
	const chromeHost =
		addedNode instanceof Element || addedNode.nodeType === Node.TEXT_NODE
			? (addedNode.parentElement?.closest('[data-edytor-plugin-chrome]') ?? null)
			: null;
	if (chromeHost && isLiveAddedManagedElement(edytor, chromeHost)) {
		return false;
	}

	if (
		isLiveAddedManagedNode(edytor, addedNode) ||
		containsLiveAddedManagedElement(edytor, addedNode) ||
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

const shouldRestoreManagedMark = (text: Text, node: Element) => {
	const markName = node.getAttribute('data-edytor-mark');
	if (!markName || !text.node) {
		return false;
	}

	const expectedCount = text.renderChildren.reduce(
		(count, delta) =>
			count + delta.marks.filter(([currentMarkName]) => currentMarkName === markName).length,
		0
	);
	const renderedCount = Array.from(text.node.querySelectorAll('[data-edytor-mark]')).filter(
		(mark) => mark.getAttribute('data-edytor-mark') === markName
	).length;

	return renderedCount < expectedCount;
};

const TEXT_SELECTOR = '[data-edytor-text="true"]';
const PLACEHOLDER_SELECTOR = '[data-edytor-text-placeholder]';
const OBSERVER_ZERO_WIDTH_SPACE = '\u200B';

const hasVisibleTextElementContent = (element: Element) =>
	Boolean(element.textContent?.replaceAll(OBSERVER_ZERO_WIDTH_SPACE, '').length);

/**
 * A placeholder is live only while it should be rendered: the parent it
 * was removed from holds no visible text element and no surviving sibling
 * placeholder. A removal that fails either check is intentional staleness
 * repair (the repair queue's sweep or Svelte's own unmount) — restoring it
 * would fight the repair and loop forever.
 */
// Placeholder liveness is scoped to the parent's DIRECT children —
// `heading`/`quote` snippets render nested block children inside the
// same element as their own content, so a descendant query would count
// a nested child's text (or placeholder) against the parent's own
// placeholder (cf. `blockHasVisibleText` in Text.svelte).
const directChildrenMatching = (parent: Element, selector: string) =>
	Array.from(parent.children).filter((child) => child.matches(selector));

const isLivePlaceholderElement = (node: Node, removedFrom?: Node) => {
	const parent = node.parentElement ?? (removedFrom instanceof Element ? removedFrom : null);
	if (!parent) {
		return true;
	}
	if (directChildrenMatching(parent, TEXT_SELECTOR).some(hasVisibleTextElementContent)) {
		return false;
	}
	return directChildrenMatching(parent, PLACEHOLDER_SELECTOR).length === 0;
};

/**
 * The added-node counterpart — the element itself already sits in the
 * parent, so the sibling check excludes it (a second placeholder means
 * the added one is the stale duplicate).
 */
const isLiveAddedPlaceholderElement = (element: Element) => {
	const parent = element.parentElement;
	if (!parent) {
		return false;
	}
	if (directChildrenMatching(parent, TEXT_SELECTOR).some(hasVisibleTextElementContent)) {
		return false;
	}
	return directChildrenMatching(parent, PLACEHOLDER_SELECTOR).every(
		(placeholder) => placeholder === element
	);
};

const isLiveManagedElement = (
	edytor: Edytor,
	node: Node,
	mutatedText?: Text | null,
	removedFrom?: Node
) => {
	if (!isElement(node)) {
		return false;
	}

	if (node.hasAttribute('data-edytor-text')) {
		const id = node.getAttribute('data-edytor-id');
		const text = id ? edytor.idToText.get(id) : undefined;
		return Boolean(text?.node === node && text.isInDocument);
	}

	if (node.hasAttribute('data-edytor-block')) {
		const id = node.getAttribute('data-edytor-id');
		const block = id ? edytor.idToBlock.get(id) : undefined;
		return Boolean(block?.node === node && block.isInTree);
	}

	if (node.hasAttribute('data-edytor-inline-block')) {
		const inlineBlock = edytor.nodeToInlineBlock.get(node);
		return Boolean(inlineBlock && inlineBlock.isInDocument);
	}

	if (node.hasAttribute('data-edytor-trailing-newline')) {
		const textElement = node.closest('[data-edytor-text]');
		if (!(textElement instanceof HTMLElement)) {
			return false;
		}

		const id = textElement.getAttribute('data-edytor-id');
		const text = id ? edytor.idToText.get(id) : undefined;
		return Boolean(text?.node === textElement && text.endsWithNewline && text.isInDocument);
	}

	if (node.hasAttribute('data-edytor-mark') && mutatedText) {
		// Svelte can insert plain text and remove its old mark wrapper in
		// separate mutation records. Restore the wrapper only while the current
		// render projection still requires more instances of that mark.
		return shouldRestoreManagedMark(mutatedText, node);
	}

	if (node.hasAttribute('data-edytor-text-placeholder')) {
		return isLivePlaceholderElement(node, removedFrom);
	}

	// Remaining chrome markers are judged on "still required", not marker
	// presence — restoring unconditionally reverts INTENTIONAL removals
	// (suggestion dismissal, plugin cleanup) and leaves zombies nothing
	// re-removes.
	if (node.hasAttribute('data-edytor-text-suggestion')) {
		// Removed nodes are detached — resolve the owner through the
		// record's target. Still required only while the owning block
		// carries suggestions.
		const blockElement =
			removedFrom instanceof Element ? removedFrom.closest('[data-edytor-block]') : null;
		const id = blockElement?.getAttribute('data-edytor-id');
		const block = id ? edytor.idToBlock.get(id) : undefined;
		return Boolean(block?.node === blockElement && block.isInTree && block.suggestions);
	}

	if (node.hasAttribute('data-edytor-render-anchor')) {
		// Ours only when it was removed directly from the editor root —
		// any other parent makes it a spoof or a plugin-rendered twin.
		return removedFrom === edytor.node;
	}

	if (node.hasAttribute('data-edytor-plugin-chrome')) {
		// Plugin-owned chrome manages its own lifecycle (blockHandles'
		// stale-host sweep, unmount teardown). Restoring a removed host
		// produces permanent zombies; foreign removal is the rarer,
		// safer failure mode.
		return false;
	}

	if (node.hasAttribute('data-edytor-mark') || node.hasAttribute('data-edytor-mark-void')) {
		// No mutatedText context — verify like the added side: the owner
		// text (via the record's target) must be live and still project
		// this mark name.
		const markName = node.getAttribute('data-edytor-mark');
		const textElement =
			removedFrom instanceof Element ? removedFrom.closest('[data-edytor-text]') : null;
		const id = textElement?.getAttribute('data-edytor-id');
		const text = id ? edytor.idToText.get(id) : undefined;
		return Boolean(
			markName &&
			text?.node === textElement &&
			text.isInDocument &&
			text.renderChildren.some((delta) => delta.marks.some(([name]) => name === markName))
		);
	}

	return false;
};

const containsLiveManagedElement = (
	edytor: Edytor,
	node: Node,
	mutatedText?: Text | null,
	removedFrom?: Node
) => {
	if (!isElement(node)) {
		return false;
	}

	for (const managedElement of node.querySelectorAll(MANAGED_SELECTOR)) {
		if (isLiveManagedElement(edytor, managedElement, mutatedText, removedFrom)) {
			return true;
		}
	}

	return false;
};

/**
 * Liveness check for a managed-MARKED element that was just ADDED to the
 * DOM — the inverse of `isLiveManagedElement` (which asks "was this
 * removed node still needed"). Here the question is "is this element
 * the one the renderer produced". Identity surfaces are verified
 * against the live bindings (`idToText`/`idToBlock`/`nodeToInlineBlock`
 * — attach actions bind synchronously during the same render commit, so
 * bindings are always established by flush time); marks require the
 * owning text's projection to actually carry the mark name; remaining
 * chrome markers must sit inside a live text/block/inline-block owner.
 * A foreign element spoofing our markers never resolves — without this
 * check `isManagedNode` alone would exempt it from
 * `removeAddedUnmanagedNodes` and let it poison identity lookups,
 * placeholder logic, and mark counts forever.
 */
const isLiveAddedManagedElement = (edytor: Edytor, element: Element): boolean => {
	if (element.hasAttribute('data-edytor')) {
		// A descendant carrying the ROOT marker is always a spoof — the
		// real root is the observed element itself. Checked first so a
		// multi-marker spoof can't satisfy an earlier branch.
		return false;
	}

	if (element.hasAttribute('data-edytor-text')) {
		const id = element.getAttribute('data-edytor-id');
		const text = id ? edytor.idToText.get(id) : undefined;
		return Boolean(text?.node === element && text.isInDocument);
	}

	if (element.hasAttribute('data-edytor-block')) {
		const id = element.getAttribute('data-edytor-id');
		const block = id ? edytor.idToBlock.get(id) : undefined;
		return Boolean(block?.node === element && block.isInTree);
	}

	if (element.hasAttribute('data-edytor-inline-block')) {
		const inlineBlock = edytor.nodeToInlineBlock.get(element);
		return Boolean(inlineBlock && inlineBlock.isInDocument);
	}

	if (element.hasAttribute('data-edytor-trailing-newline')) {
		const textElement = element.closest('[data-edytor-text]');
		if (!(textElement instanceof HTMLElement)) {
			return false;
		}
		const id = textElement.getAttribute('data-edytor-id');
		const text = id ? edytor.idToText.get(id) : undefined;
		return Boolean(text?.node === textElement && text.endsWithNewline && text.isInDocument);
	}

	if (element.hasAttribute('data-edytor-text-placeholder')) {
		return isLiveAddedPlaceholderElement(element);
	}

	if (element.hasAttribute('data-edytor-mark')) {
		const markName = element.getAttribute('data-edytor-mark');
		const textElement = element.closest('[data-edytor-text]');
		const id = textElement?.getAttribute('data-edytor-id');
		const text = id ? edytor.idToText.get(id) : undefined;
		return Boolean(
			markName &&
			text?.node === textElement &&
			text.isInDocument &&
			text.renderChildren.some((delta) => delta.marks.some(([name]) => name === markName))
		);
	}

	// Remaining chrome markers (suggestion, render anchor, plugin chrome,
	// mark-void): legitimate only inside a live managed owner. A
	// marker-less foreign element is never managed content — without this
	// gate any injected wrapper inside a live text element would claim
	// the owner's binding and escape both removal and the settle pass.
	if (
		!element.hasAttribute('data-edytor-text-suggestion') &&
		!element.hasAttribute('data-edytor-mark-void') &&
		!element.hasAttribute('data-edytor-plugin-chrome') &&
		!element.hasAttribute('data-edytor-render-anchor')
	) {
		return false;
	}
	const owner = element.closest(
		'[data-edytor-text], [data-edytor-inline-block], [data-edytor-block], [data-edytor]'
	);
	if (!owner) {
		return false;
	}
	// Chrome markers only legitimately appear under specific owner
	// kinds — a `render-anchor`/`plugin-chrome`/`suggestion` inside a
	// text element, or a `mark-void` outside one, is a spoof.
	const ownerKind = owner.hasAttribute('data-edytor')
		? 'root'
		: owner.hasAttribute('data-edytor-text')
			? 'text'
			: owner.hasAttribute('data-edytor-inline-block')
				? 'inline-block'
				: 'block';
	const allowedOwners = element.hasAttribute('data-edytor-mark-void')
		? ['text']
		: element.hasAttribute('data-edytor-text-suggestion')
			? ['block']
			: element.hasAttribute('data-edytor-render-anchor')
				? ['root']
				: ['root', 'block', 'text', 'inline-block']; // plugin-chrome
	if (!allowedOwners.includes(ownerKind)) {
		return false;
	}
	if (owner.hasAttribute('data-edytor')) {
		// Root-level chrome — e.g. the render anchor `Edytor.svelte` mounts
		// as a direct child of the root — is legitimate only under OUR
		// root element.
		return owner === edytor.node;
	}
	if (owner.hasAttribute('data-edytor-text')) {
		const id = owner.getAttribute('data-edytor-id');
		const text = id ? edytor.idToText.get(id) : undefined;
		return Boolean(text?.node === owner && text.isInDocument);
	}
	if (owner.hasAttribute('data-edytor-inline-block')) {
		const inlineBlock = edytor.nodeToInlineBlock.get(owner);
		return Boolean(inlineBlock && inlineBlock.isInDocument);
	}
	const id = owner.getAttribute('data-edytor-id');
	const block = id ? edytor.idToBlock.get(id) : undefined;
	return Boolean(block?.node === owner && block.isInTree);
};

const isLiveAddedManagedNode = (edytor: Edytor, node: Node) =>
	isElement(node) && isLiveAddedManagedElement(edytor, node);

const containsLiveAddedManagedElement = (edytor: Edytor, node: Node) => {
	if (!isElement(node)) {
		return false;
	}
	for (const managedElement of node.querySelectorAll(MANAGED_SELECTOR)) {
		if (isLiveAddedManagedElement(edytor, managedElement)) {
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
			(addedNode) =>
				isLiveAddedManagedNode(edytor, addedNode) ||
				containsLiveAddedManagedElement(edytor, addedNode)
		)
	) {
		return false;
	}

	const mutatedText = findMutatedText(edytor, root, mutation.target);
	return Array.from(mutation.removedNodes).some((removedNode) => {
		if (isManagedNode(removedNode)) {
			return isLiveManagedElement(edytor, removedNode, mutatedText, mutation.target);
		}

		return containsLiveManagedElement(edytor, removedNode, mutatedText, mutation.target);
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
		const mutatedText = findMutatedText(edytor, root, mutation.target);
		for (const removedNode of mutation.removedNodes) {
			if (
				isManagedNode(removedNode) &&
				!isLiveManagedElement(edytor, removedNode, mutatedText, mutation.target)
			) {
				continue;
			}

			if (
				!isManagedNode(removedNode) &&
				!containsLiveManagedElement(edytor, removedNode, mutatedText, mutation.target)
			) {
				continue;
			}

			mutation.target.insertBefore(removedNode, referenceNode);
			restoredManagedNode = true;
		}
	}

	return restoredManagedNode;
};

const removeAddedUnmanagedNodes = (
	edytor: Edytor,
	root: HTMLElement,
	mutations: MutationRecord[],
	addedManagedRoots: Set<Node>
) => {
	let removedUnmanagedNode = false;

	for (const mutation of mutations) {
		for (const addedNode of mutation.addedNodes) {
			if (!shouldRemoveAddedNode(edytor, root, addedNode, addedManagedRoots)) {
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
	return text?.node === textElement && text.isInDocument ? textElement : null;
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
				isLiveAddedManagedNode(edytor, addedNode) ||
				containsLiveAddedManagedElement(edytor, addedNode)
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

const refreshManagedSubtreeMutationFromModel = (
	text: Text,
	options: { refreshUnchanged?: boolean } = {}
) => {
	if (!options.refreshUnchanged && getNormalizedDomText(text) === text.stringContent) {
		return false;
	}

	text.refreshFromModel();
	return true;
};

type SelectionBeforeRepair = {
	startText: Text | null;
	yStart: number;
	isCollapsed: boolean;
	anchor: import('../selection/selection.svelte.js').TextAnchor | null;
};

const captureSelectionBeforeRepair = (edytor: Edytor): SelectionBeforeRepair => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	return {
		startText,
		yStart,
		isCollapsed,
		// Reuse the endpoint anchor minted at the last legitimate
		// selection write — do NOT mint a fresh anchor here. A remote
		// commit can land before this flush runs, leaving `state` at a
		// not-yet-re-resolved offset; an anchor minted at that absolute
		// offset would resolve right back to the stale spot. The live
		// endpoint anchor predates the commit, so it resolves to where
		// the content actually went (an insert before the caret shifts
		// it), and through commit-free renderer churn it resolves to
		// the caret the user had.
		anchor: edytor.selection.state.relativePosition
	};
};

const restoreSelectionAfterRepair = async (edytor: Edytor, before?: SelectionBeforeRepair) => {
	// An editor-owned atomic selection (inline atom, block selection)
	// deliberately keeps NO DOM range while `state.startText` still holds
	// the anchor text position — restoring that stale caret here would
	// re-derive a text selection and wipe the atomic selection.
	if (
		edytor.selection.selectedInlineBlock.size > 0 ||
		edytor.selection.selectedBlocks.size > 0 ||
		edytor.selection.inlineBlockDeletionTarget
	) {
		return;
	}

	// A live DOM selection OUTSIDE the editor means the user moved focus
	// while this flush ran — re-asserting the model caret would steal the
	// selection back. A caret inside a nested foreign editable is equally
	// user-owned — it sits inside `edytor.node` but belongs to the
	// island, and the derive-side island guard keeps it out of the model,
	// so `state` never saw it. (Same containment check the deferred
	// restore uses.)
	const selection = getDomSelection(edytor.node);
	if (selection?.anchorNode) {
		if (!(edytor.node as Node).contains(selection.anchorNode)) {
			return;
		}
		if (
			isNestedForeignEditableTarget(edytor.node, selection.anchorNode) ||
			(selection.focusNode && isNestedForeignEditableTarget(edytor.node, selection.focusNode))
		) {
			return;
		}
	}

	// A focused plugin-chrome control inside the editor is user-owned —
	// repairing the text caret would steal its focus.
	const activeElement = getActiveElement(edytor.node);
	if (
		activeElement &&
		edytor.node &&
		edytor.node.contains(activeElement) &&
		activeElement.closest('[data-edytor-plugin-chrome]')
	) {
		return;
	}

	// A gesture that landed OUTSIDE the editor — outside pointerdown or
	// focus moved to an outside target — means the live DOM
	// selection/focus is user-owned: restoring would steal it back.
	// Deliberately NOT gesture-count based: a foreign mutation that blurs
	// the editor (removing `contenteditable` from the root) produces a
	// focusout indistinguishable from a user blur, yet its damage must be
	// repaired — only the landing point of the gesture separates the two.
	if (edytor.lastUserGestureOutsideEditor) {
		return;
	}

	const state = edytor.selection.state;
	// The DOM selection already mirrors the model — nothing to repair.
	// (A legit mid-flush writer places its own DOM caret; restoring the
	// pre-repair position would regress it.)
	const domCaret = getCollapsedDomTextSelection(edytor);
	if (domCaret && domCaret.text === state.startText && domCaret.offset === state.yStart) {
		return;
	}

	// Prefer the endpoint anchor captured at repair start — it resolves
	// to where the user's caret actually is: through renderer churn
	// (remounts, token re-renders re-basing the live range) it yields
	// the pre-repair position, and through a remote commit that landed
	// in the repair window it follows the shifted content. `state`
	// remains the fallback when the anchor can't resolve.
	const resolvedBefore =
		before && before.isCollapsed && before.anchor
			? edytor.selection.resolveTextAnchor(before.anchor)
			: null;
	const target = resolvedBefore
		? { startText: resolvedBefore.text, yStart: resolvedBefore.offset, isCollapsed: true }
		: state;
	const { startText, yStart, isCollapsed } = target;
	if (!isCollapsed || !startText) {
		return;
	}

	// Repair writes are maintenance, not typing — they must not scroll
	// the page when they land inside an in-flight user-input window.
	edytor.suppressCaretScrollDepth++;
	try {
		await edytor.selection.setAtTextOffset(startText, yStart);
	} finally {
		edytor.suppressCaretScrollDepth--;
	}
};

/**
 * Chromium drops the document selection in a TASK when a foreign mutation
 * blurs the editor — e.g. removing `contenteditable` from the root moves
 * focus to `<body>` and clears the range a moment later, AFTER this
 * microtask flush. A caret restored synchronously here is then cleared by
 * the browser's own deferred pass. Re-check once on the next macrotask:
 * when the model still holds a text selection but the DOM has no range at
 * all, re-apply it. Bounded to a single deferred attempt — a live range
 * (inside or outside the editor) means the browser or a real selection
 * event has since claimed the selection, and the model's selectionchange
 * derive will have caught up.
 */
const scheduleDeferredSelectionRestore = (edytor: Edytor, root: HTMLElement) => {
	setTimeout(() => {
		if (!root.isConnected) {
			return;
		}
		const selection = getDomSelection(root);
		if (selection && selection.rangeCount > 0) {
			return;
		}
		// A gesture that landed outside the editor (outside pointerdown or
		// focus moved to an outside target) means the dropped range is
		// user-owned — restoring would pull focus back into an editor the
		// user just left. Mutation-caused blurs carry no outside gesture,
		// so foreign-damage repairs still land.
		if (edytor.lastUserGestureOutsideEditor) {
			return;
		}
		// See restoreSelectionAfterRepair — a missing DOM range is the
		// expected state for an editor-owned atomic selection, not damage.
		if (
			edytor.selection.selectedInlineBlock.size > 0 ||
			edytor.selection.selectedBlocks.size > 0 ||
			edytor.selection.inlineBlockDeletionTarget
		) {
			return;
		}
		const { startText, endText, yStart, yEnd, isCollapsed, isReversed } = edytor.selection.state;
		// See restoreSelectionAfterRepair — deferred repairs must not
		// scroll the page inside an in-flight user-input window.
		edytor.suppressCaretScrollDepth++;
		const releaseScrollSuppress = () => {
			edytor.suppressCaretScrollDepth--;
		};
		const track = (promise: Promise<unknown>) => {
			void promise.finally(releaseScrollSuppress).catch(() => {});
		};
		if (isCollapsed) {
			if (startText) {
				track(edytor.selection.setAtTextOffset(startText, yStart));
				return;
			}
			releaseScrollSuppress();
			return;
		}
		if (startText && endText) {
			track(edytor.selection.setAtRange(startText, yStart, endText, yEnd, { isReversed }));
			return;
		}
		releaseScrollSuppress();
	}, 0);
};

// ── Foreign attribute mutation healing ────────────────────────────────
// Grammarly-class extensions, spellcheck overlays, and browser UI write
// attributes on managed DOM (class, style, data-*, contenteditable). The
// observer subscribes to `attributes` + `attributeOldValue`, so these
// records now arrive here. The rule per element:
//
// - Editor-exclusive surfaces (text elements, inline-block wrappers,
//   marker leaves) are STRICT: owned attributes are restored to their
//   model-driven value and every other attribute is stripped.
// - Shared surfaces (block elements, plugin chrome, the editor root) are
//   TOLERANT: owned `data-edytor-*` attributes are restored, everything
//   else is left alone — plugin attach hooks and component props legitimately
//   write `data-*`/`class`/`style` there and must not be fought.
// - Attribute damage inside a live text element (marks, mark-voids, the
//   trailing-newline marker, foreign spans) heals by re-rendering the
//   owning text from the model — attribute-level patching inside a Svelte
//   projection would only fight the next render anyway.
//
// Healing compares before it writes, so records produced by the editor's
// own attribute consumers (Svelte bindings, `attach`, selection flags)
// settle as no-ops instead of requeueing forever.

type ManagedAttributeSpec = {
	/**
	 * Attribute name → required value ('' for bare attributes, null when
	 * the attribute must be absent).
	 */
	owned: Record<string, string | null>;
	/** Owned inline-style properties (kebab-case); null → must be unset. */
	ownedStyle: Record<string, string | null>;
	/** Strip every attribute outside `owned` (+ `style`, healed separately). */
	strict: boolean;
};

const textMutationAttributeSpec = (text: Text): ManagedAttributeSpec => {
	let insideVoid = Boolean(text.parent.definition.void);
	climb(text.parent, (block) => {
		if (block instanceof Block && block.definition.void) {
			insideVoid = true;
			return true;
		}
	});
	return {
		strict: true,
		owned: {
			'data-edytor-text': 'true',
			'data-edytor-id': text.id,
			'data-edytor-text-empty': String(text.isEmpty),
			contenteditable: insideVoid ? 'true' : null
		},
		ownedStyle: {
			'white-space': 'break-spaces',
			outline: insideVoid ? 'none' : null
		}
	};
};

const blockMutationAttributeSpec = (edytor: Edytor, block: Block): ManagedAttributeSpec => ({
	// Plugin attach hooks (block handles, drop-position markers) write their
	// own attributes on the block element — only the structural identity
	// attributes are restored; the rest of the surface stays plugin-owned.
	strict: false,
	owned: {
		'data-edytor-block': 'true',
		'data-edytor-id': block.id,
		'data-edytor-type': block.type,
		'data-edytor-void': block.definition.void ? 'true' : null,
		'data-edytor-selected': edytor.selection.selectedBlocks.has(block) ? 'true' : null,
		'data-edytor-focused': edytor.selection.focusedBlocks.has(block) ? 'true' : null,
		contenteditable: block.definition.void ? 'false' : null
	},
	ownedStyle: block.definition.void ? { 'user-select': 'none' } : {}
});

const inlineBlockMutationAttributeSpec = (inlineBlock: InlineBlock): ManagedAttributeSpec => ({
	strict: true,
	owned: {
		'data-edytor-inline-block': inlineBlock.type,
		'data-edytor-id': inlineBlock.id,
		contenteditable: 'false'
	},
	ownedStyle: {}
});

const PLACEHOLDER_ATTRIBUTE_SPEC: ManagedAttributeSpec = {
	strict: true,
	owned: {
		'data-edytor-text-placeholder': '',
		role: 'button',
		contenteditable: 'false',
		tabindex: '-1'
	},
	ownedStyle: { 'user-select': 'none' }
};

const SUGGESTION_ATTRIBUTE_SPEC: ManagedAttributeSpec = {
	strict: true,
	owned: {
		'data-edytor-text-suggestion': '',
		contenteditable: 'false'
	},
	ownedStyle: { 'user-select': 'none', 'pointer-events': 'none' }
};

const RENDER_ANCHOR_ATTRIBUTE_SPEC: ManagedAttributeSpec = {
	strict: true,
	owned: {
		'data-edytor-render-anchor': '',
		contenteditable: 'false',
		'aria-hidden': 'true'
	},
	ownedStyle: { display: 'none' }
};

const PLUGIN_CHROME_ATTRIBUTE_SPEC: ManagedAttributeSpec = {
	// Plugin chrome hosts carry plugin-owned attrs (data-block-id,
	// contenteditable, host markers) — only the identity marker is owned.
	strict: false,
	owned: { 'data-edytor-plugin-chrome': 'true' },
	ownedStyle: {}
};

/**
 * Marker attributes that make an element managed on their own. The spec
 * heals them on connected elements — including marker-removal records
 * (the element no longer carries the marker, so `attributeName` is the
 * only thing left identifying its role).
 */
const LEAF_ATTRIBUTE_SPECS: Record<string, ManagedAttributeSpec> = {
	'data-edytor-text-placeholder': PLACEHOLDER_ATTRIBUTE_SPEC,
	'data-edytor-text-suggestion': SUGGESTION_ATTRIBUTE_SPEC,
	'data-edytor-render-anchor': RENDER_ANCHOR_ATTRIBUTE_SPEC,
	'data-edytor-plugin-chrome': PLUGIN_CHROME_ATTRIBUTE_SPEC
};

/**
 * Identity attributes that foreign DOM must not be able to spoof — a
 * `data-edytor-*` write on an element that resolves to no live wrapper
 * would otherwise hijack document-order lookups (getTextLocators-style
 * queries, selection mapping).
 */
const IDENTITY_ATTRIBUTES = new Set([
	'data-edytor-id',
	'data-edytor-text',
	'data-edytor-block',
	'data-edytor-type',
	'data-edytor-void',
	'data-edytor-inline-block',
	'data-edytor-mark',
	'data-edytor-mark-void',
	'data-edytor-trailing-newline',
	'data-edytor-text-placeholder',
	'data-edytor-text-suggestion',
	'data-edytor-render-anchor',
	'data-edytor-plugin-chrome',
	'data-edytor-selected',
	'data-edytor-focused'
]);

const healOwnedAttribute = (element: HTMLElement, name: string, expected: string | null) => {
	if (expected === null) {
		if (element.hasAttribute(name)) {
			element.removeAttribute(name);
			return true;
		}
		return false;
	}
	if (element.getAttribute(name) !== expected) {
		element.setAttribute(name, expected);
		return true;
	}
	return false;
};

// CSSOM expands shorthand declarations to longhands — `element.style`
// iterates `outline-width/outline-style/outline-color`, never
// `outline`. Strict-strip must keep longhands of an OWNED shorthand or
// every heal re-removes them and the strip→write loop never converges.
const SHORTHAND_LONGHANDS: Record<string, readonly string[]> = {
	outline: ['outline-width', 'outline-style', 'outline-color']
};

const isLonghandOfOwnedStyle = (ownedStyle: Record<string, string | null>, property: string) =>
	Object.keys(ownedStyle).some((shorthand) =>
		(SHORTHAND_LONGHANDS[shorthand] ?? []).includes(property)
	);

const healStyleAttribute = (
	element: HTMLElement,
	ownedStyle: Record<string, string | null>,
	strict: boolean
) => {
	let healed = false;
	if (strict) {
		for (const property of Array.from(element.style)) {
			if (!Object.hasOwn(ownedStyle, property) && !isLonghandOfOwnedStyle(ownedStyle, property)) {
				element.style.removeProperty(property);
				healed = true;
			}
		}
	}
	for (const [property, expected] of Object.entries(ownedStyle)) {
		const current = element.style.getPropertyValue(property);
		if (expected === null) {
			if (current !== '') {
				element.style.removeProperty(property);
				healed = healed || element.style.getPropertyValue(property) === '';
			}
			continue;
		}
		if (current !== expected) {
			// `removeProperty` first — a foreign `!important` declaration
			// makes a plain `setProperty` write a permanent no-op.
			element.style.removeProperty(property);
			element.style.setProperty(property, expected);
			// Verify the write took: an unsupported or renderer-rejected
			// property (e.g. unprefixed `user-select` on older WebKit) leaves
			// the declaration empty — counting that as healed would requeue
			// a caret restore every flush and never converge.
			healed = healed || element.style.getPropertyValue(property) === expected;
		}
	}
	// A leftover empty `style` attribute is itself foreign residue — the
	// renderer never serializes one.
	if (element.hasAttribute('style') && element.style.length === 0) {
		element.removeAttribute('style');
		healed = true;
	}
	return healed;
};

const healManagedElementAttributes = (element: HTMLElement, spec: ManagedAttributeSpec) => {
	let healed = false;
	for (const [name, expected] of Object.entries(spec.owned)) {
		healed = healOwnedAttribute(element, name, expected) || healed;
	}
	healed = healStyleAttribute(element, spec.ownedStyle, spec.strict) || healed;
	if (spec.strict) {
		for (const attribute of Array.from(element.attributes)) {
			// `hasOwn` — `in` walks the prototype chain, so a foreign
			// attribute literally named `constructor`/`toString` would
			// survive the strip (and `LEAF_ATTRIBUTE_SPECS[attributeName]`
			// below would resolve to a function, crashing the flush).
			if (Object.hasOwn(spec.owned, attribute.name) || attribute.name === 'style') {
				continue;
			}
			element.removeAttribute(attribute.name);
			healed = true;
		}
	}
	return healed;
};

type ManagedAttributeTarget =
	| { kind: 'spec'; element: HTMLElement; spec: ManagedAttributeSpec }
	| { kind: 'textSubtree'; text: Text };

const resolveManagedAttributeTarget = (
	edytor: Edytor,
	root: HTMLElement,
	mutation: MutationRecord
): ManagedAttributeTarget | null => {
	const element = mutation.target;
	const attributeName = mutation.attributeName;
	if (!attributeName || !isElement(element) || !(element instanceof HTMLElement)) {
		return null;
	}
	if (element !== root && !root.contains(element)) {
		return null;
	}

	if (element === root) {
		return {
			kind: 'spec',
			element,
			spec: {
				// The root's attribute surface is prop-owned (`class`,
				// `spellcheck`, `aria-*`, …) — only the structural markers are
				// healed.
				strict: false,
				owned: {
					'data-edytor': '',
					contenteditable: edytor.readonly ? 'false' : 'true'
				},
				ownedStyle: {}
			}
		};
	}

	// Live bindings survive attribute removal — resolve identity before
	// reading attributes so a stripped `data-edytor-id`/`data-edytor-text`
	// still maps back to its wrapper.
	const boundText = edytor.nodeToText.get(element);
	if (boundText?.node === element && boundText.isInDocument) {
		return { kind: 'spec', element, spec: textMutationAttributeSpec(boundText) };
	}
	const boundInlineBlock = edytor.nodeToInlineBlock.get(element);
	if (boundInlineBlock?.isInDocument) {
		return {
			kind: 'spec',
			element,
			spec: inlineBlockMutationAttributeSpec(boundInlineBlock)
		};
	}

	// `attributeOldValue` recovers the binding when the foreign write
	// removed or overwrote `data-edytor-id` itself (there is no node→Block
	// map, and the live attribute may hold a spoofed id).
	const idCandidates = [element.getAttribute('data-edytor-id')];
	if (attributeName === 'data-edytor-id' && mutation.oldValue !== null) {
		idCandidates.push(mutation.oldValue);
	}
	for (const id of idCandidates) {
		if (!id) {
			continue;
		}
		const block = edytor.idToBlock.get(id);
		if (block?.node === element && block.isInTree) {
			return { kind: 'spec', element, spec: blockMutationAttributeSpec(edytor, block) };
		}
		const text = edytor.idToText.get(id);
		if (text?.node === element && text.isInDocument) {
			return { kind: 'spec', element, spec: textMutationAttributeSpec(text) };
		}
	}

	// An attribute write on a managed descendant of a live text element —
	// mark/mark-void wrappers, the trailing-newline marker — heals by
	// refreshing the whole projection. Plain foreign elements (spellcheck
	// spans, GBoard wrappers) are deliberately NOT refreshed here: their
	// fate is the childList settle path's adopt/revert decision, and
	// reverting early could discard browser-owned input mid-flight.
	// Spoofed identity attributes still get stripped by the caller.
	const ownerText = getLiveManagedTextFromDescendant(edytor, element);
	if (ownerText?.node && ownerText.node !== element) {
		const carriesManagedMarker =
			element.matches(MANAGED_SELECTOR) ||
			containsManagedNode(element) ||
			IDENTITY_ATTRIBUTES.has(attributeName);
		if (carriesManagedMarker) {
			return { kind: 'textSubtree', text: ownerText };
		}
		return null;
	}

	// Marker elements outside a text subtree (placeholder, suggestion,
	// render anchor, plugin chrome).
	for (const [marker, spec] of Object.entries(LEAF_ATTRIBUTE_SPECS)) {
		if (element.hasAttribute(marker)) {
			return { kind: 'spec', element, spec };
		}
	}
	// Marker-removal records: the element lost its identifying attribute,
	// so `attributeName` + `oldValue` are the only evidence of its role.
	// `oldValue !== null` proves the marker was renderer-written (a foreign
	// element that never had the marker produces oldValue null).
	if (mutation.oldValue !== null && Object.hasOwn(LEAF_ATTRIBUTE_SPECS, attributeName)) {
		return { kind: 'spec', element, spec: LEAF_ATTRIBUTE_SPECS[attributeName] };
	}

	return null;
};

const stripSpoofedIdentityAttribute = (root: HTMLElement, mutation: MutationRecord) => {
	const element = mutation.target;
	const name = mutation.attributeName;
	if (!name || !IDENTITY_ATTRIBUTES.has(name)) {
		return false;
	}
	if (!isElement(element) || !(element instanceof HTMLElement) || !root.contains(element)) {
		return false;
	}
	if (!element.hasAttribute(name)) {
		return false;
	}
	element.removeAttribute(name);
	return true;
};

const healForeignAttributeMutations = (
	edytor: Edytor,
	root: HTMLElement,
	mutations: MutationRecord[],
	refreshedTexts: Set<Text>
) => {
	let healed = false;
	const healedElements = new Set<HTMLElement>();

	for (const mutation of mutations) {
		if (mutation.type !== 'attributes') {
			continue;
		}
		const target = resolveManagedAttributeTarget(edytor, root, mutation);
		if (!target) {
			healed = stripSpoofedIdentityAttribute(root, mutation) || healed;
			continue;
		}
		if (target.kind === 'textSubtree') {
			if (refreshManagedSubtreeMutationFromModel(target.text, { refreshUnchanged: true })) {
				refreshedTexts.add(target.text);
				healed = true;
			}
			continue;
		}
		if (healedElements.has(target.element)) {
			continue;
		}
		healedElements.add(target.element);
		healed = healManagedElementAttributes(target.element, target.spec) || healed;
	}

	return healed;
};

/**
 * Adopt what the browser made of `text` (R8, O59) — the only adopter: one
 * user command through the dispatcher (hooks, undo policy, marks for
 * insertion), placed by the prefix/suffix diff that prefers the owning
 * attempt's target. A browser-owned attempt expecting this host owns the
 * change: its anchored target is the command's selection (history's
 * `before`) and the diff's preference, and its expected text wins over a
 * model-owned attempt's drift on the host. A vetoed or replaced change
 * re-renders the text from the model. The caret lands where the browser put
 * it (`domCaret`), else, for an attempt, where the change ends.
 */
const adopt = async (edytor: Edytor, text: Text, dom: string, domCaret?: number) => {
	if (!text.isInDocument) return false;
	const attempt = edytor.attempts.on(text);
	const after = attempt?.expect?.kind === 'change' ? attempt.expect.after : null;
	const drifted = after !== null && dom !== after && edytor.attempts.drifting(text);
	const value = drifted ? after : dom;
	const caret = drifted ? undefined : domCaret;
	if (attempt) edytor.selection.select(attempt.target);
	const { startText, yStart } = edytor.selection.state;
	const grow = value.length - text.length;
	const back = attempt?.isCollapsed && INTENTS[attempt.inputType]?.dir === 'back';
	const prefer = attempt && startText === text ? yStart + (back ? grow : Math.max(0, grow)) : caret;
	const change = diffText(text.stringContent, value, prefer);
	if (!change) {
		scheduleRemoveStalePlaceholders(text);
		return false;
	}
	const { at, remove, insert } = change;
	// The command runs at the change (a hook reads the selection).
	if (startText !== text && (attempt || caret !== undefined))
		edytor.selection.select(edytor.selection.textValue(text, at));
	// A deletion of uniformly marked text keeps its marks pending.
	const removed = insert ? [] : text.getMarksAtRange(at, at + remove);
	const marks = activeMarks(removed[0]?.marks);
	const same = removed.every((part) => jsonValuesEqual(activeMarks(part.marks), marks));
	edytor.dispatcher.run(attempt?.inputType || (insert ? 'insertText' : 'deleteContent'), () =>
		insert
			? text.insertText({ value: insert, start: at, end: at + remove })
			: text.parent.deleteContentAtRange({
					start: [text.index, at],
					end: [text.index, at + remove]
				})
	);
	const adopted = text.isInDocument && text.stringContent === value;
	if (attempt) attempt.phase = adopted ? 'applied' : 'failed';
	if (!text.isInDocument) return true;
	if (adopted && same && Object.keys(marks).length > 0) text.markOnNextInsert = marks;
	if (adopted && !drifted) text.syncFromModel();
	else {
		text.refreshFromModel();
		removeUnmanagedLineBreaks(text);
	}
	await tick();
	scheduleRemoveStalePlaceholders(text);
	const end = caret ?? (attempt ? at + insert.length : undefined);
	if (adopted && end !== undefined)
		await edytor.selection.setAtTextOffset(text, Math.min(end, text.length));
	return true;
};

export const observeDomTextMutations = (edytor: Edytor, root: HTMLElement) => {
	if (typeof MutationObserver === 'undefined') {
		return { destroy: () => {}, flushNow: async () => {}, pending: () => false };
	}

	const queuedTexts = new Set<Text>();
	const queuedMutations: MutationRecord[] = [];
	let isFlushScheduled = false;
	let compositionMutationTimer: ReturnType<typeof setTimeout> | null = null;
	let suppressedMutationRetryTimer: ReturnType<typeof setTimeout> | null = null;
	let shouldRestoreCompositionMutationSelection = false;
	let observer: MutationObserver;
	// Bounded repair (cf. Quill's MAX_OPTIMIZE_ITERATIONS): a foreign writer
	// that re-mutates on every repair batch — or a bug where our own heals
	// fight the renderer — would otherwise trade microtasks forever. After
	// MAX cycles inside one window the queued damage is resynced once from
	// the model and further records are dropped until the window resets.
	let mutationRepairCycleCount = 0;
	let mutationRepairWindowTimer: ReturnType<typeof setTimeout> | null = null;
	let mutationRepairSuppressed = false;
	let mutationRepairSuppressedTimer: ReturnType<typeof setTimeout> | null = null;

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

		text.deleteAt(state.startOffset, deleteLength);
		text.refreshFromModel();
		await edytor.selection.setAtTextOffset(text, state.startOffset);
		return true;
	};

	const observe = () => {
		observer.observe(root, {
			// `attributes` + `attributeOldValue` cover foreign writes/removals of
			// managed attributes (Grammarly-class overlays, spellcheck chrome).
			// `characterDataOldValue` distinguishes mobile type-over records
			// (nodeValue === oldValue) from real character-data changes.
			attributes: true,
			attributeOldValue: true,
			characterData: true,
			characterDataOldValue: true,
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

	const noteMutationRepairCycle = () => {
		mutationRepairCycleCount += 1;
		if (mutationRepairWindowTimer) {
			clearTimeout(mutationRepairWindowTimer);
		}
		mutationRepairWindowTimer = setTimeout(() => {
			mutationRepairWindowTimer = null;
			mutationRepairCycleCount = 0;
		}, MUTATION_REPAIR_WINDOW_MS);
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

		if (mutationRepairSuppressed) {
			// The bound already tripped inside this window — drop the
			// mutation RECORDS (replaying them restarts the loop the bound
			// exists to break) but keep the affected TEXTS queued: user
			// input landing in the window must not be silently lost — it
			// is reconciled once the window expires.
			for (const text of texts) {
				queuedTexts.add(text);
			}
			return;
		}

		// Records inside a model-owned attempt's drift deadline (or a model
		// write's render) are the model's: deferred, or discarded when the
		// attempt owns the structure too.
		const observed = edytor.attempts.observed;
		if (observed) {
			if (observed === 'discard') {
				// Model-owned native input repairs must discard stale browser mutations.
				const addedManagedRoots = getAddedManagedRoots(edytor, mutations);
				observer.disconnect();
				try {
					removeAddedUnmanagedNodes(edytor, root, mutations, addedManagedRoots);
					restoreRemovedManagedNodes(edytor, root, mutations);
					edytor.placeholderRepair.add(root);
				} finally {
					observe();
				}
				// The repair put back nodes the browser's drift moved the DOM
				// selection out of: the projector displays the current value.
				edytor.selection.display();
				return;
			}

			// A browser-owned attempt's host is its own: adopted now (the
			// drift around it is re-rendered from the model).
			for (const text of texts) {
				if (edytor.attempts.on(text)) await adopt(edytor, text, getNormalizedDomText(text));
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
			// Mutation records are replay-safe and must not be dropped:
			// attribute damage (a Grammarly class on a mark span, a stripped
			// `contenteditable`) does not self-heal via text reconcile —
			// requeueing it is the only way it gets healed post-commit.
			queuedMutations.unshift(...mutations);
			scheduleCompositionMutationFlush();
			return;
		}

		// Only flushes that actually REPAIR count toward the bound —
		// model-driven churn (remote reconcile renders under collab) queues
		// records but needs no repair; counting raw flushes would mis-fire
		// the bound on benign traffic. The counter is incremented at the
		// end of this flush when repair work actually ran.
		if (mutationRepairCycleCount > MAX_MUTATION_REPAIR_CYCLES) {
			mutationRepairSuppressed = true;
			console.error(
				`[edytor] mutation repair exceeded ${MAX_MUTATION_REPAIR_CYCLES} cycles inside ${MUTATION_REPAIR_WINDOW_MS}ms — forcing a subtree resync and dropping foreign mutations briefly`,
				{ texts: texts.length, mutations: mutations.length }
			);
			// One bounded, synchronous model→DOM resync for everything queued:
			// text subtrees refresh from the model, attribute damage heals
			// once, removed managed nodes are restored, unmanaged additions
			// are dropped. Re-observe only after the render tick so the
			// resync's own churn cannot requeue.
			const selectionBeforeRepair = captureSelectionBeforeRepair(edytor);
			observer.disconnect();
			const refreshedTexts = new Set<Text>();
			try {
				for (const text of texts) {
					if (refreshManagedSubtreeMutationFromModel(text, { refreshUnchanged: true })) {
						refreshedTexts.add(text);
					}
				}
				healForeignAttributeMutations(edytor, root, mutations, refreshedTexts);
				restoreRemovedManagedNodes(edytor, root, mutations);
				removeAddedUnmanagedNodes(edytor, root, mutations, getAddedManagedRoots(edytor, mutations));
				edytor.placeholderRepair.add(root);
				if (refreshedTexts.size > 0) {
					await tick();
				}
			} finally {
				observe();
			}
			await restoreSelectionAfterRepair(edytor, selectionBeforeRepair);
			scheduleDeferredSelectionRestore(edytor, root);
			if (mutationRepairSuppressedTimer) {
				clearTimeout(mutationRepairSuppressedTimer);
			}
			mutationRepairSuppressedTimer = setTimeout(() => {
				mutationRepairSuppressedTimer = null;
				mutationRepairSuppressed = false;
				// Drain texts queued while suppressed — the window keeps
				// repairs rate-limited, it does not discard user input.
				if (queuedTexts.size > 0 || queuedMutations.length > 0) {
					queueFlush();
				}
			}, MUTATION_REPAIR_WINDOW_MS);
			return;
		}

		const textReplacements = getTextReplacements(edytor, mutations);
		const replacedTexts = new Set(textReplacements.map((replacement) => replacement.text));
		const changedTexts = new Set<Text>();
		const shouldRestoreCompositionSelection = shouldRestoreCompositionMutationSelection;
		shouldRestoreCompositionMutationSelection = false;
		const addedManagedRoots = getAddedManagedRoots(edytor, mutations);
		const refreshedTexts = new Set<Text>();
		let removedUnmanagedNode: boolean;
		let restoredManagedNode: boolean;
		let settledTextWrapper: boolean;
		let normalizedConvertedSpace: boolean;
		let healedAttribute: boolean;
		let selectionBeforeRepair = captureSelectionBeforeRepair(edytor);
		const claimed = texts.filter((text) => edytor.attempts.on(text) && !replacedTexts.has(text));
		const domCaret = getCollapsedDomTextSelection(edytor);

		observer.disconnect();
		try {
			// A browser-owned attempt's host: its change is adopted first,
			// whatever the browser did to the structure (repaired below).
			for (const text of claimed) {
				const caret = domCaret?.text === text ? domCaret.offset : undefined;
				if (await adopt(edytor, text, getNormalizedDomText(text), caret)) changedTexts.add(text);
			}
			for (const replacement of textReplacements) {
				if (await handleNativeLineBreakTextValue(edytor, replacement.text, replacement.value)) {
					changedTexts.add(replacement.text);
					continue;
				}

				if (await adopt(edytor, replacement.text, replacement.value)) {
					changedTexts.add(replacement.text);
				}
			}
			normalizedConvertedSpace = normalizeConvertedSpaceNodes(root, mutations);
			removedUnmanagedNode = removeAddedUnmanagedNodes(edytor, root, mutations, addedManagedRoots);
			restoredManagedNode = restoreRemovedManagedNodes(edytor, root, mutations);
			// Attribute damage heals next — a `textSubtree` heal refreshes the
			// owning text, so it runs before the per-text loop can re-add it.
			healedAttribute = healForeignAttributeMutations(edytor, root, mutations, refreshedTexts);

			const selection = getCollapsedDomTextSelection(edytor);
			for (const text of texts) {
				if (replacedTexts.has(text) || refreshedTexts.has(text)) {
					continue;
				}

				if (hasManagedSubtreeMutation(edytor, root, text, mutations)) {
					refreshManagedSubtreeMutationFromModel(text, { refreshUnchanged: true });
					refreshedTexts.add(text);
					continue;
				}

				if (
					hasTextNodeBoundaryMutation(edytor, root, text, mutations) &&
					getNormalizedDomText(text) === text.stringContent
				) {
					refreshManagedSubtreeMutationFromModel(text, { refreshUnchanged: true });
					refreshedTexts.add(text);
					continue;
				}

				if (claimed.includes(text)) continue;
				if (await handleNativeLineBreakTextMutation(edytor, text)) {
					changedTexts.add(text);
					continue;
				}

				const caret = selection?.text === text ? selection.offset : undefined;
				if (await adopt(edytor, text, getNormalizedDomText(text), caret)) {
					changedTexts.add(text);
				}
			}

			for (const replacement of textReplacements) {
				if (typeof replacement.selectionOffset === 'number') {
					await edytor.selection.setAtTextOffset(replacement.text, replacement.selectionOffset);
				}
			}
			// An adoption placed the caret: the repair restores that one.
			if (changedTexts.size > 0) selectionBeforeRepair = captureSelectionBeforeRepair(edytor);

			for (const text of [...texts, ...replacedTexts]) {
				scheduleRemoveStalePlaceholders(text);
			}

			if (shouldRestoreCompositionSelection) {
				const text = changedTexts.values().next().value;
				if (text) {
					await edytor.selection.setAtTextOffset(text, text.length);
				}
			}

			// The root sweep is a mutation-driven safety net, not per-flush
			// work: queue it so bursts of flushes share one bounded repair
			// window instead of paying a full scan per flush.
			edytor.placeholderRepair.add(root);

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
			changedTexts.size > 0 ||
			refreshedTexts.size > 0 ||
			removedUnmanagedNode ||
			restoredManagedNode ||
			settledTextWrapper ||
			normalizedConvertedSpace ||
			healedAttribute
		) {
			noteMutationRepairCycle();
		}

		if (
			removedUnmanagedNode ||
			restoredManagedNode ||
			settledTextWrapper ||
			normalizedConvertedSpace ||
			healedAttribute ||
			refreshedTexts.size > 0
		) {
			await restoreSelectionAfterRepair(edytor, selectionBeforeRepair);
			scheduleDeferredSelectionRestore(edytor, root);
		}
	};

	const queueFlush = () => {
		if (isFlushScheduled) {
			return;
		}

		isFlushScheduled = true;
		queueMicrotask(() => {
			// The records signal (O55): a display waiting for a destination the
			// repair restores gets its pass once the repair ran.
			void flush().finally(edytor.projector.recordsChanged);
		});
	};

	const enqueue = (mutation: MutationRecord) => {
		if (
			mutation.type !== 'characterData' &&
			mutation.type !== 'childList' &&
			mutation.type !== 'attributes'
		) {
			return;
		}

		queuedMutations.push(mutation);
		// Identical-value `characterData` records (nodeValue === oldValue,
		// distinguishable thanks to `characterDataOldValue`) are mobile
		// type-overs — the browser rewrote the node. They stay queued like
		// any other record so the owning text runs through reconciliation.
		const text = findMutatedText(edytor, root, mutation.target);
		if (text) {
			queuedTexts.add(text);
		}
	};

	observer = new MutationObserver((mutations) => {
		mutations.forEach(enqueue);

		if (queuedTexts.size > 0 || queuedMutations.length > 0) {
			queueFlush();
		}
	});

	observe();

	return {
		destroy: () => {
			if (compositionMutationTimer) {
				clearTimeout(compositionMutationTimer);
			}
			if (suppressedMutationRetryTimer) {
				clearTimeout(suppressedMutationRetryTimer);
			}
			if (mutationRepairWindowTimer) {
				clearTimeout(mutationRepairWindowTimer);
			}
			if (mutationRepairSuppressedTimer) {
				clearTimeout(mutationRepairSuppressedTimer);
			}
			observer.disconnect();
		},
		// Process the pending mutation queue immediately — used by the
		// `contextmenu` handler so spellcheck suggestions are computed
		// against a settled DOM (PM `domchange.ts` flushes for the same
		// reason). Deferred states (composition, suppressed fallback)
		// still requeue inside `flush` — this only skips the microtask.
		flushNow: () => {
			for (const mutation of observer.takeRecords()) enqueue(mutation);
			return flush().finally(edytor.projector.recordsChanged);
		},
		/** DOM records not yet reconciled: the DOM differs from what the cells rendered. */
		pending: () => queuedMutations.length > 0 || queuedTexts.size > 0
	};
};
