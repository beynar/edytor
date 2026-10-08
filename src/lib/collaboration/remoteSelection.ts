import type { Edytor } from '$lib/edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import {
	resolvePeerSelection,
	type EdytorAwarenessUser,
	type PresencePoint
} from './awarenessSelection.js';
import { domPointOf } from '$lib/surface/projector.svelte.js';
import { renderSkipped, rendered } from '$lib/surface/overlay.js';
import { isRecord } from '$lib/utils/json.js';

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
	/** A block presence: `cursor` is a bar beside the blocks, not a caret. */
	block?: true;
};

type DomPoint = {
	node: Node;
	offset: number;
	text: Text;
};

const DEFAULT_REMOTE_COLOR = '#2563eb';

const normalizeColor = (value: unknown) =>
	typeof value === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim())
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

const findDomPoint = ({ text, offset }: PresencePoint): DomPoint | null => {
	if (!text.node) return null;
	const [node, at] = domPointOf(text.node, offset);
	return { node, offset: at, text };
};

/** A viewport rect made relative to the overlay layer's origin (the caret follows its anchor). */
const toRemoteRect = (
	rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
	origin: DOMRect
): RemoteSelectionRect => ({
	left: rect.left - origin.left,
	top: rect.top - origin.top,
	width: Math.max(rect.width, 2),
	height: Math.max(rect.height, 16)
});

const getFallbackRect = (point: DomPoint, origin: DOMRect, editor: HTMLElement) => {
	// A text the browser skips rendering (content-visibility): its nearest rendered ancestor.
	const textRect = point.text.node && rendered(point.text.node).getBoundingClientRect();
	const editorRect = editor.getBoundingClientRect();
	return toRemoteRect(
		textRect && (textRect.width || textRect.height)
			? textRect
			: { left: editorRect.left, top: editorRect.top, width: 2, height: 16 },
		origin
	);
};

const getCaretRect = (point: DomPoint, origin: DOMRect, editor: HTMLElement) => {
	if (point.text.node && renderSkipped(point.text.node))
		return getFallbackRect(point, origin, editor);
	const range = (point.node.ownerDocument ?? editor.ownerDocument).createRange();
	range.setStart(point.node, point.offset);
	range.collapse(true);
	const rect =
		typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
	if (rect && (rect.width || rect.height)) {
		return toRemoteRect(rect, origin);
	}
	return getFallbackRect(point, origin, editor);
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
	origin: DOMRect,
	editor: HTMLElement
) => {
	const range = createRange(start, end, editor);
	if (range.collapsed) {
		return [];
	}
	// Skipped by the browser (content-visibility): its nearest rendered ancestor stands for it.
	if (
		(start.text.node && renderSkipped(start.text.node)) ||
		(end.text.node && renderSkipped(end.text.node))
	) {
		return [getFallbackRect(start, origin, editor)];
	}

	const clientRects =
		typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
	const seen = new Set<string>();
	const rects = clientRects
		.filter((rect) => rect.width || rect.height)
		.map((rect) => toRemoteRect(rect, origin))
		.filter((rect) => {
			const key = `${rect.left}:${rect.top}:${rect.width}:${rect.height}`;
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});

	return rects.length ? rects : [getFallbackRect(start, origin, editor)];
};

/** The rects of the text between two points, relative to the overlay's `origin` (none when not mounted). */
export const rangeRects = (
	edytor: Edytor,
	start: PresencePoint,
	end: PresencePoint,
	origin: DOMRect
): RemoteSelectionRect[] => {
	const [from, to] = [findDomPoint(start), findDomPoint(end)];
	return from && to && edytor.node ? getSelectionRects(from, to, origin, edytor.node) : [];
};

/** A bar beside `ids`' own rows (a block's children excluded), relative to `origin`. */
const blockBar = (edytor: Edytor, ids: string[], origin: DOMRect): RemoteSelectionRect | null => {
	let [top, bottom, left] = [Infinity, -Infinity, Infinity];
	for (const id of ids) {
		const node = edytor.idToBlock.get(id)?.node;
		if (!node) continue;
		const rect = node.getBoundingClientRect();
		const children = node.querySelector(':scope > [data-edytor-children]');
		const end = children ? children.getBoundingClientRect().top : rect.bottom;
		[top, bottom, left] = [
			Math.min(top, rect.top),
			Math.max(bottom, end),
			Math.min(left, rect.left)
		];
	}
	if (top === Infinity) return null;
	return toRemoteRect({ left: left - 6, top, width: 2, height: bottom - top }, origin);
};

/** The peers' carets, ranges and block bars, relative to the overlay's `origin`. */
export const getRenderedRemoteSelections = (
	edytor: Edytor,
	origin: DOMRect
): RenderedRemoteSelection[] => {
	const editor = edytor.node;
	if (!editor) {
		return [];
	}

	// Phase split: resolve/validate every remote selection first,
	// touch layout APIs only when at least one candidate survives.
	// `editor.getBoundingClientRect()` used to run unconditionally at the
	// top — a synchronous layout read on EVERY awareness/doc invalidation
	// even with zero remote peers (the common solo-editing case).
	type ResolvedCandidate = {
		clientId: number;
		collapsed: boolean;
		reversed: boolean;
		startPoint: DomPoint;
		endPoint: DomPoint;
		user: EdytorAwarenessUser;
	};
	const candidates: ResolvedCandidate[] = [];
	const bars: { clientId: number; ids: string[]; user: EdytorAwarenessUser }[] = [];

	for (const [clientId, state] of edytor.awareness.getStates()) {
		if (clientId === edytor.doc.clientID) {
			continue;
		}
		const resolved = resolvePeerSelection(edytor, state);
		if (resolved && 'blocks' in resolved) {
			bars.push({ clientId, ids: resolved.blocks, user: getUser(state) });
			continue;
		}
		const selection = resolved;
		const startPoint = selection && findDomPoint(selection.start);
		const endPoint = selection && findDomPoint(selection.end);
		if (!selection || !startPoint || !endPoint) {
			continue;
		}
		const { collapsed, reversed } = selection;
		candidates.push({ clientId, collapsed, reversed, startPoint, endPoint, user: getUser(state) });
	}

	if (candidates.length === 0 && bars.length === 0) {
		return [];
	}

	const blocks = bars.flatMap(({ clientId, ids, user }): RenderedRemoteSelection[] => {
		const cursor = blockBar(edytor, ids, origin);
		return cursor
			? [
					{
						clientId,
						color: normalizeColor(user.color),
						label: user.name ?? null,
						cursor,
						rects: [],
						block: true
					}
				]
			: [];
	});
	return blocks.concat(
		candidates.map(({ clientId, collapsed, reversed, startPoint, endPoint, user }) => {
			const cursorPoint = reversed ? startPoint : endPoint;
			return {
				clientId,
				color: normalizeColor(user.color),
				label: user.name ?? null,
				cursor: getCaretRect(cursorPoint, origin, editor),
				rects: collapsed ? [] : getSelectionRects(startPoint, endPoint, origin, editor)
			};
		})
	);
};
