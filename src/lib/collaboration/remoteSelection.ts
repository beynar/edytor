import type { Edytor } from '$lib/edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { TextAnchor } from '$lib/selection/selection.svelte.js';
import {
	freshestPublishedSelection,
	type EdytorAwarenessSelection,
	type EdytorAwarenessUser
} from './awarenessSelection.js';

export type RemoteSelectionRect = {
	left: number;
	top: number;
	width: number;
	height: number;
};

export type RenderedRemoteSelection = {
	clientId: number;
	color: string;
	label: string | null;
	cursor: RemoteSelectionRect;
	rects: RemoteSelectionRect[];
};

type DomPoint = {
	node: Node;
	offset: number;
	text: Text;
};

const DEFAULT_REMOTE_COLOR = '#2563eb';

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

const normalizeColor = (value: unknown) =>
	typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value.trim())
		? value.trim()
		: DEFAULT_REMOTE_COLOR;

const getUser = (state: unknown): EdytorAwarenessUser => {
	if (!isRecord(state) || !isRecord(state.user)) {
		return {};
	}
	return {
		name: typeof state.user.name === 'string' ? state.user.name : undefined,
		color: typeof state.user.color === 'string' ? state.user.color : undefined
	};
};

/** Per-view presence: one caret per remote client, its freshest text entry (D-16: no legacy field). */
const getSelection = (state: unknown): EdytorAwarenessSelection | null =>
	isRecord(state) && isRecord(state.selections)
		? freshestPublishedSelection(state.selections)
		: null;

/**
 * Strict wire-shape guard for serialized selection anchors (U09): `{b}`
 * is the backing text's home block id and `a` is the engine anchor
 * `{i: {c,k}|null, a: number}` (a < 0 = left affinity). Foreign presence
 * payloads — e.g. v13 `RelativePosition` objects shaped
 * `{type, item, assoc}` — fail this check, so mismatched formats are
 * safely ignored rather than interpreted with wrong offsets.
 */
const isEngineAnchor = (value: unknown): value is TextAnchor['a'] =>
	isRecord(value) &&
	typeof value.a === 'number' &&
	(value.i === null ||
		(isRecord(value.i) && typeof value.i.c === 'number' && typeof value.i.k === 'number'));

const isTextAnchor = (value: unknown): value is TextAnchor =>
	isRecord(value) &&
	typeof value.b === 'string' &&
	isEngineAnchor(value.a) &&
	(value.o === undefined || typeof value.o === 'string');

const resolveRelativePosition = (
	edytor: Edytor,
	value: unknown
): { text: Text; offset: number } | null => {
	try {
		if (!isTextAnchor(value)) {
			return null;
		}
		const resolved = edytor.selection.resolveTextAnchor(value);
		if (!resolved) {
			return null;
		}
		return {
			text: resolved.text,
			offset: Math.min(Math.max(resolved.offset, 0), resolved.text.length)
		};
	} catch {
		return null;
	}
};

const findDomPoint = ({ text, offset }: { text: Text; offset: number }): DomPoint | null => {
	const node = text.node;
	if (!node) {
		return null;
	}

	const treeWalker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
	let currentNode = treeWalker.nextNode();
	let currentOffset = 0;

	while (currentNode) {
		const length = currentNode.textContent?.length ?? 0;
		const endOffset = currentOffset + length;
		if (offset >= currentOffset && offset <= endOffset) {
			return {
				node: currentNode,
				offset: offset - currentOffset,
				text
			};
		}
		currentOffset = endOffset;
		currentNode = treeWalker.nextNode();
	}

	return {
		node,
		offset: Math.min(offset, node.childNodes.length),
		text
	};
};

const toRemoteRect = (
	rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
	_editorRect: DOMRect,
	_editor: HTMLElement
): RemoteSelectionRect => ({
	left: rect.left,
	top: rect.top,
	width: Math.max(rect.width, 2),
	height: Math.max(rect.height, 16)
});

const getFallbackRect = (point: DomPoint, editorRect: DOMRect, editor: HTMLElement) => {
	const textRect = point.text.node?.getBoundingClientRect();
	return toRemoteRect(
		textRect && (textRect.width || textRect.height)
			? textRect
			: {
					left: editorRect.left,
					top: editorRect.top,
					width: 2,
					height: 16
				},
		editorRect,
		editor
	);
};

const getCaretRect = (point: DomPoint, editorRect: DOMRect, editor: HTMLElement) => {
	const range = (point.node.ownerDocument ?? editor.ownerDocument).createRange();
	range.setStart(point.node, point.offset);
	range.collapse(true);
	const rect =
		typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
	if (rect && (rect.width || rect.height)) {
		return toRemoteRect(rect, editorRect, editor);
	}
	return getFallbackRect(point, editorRect, editor);
};

const createRange = (start: DomPoint, end: DomPoint, editor: HTMLElement) => {
	const ownerDocument = start.node.ownerDocument ?? editor.ownerDocument;
	const range = ownerDocument.createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset);
	if (!range.collapsed || (start.node === end.node && start.offset === end.offset)) {
		return range;
	}

	const reversedRange = ownerDocument.createRange();
	reversedRange.setStart(end.node, end.offset);
	reversedRange.setEnd(start.node, start.offset);
	return reversedRange;
};

const getSelectionRects = (
	start: DomPoint,
	end: DomPoint,
	editorRect: DOMRect,
	editor: HTMLElement
) => {
	const range = createRange(start, end, editor);
	if (range.collapsed) {
		return [];
	}

	const clientRects =
		typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
	const seen = new Set<string>();
	const rects = clientRects
		.filter((rect) => rect.width || rect.height)
		.map((rect) => toRemoteRect(rect, editorRect, editor))
		.filter((rect) => {
			const key = `${rect.left}:${rect.top}:${rect.width}:${rect.height}`;
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});

	return rects.length ? rects : [getFallbackRect(start, editorRect, editor)];
};

export const getRenderedRemoteSelections = (edytor: Edytor): RenderedRemoteSelection[] => {
	const editor = edytor.node;
	if (!editor) {
		return [];
	}

	// U8a — phase split: resolve/validate every remote selection first,
	// touch layout APIs only when at least one candidate survives.
	// `editor.getBoundingClientRect()` used to run unconditionally at the
	// top — a synchronous layout read on EVERY awareness/doc invalidation
	// even with zero remote peers (the common solo-editing case).
	type ResolvedCandidate = {
		clientId: number;
		selection: EdytorAwarenessSelection;
		startPoint: DomPoint;
		endPoint: DomPoint;
		user: EdytorAwarenessUser;
	};
	const candidates: ResolvedCandidate[] = [];

	for (const [clientId, state] of edytor.awareness.getStates()) {
		if (clientId === edytor.doc.clientID) {
			continue;
		}

		const selection = getSelection(state);
		if (!selection) {
			continue;
		}

		const startPosition = resolveRelativePosition(edytor, selection.start);
		const endPosition = resolveRelativePosition(edytor, selection.end);
		if (!startPosition || !endPosition) {
			continue;
		}

		const startPoint = findDomPoint(startPosition);
		const endPoint = findDomPoint(endPosition);
		if (!startPoint || !endPoint) {
			continue;
		}

		candidates.push({
			clientId,
			selection,
			startPoint,
			endPoint,
			user: getUser(state)
		});
	}

	if (candidates.length === 0) {
		return [];
	}

	const editorRect = editor.getBoundingClientRect();
	return candidates.map(({ clientId, selection, startPoint, endPoint, user }) => {
		const cursorPoint = selection.reversed ? startPoint : endPoint;
		return {
			clientId,
			color: normalizeColor(user.color),
			label: user.name ?? null,
			cursor: getCaretRect(cursorPoint, editorRect, editor),
			rects: selection.collapsed ? [] : getSelectionRects(startPoint, endPoint, editorRect, editor)
		};
	});
};
