const hasSelectionApi = (root: Node): root is Node & { getSelection: () => Selection | null } =>
	typeof (root as Node & { getSelection?: unknown }).getSelection === 'function';

const isShadowRoot = (root: Node | undefined): root is ShadowRoot =>
	typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot;

const getOwnerDocument = (node?: Node | null): Document | null =>
	node?.ownerDocument ?? (typeof document === 'undefined' ? null : document);

export type DomSelectionSnapshot = Pick<
	Selection,
	| 'anchorNode'
	| 'anchorOffset'
	| 'direction'
	| 'focusNode'
	| 'focusOffset'
	| 'isCollapsed'
	| 'rangeCount'
	| 'toString'
> & {
	getRangeAt: (index: number) => Range;
	nativeSelection: Selection | null;
	type?: string;
};

const getDocumentSelection = (node?: Node | null) => {
	const ownerDocument = getOwnerDocument(node);
	return ownerDocument?.defaultView?.getSelection?.() ?? ownerDocument?.getSelection?.() ?? null;
};

export const getDomSelection = (node?: Node | null): Selection | null => {
	const root = node?.getRootNode();
	if (isShadowRoot(root) && hasSelectionApi(root)) {
		const selection = root.getSelection();
		if (selection) {
			return selection;
		}
	}

	return getDocumentSelection(node);
};

export const getActiveElement = (node?: Node | null): Element | null => {
	const root = node?.getRootNode();
	if (isShadowRoot(root)) {
		return root.activeElement ?? getOwnerDocument(node)?.activeElement ?? null;
	}

	return getOwnerDocument(node)?.activeElement ?? null;
};

export const clearDomSelection = (node?: Node | null) => {
	getDomSelection(node)?.removeAllRanges();
};

export const createDomRange = (node: Node): Range => {
	const ownerDocument = getOwnerDocument(node);
	if (!ownerDocument) {
		throw new Error('Cannot create a DOM range without an owner document');
	}
	return ownerDocument.createRange();
};

const isSelectionCollapsed = (selection: Selection) =>
	selection.anchorNode === selection.focusNode && selection.anchorOffset === selection.focusOffset;

const createDomSelectionSnapshot = (selection: Selection): DomSelectionSnapshot => ({
	anchorNode: selection.anchorNode,
	anchorOffset: selection.anchorOffset,
	direction: selection.direction,
	focusNode: selection.focusNode,
	focusOffset: selection.focusOffset,
	isCollapsed: isSelectionCollapsed(selection),
	rangeCount: selection.rangeCount,
	getRangeAt: (index) => selection.getRangeAt(index),
	nativeSelection: selection,
	toString: () => selection.toString(),
	type: (selection as Selection & { type?: string }).type
});

export const createDomSelectionSnapshotFromRange = (
	range: Range,
	nativeSelection: Selection | null = null
): DomSelectionSnapshot => ({
	anchorNode: range.startContainer,
	anchorOffset: range.startOffset,
	direction: 'forward',
	focusNode: range.endContainer,
	focusOffset: range.endOffset,
	isCollapsed: range.collapsed,
	rangeCount: 1,
	getRangeAt: (index) => {
		if (index !== 0) {
			throw new Error(`Selection range ${index} is unavailable`);
		}
		return range;
	},
	nativeSelection,
	toString: () => range.toString(),
	type: range.collapsed ? 'Caret' : 'Range'
});

const createRangeFromStaticRange = (staticRange: StaticRange) => {
	const range = createDomRange(staticRange.startContainer);
	range.setStart(staticRange.startContainer, staticRange.startOffset);
	range.setEnd(staticRange.endContainer, staticRange.endOffset);
	return range;
};

export const createDomSelectionSnapshotFromStaticRange = (
	staticRange: StaticRange,
	nativeSelection: Selection | null = null
) => createDomSelectionSnapshotFromRange(createRangeFromStaticRange(staticRange), nativeSelection);

const isNodeInside = (root: Node, target: Node) => root === target || root.contains(target);

const getContainedRanges = (selection: Selection, container?: Node | null) => {
	const ranges: Range[] = [];
	for (let index = 0; index < selection.rangeCount; index++) {
		const range = selection.getRangeAt(index);
		if (
			!container ||
			(isNodeInside(container, range.startContainer) && isNodeInside(container, range.endContainer))
		) {
			ranges.push(range);
		}
	}
	return ranges;
};

const createDomSelectionSnapshotFromMultiRange = (
	selection: Selection,
	container?: Node | null
): DomSelectionSnapshot | null => {
	if (selection.rangeCount <= 1) {
		return null;
	}

	const ranges = getContainedRanges(selection, container);
	if (ranges.length === 0) {
		return null;
	}

	if (ranges.length === 1) {
		return createDomSelectionSnapshotFromRange(ranges[0], selection);
	}

	let firstRange = ranges[0];
	let lastRange = ranges[0];
	for (const range of ranges.slice(1)) {
		if (range.compareBoundaryPoints(Range.START_TO_START, firstRange) < 0) {
			firstRange = range;
		}
		if (range.compareBoundaryPoints(Range.END_TO_END, lastRange) > 0) {
			lastRange = range;
		}
	}

	const combinedRange = createDomRange(firstRange.startContainer);
	combinedRange.setStart(firstRange.startContainer, firstRange.startOffset);
	combinedRange.setEnd(lastRange.endContainer, lastRange.endOffset);
	selection.removeAllRanges();
	selection.addRange(combinedRange);
	return createDomSelectionSnapshotFromRange(combinedRange, selection);
};

const getComposedRangeSnapshot = (
	root: ShadowRoot,
	selection: Selection | null
): DomSelectionSnapshot | null => {
	if (typeof selection?.getComposedRanges !== 'function') {
		return null;
	}

	const [staticRange] = selection.getComposedRanges({ shadowRoots: [root] });
	if (
		!staticRange ||
		!root.contains(staticRange.startContainer) ||
		!root.contains(staticRange.endContainer)
	) {
		return null;
	}

	const range = createRangeFromStaticRange(staticRange);
	return createDomSelectionSnapshotFromRange(range, selection);
};

export const getDomSelectionSnapshot = (node?: Node | null): DomSelectionSnapshot | null => {
	const root = node?.getRootNode();
	const documentSelection = getDocumentSelection(node);

	if (isShadowRoot(root)) {
		if (hasSelectionApi(root)) {
			const shadowSelection = root.getSelection();
			if (shadowSelection?.anchorNode) {
				return (
					createDomSelectionSnapshotFromMultiRange(shadowSelection, node) ??
					createDomSelectionSnapshot(shadowSelection)
				);
			}
		}

		const composedSnapshot = getComposedRangeSnapshot(root, documentSelection);
		if (composedSnapshot) {
			return composedSnapshot;
		}
	}

	return documentSelection
		? (createDomSelectionSnapshotFromMultiRange(documentSelection, node) ??
				createDomSelectionSnapshot(documentSelection))
		: null;
};
