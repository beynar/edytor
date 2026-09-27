import type { JSONText, SerializableContent } from '$lib/utils/json.js';
import { marksForInsertion } from '$lib/session/editing/text.js';
import type { Text } from './text.svelte.js';

export type TextOperations = {
	insertText: {
		value: string;
		isAutoDot?: boolean;
		start?: number;
		end?: number;
		marks?: Record<string, SerializableContent | null>;
	};
	deleteText: {
		direction: 'BACKWARD' | 'FORWARD';
		length: number;
	};
	splitText: {
		index?: number;
	};
	setText: {
		value: JSONText[];
	};
	markText: {
		mark: string;
		start?: number;
		end?: number;
		value?: SerializableContent | null;
		toggle?: boolean;
	};
	removeMarksFromText: {
		start?: number;
		end?: number;
	};
};

export function batch<T extends (...args: any[]) => any, O extends keyof TextOperations>(
	operation: O,
	func: T
): T {
	return function (this: Text, payload: TextOperations[O]): ReturnType<T> {
		// Dispatched like block operations (`session/commands.ts`): plugins see
		// `block: this.parent` + `text: this`, the text arm of `ChangePayload`.
		return this.edytor.dispatcher.dispatch(
			operation,
			payload,
			{ block: this.parent, text: this },
			func
		) as ReturnType<T>;
	} as T;
}

export function insertText(
	this: Text,
	{
		value,
		isAutoDot,
		start = this.edytor.selection.state.yStart,
		end = this.edytor.selection.state.yEnd,
		marks
	}: TextOperations['insertText']
) {
	const isCollapsed = start === end || !end;
	marks ??= marksForInsertion(this, start, {
		replaced: isCollapsed ? undefined : this.getMarksAtRange(start, end),
		pending: this.markOnNextInsert
	});
	this.edytor.transact(() => {
		if (isAutoDot) {
			// Replace the previous char with the inserted value (autocorrect).
			this.deleteAt(start - 1, 1);
			this.insertAt(start - 1, value, marks);
		} else if (!isCollapsed) {
			this.deleteAt(start, end - start);
			this.insertAt(start, value, marks);
		} else {
			this.insertAt(start, value, marks);
		}
	});
	if (this.markOnNextInsert) {
		this.markOnNextInsert = undefined;
	}
}

export function getMarksAtRange(this: Text, yStart: number, yEnd: number) {
	const result: JSONText[] = [];
	let offset = 0;
	let entered = false;

	// Iterate the MODEL runs (`this.value`), never `this.children` — the
	// children getter applies the block's `transformText` (e.g. Prism code
	// tokens), whose marks are local decorations. Reading them here leaked
	// `codeToken` into persisted marks: typed/composed text inside a code
	// line inherited the decoration, splitting the serialized content.
	const parts = this.value;
	for (let i = 0; i < parts.length; i++) {
		const { text, marks } = parts[i];
		const length = text.length;
		const end = offset + length;

		if (yStart >= offset && yStart < end) {
			// Found start of range
			entered = true;
			const startOffset = yStart - offset;
			const endOffset = Math.min(length, yEnd - offset);
			result.push({
				text: text.slice(startOffset, endOffset),
				marks: { ...(marks ?? {}) }
			});
		} else if (entered && end <= yEnd) {
			// Middle of range
			result.push({
				text,
				marks: { ...(marks ?? {}) }
			});
		} else if (entered && offset < yEnd && yEnd <= end) {
			// End of range
			const endOffset = yEnd - offset;
			result.push({
				text: text.slice(0, endOffset),
				marks: { ...(marks ?? {}) }
			});
			break;
		}

		offset += length;
	}

	return result;
}

type GraphemeSegment = {
	index: number;
	segment: string;
};

type GraphemeSegmenter = {
	segment(value: string): Iterable<GraphemeSegment>;
};

type GraphemeSegmenterConstructor = new (
	locale?: string | string[],
	options?: { granularity: 'grapheme' }
) => GraphemeSegmenter;

const getGraphemeBoundaries = (value: string) => {
	const Segmenter = (Intl as typeof Intl & { Segmenter?: GraphemeSegmenterConstructor }).Segmenter;
	if (Segmenter) {
		return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)).map(
			({ index, segment }) => ({
				start: index,
				end: index + segment.length
			})
		);
	}

	let index = 0;
	return Array.from(value).map((segment) => {
		const start = index;
		index += segment.length;
		return {
			start,
			end: index
		};
	});
};

export const getPreviousGraphemeStart = (value: string, offset: number) => {
	const clampedOffset = Math.min(Math.max(offset, 0), value.length);
	let previousStart = 0;

	for (const boundary of getGraphemeBoundaries(value)) {
		if (boundary.end >= clampedOffset) {
			return boundary.start < clampedOffset ? boundary.start : previousStart;
		}
		previousStart = boundary.start;
	}

	return previousStart;
};

export const getNextGraphemeEnd = (value: string, offset: number) => {
	const clampedOffset = Math.min(Math.max(offset, 0), value.length);

	for (const boundary of getGraphemeBoundaries(value)) {
		if (boundary.end > clampedOffset) {
			return boundary.end;
		}
	}

	return clampedOffset;
};

export function deleteText(this: Text, { direction, length = 1 }: TextOperations['deleteText']) {
	const { yStart, isCollapsed } = this.edytor.selection.state;
	const requestedLength = Math.max(0, length);
	const textLength = this.length;

	if (requestedLength === 0 || textLength === 0) {
		return;
	}

	const shouldDeleteSingleGrapheme = isCollapsed && requestedLength === 1;
	const start =
		shouldDeleteSingleGrapheme && direction === 'BACKWARD'
			? getPreviousGraphemeStart(this.stringContent, yStart)
			: direction === 'BACKWARD' && isCollapsed
				? Math.max(0, yStart - requestedLength)
				: Math.max(0, yStart);
	const end =
		shouldDeleteSingleGrapheme && direction === 'FORWARD'
			? getNextGraphemeEnd(this.stringContent, yStart)
			: direction === 'BACKWARD' && isCollapsed
				? Math.min(textLength, yStart)
				: Math.min(textLength, start + requestedLength);
	const deleteLength = end - start;

	if (deleteLength <= 0) {
		return;
	}

	this.deleteAt(start, deleteLength);
	return { start, end };
}

export function removeMarksFromText(
	this: Text,
	{
		start = this.edytor.selection.state.yStart || 0,
		end = this.edytor.selection.state.yEnd || this.length
	}: TextOperations['removeMarksFromText']
) {
	// Persisted mark changes delegate to the document: `clearMarks`
	// discovers every mark name present in the range from the maintained
	// runs view and unsets them via `formatRange` — the same collect+clear
	// this used to re-derive locally. `segStart` maps the segment-local
	// range into the block's display offsets. (Toggle/range READS above stay
	// view-side: they decide WHAT to write, the document owns the write.)
	const model = this.parent.model;
	if (this._live && model) {
		model.clearMarks(this.segStart + start, end - start);
		this.refreshFromModel();
		return;
	}
	// Detached spec buffer (`new Text` pre-admission): no document node —
	// collect the names locally and unset through the spec-buffer `formatAt`.
	const marksAtRange = this.getMarksAtRange(start, end);
	const attributes = marksAtRange.reduce(
		(acc, { marks }) => {
			Object.keys(marks || {}).forEach((key) => {
				Object.assign(acc, { [key]: null });
			});
			return acc;
		},
		{} as Record<string, null>
	);
	this.formatAt(start, end - start, attributes);
	this.refreshFromModel();
}

export function markText(
	this: Text,
	{
		mark,
		value = true,
		toggle = false,
		start = this.edytor.selection.state.yStart,
		end = this.edytor.selection.state.yEnd
	}: TextOperations['markText']
) {
	if (start === end) {
		// A caret stages the full set the next insertion carries (values kept).
		const { [mark]: current = null, ...rest } = marksForInsertion(this, start, {
			pending: this.markOnNextInsert
		});
		const next = current !== null && toggle ? null : value;
		this.markOnNextInsert = next === null ? rest : { ...rest, [mark]: next };
		return;
	}
	const marksAtRange = this.getMarksAtRange(start, end);
	const spreadOnAllRange =
		marksAtRange.length > 0 && marksAtRange.every(({ marks }) => marks && mark in marks);
	this.formatAt(start, end - start, { [mark]: spreadOnAllRange && toggle ? null : value });
	this.refreshFromModel();
}

// This function split a Y.Text at an index, delete what is after the index and returns the deleted content as a JSONText[]
export function splitText(
	this: Text,
	{ index = this.edytor.selection.state.yStart }: TextOperations['splitText']
) {
	let offset = 0;
	let content: JSONText[] = [];

	for (const child of this.value) {
		const textLength = child.text.length;
		const nextOffset = offset + textLength;

		if (offset < index) {
			content.push({
				text: child.text.slice(index - offset),
				marks: child.marks
			});
		} else {
			// Text fully after split point
			content.push({
				text: child.text,
				marks: child.marks
			});
		}
		offset = nextOffset;
	}
	this.deleteAt(index, this.length - index);
	return content;
}

export function setText(this: Text, { value }: TextOperations['setText']) {
	this.deleteAt(0, this.length);
	let offset = 0;
	for (const part of value) {
		if (part.text.length) {
			this.insertAt(offset, part.text, part.marks as Record<string, unknown> | undefined);
			offset += part.text.length;
		}
	}
}
