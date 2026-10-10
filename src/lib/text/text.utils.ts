import type { JSONText, SerializableContent } from '$lib/utils/json.js';
import { marksForInsertion } from '$lib/session/editing/text.js';
import type { Text } from './text.svelte.js';
import { planned } from '$lib/block/block.utils.js';

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

/** Bind a text operation onto its segment: a command about the segment's block ({@link planned}). */
export const batch = <T extends (payload: any) => any>(
	operation: keyof TextOperations,
	func: T
): T => planned(operation, undefined, (_, payload) => func(payload)) as T;

export function insertText(
	this: Text,
	{
		value,
		isAutoDot,
		start = this.edytor.selection.textRange().yStart,
		end = this.edytor.selection.textRange().yEnd,
		marks
	}: TextOperations['insertText']
) {
	const isCollapsed = start === end || !end;
	// The caret's pending marks apply to an insertion at the caret, which consumes them.
	const { selection } = this.edytor;
	const { startText, yStart } = selection.textRange();
	const pending = startText === this && yStart === start ? selection.pending : undefined;
	marks ??= marksForInsertion(this, start, {
		replaced: isCollapsed ? undefined : this.getMarksAtRange(start, end),
		pending
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
	if (pending) selection.stage(undefined);
}

export function getMarksAtRange(this: Text, yStart: number, yEnd: number) {
	// The MODEL runs (`this.value`), never the rendered ones: a kind's
	// `transformText` decorations (code tokens) are no marks of the text.
	const result: JSONText[] = [];
	let offset = 0;
	for (const { text, marks } of this.value) {
		const end = offset + text.length;
		// From the run holding `yStart`, every run starting before `yEnd`.
		if (result.length ? offset < yEnd : yStart >= offset && yStart < end)
			result.push({
				text: text.slice(Math.max(0, yStart - offset), yEnd - offset),
				marks: { ...marks }
			});
		offset = end;
	}
	return result;
}

type Segmenter = new (
	locale?: string,
	options?: { granularity: 'grapheme' }
) => { segment(value: string): Iterable<{ index: number }> };

/** The offsets where `value`'s graphemes start, then its length (code points without `Intl.Segmenter`). */
const graphemeEdges = (value: string): number[] => {
	const Segmenter = (Intl as { Segmenter?: Segmenter }).Segmenter;
	const starts = Segmenter
		? Array.from(
				new Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
				(s) => s.index
			)
		: [];
	if (!Segmenter)
		for (let at = 0; at < value.length; at += value.codePointAt(at)! > 0xffff ? 2 : 1)
			starts.push(at);
	return [...starts, value.length];
};

const clamp = (value: string, offset: number) => Math.min(Math.max(offset, 0), value.length);

/** The start of the grapheme before `offset` (0 at the start). */
export const getPreviousGraphemeStart = (value: string, offset: number) =>
	graphemeEdges(value).findLast((edge) => edge < clamp(value, offset)) ?? 0;

/** The end of the grapheme after `offset` (`offset`, clamped, at the end). */
export const getNextGraphemeEnd = (value: string, offset: number) => {
	const at = clamp(value, offset);
	return graphemeEdges(value).find((edge) => edge > at) ?? at;
};

export function deleteText(this: Text, { direction, length = 1 }: TextOperations['deleteText']) {
	const { yStart } = this.edytor.selection.textRange();
	const { isCollapsed } = this.edytor.selection.projection;
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
		start = this.edytor.selection.textRange().yStart || 0,
		end = this.edytor.selection.textRange().yEnd || this.length
	}: TextOperations['removeMarksFromText']
) {
	// Persisted mark changes delegate to the document: `clearMarks` discovers
	// every mark name present in the range and unsets them; `segStart` maps
	// the segment-local range into the block's display offsets.
	this.parent.model?.clearMarks(this.segStart + start, end - start);
}

export function markText(
	this: Text,
	{
		mark,
		value = true,
		toggle = false,
		start = this.edytor.selection.textRange().yStart,
		end = this.edytor.selection.textRange().yEnd
	}: TextOperations['markText']
) {
	if (start === end) {
		// A caret stages the full set the next insertion carries (values kept).
		const { selection } = this.edytor;
		const { [mark]: current = null, ...rest } = marksForInsertion(this, start, {
			pending: selection.pending
		});
		const next = current !== null && toggle ? null : value;
		selection.stage(next === null ? rest : { ...rest, [mark]: next });
		return;
	}
	const marksAtRange = this.getMarksAtRange(start, end);
	const spreadOnAllRange =
		marksAtRange.length > 0 && marksAtRange.every(({ marks }) => marks && mark in marks);
	this.formatAt(start, end - start, { [mark]: spreadOnAllRange && toggle ? null : value });
}

// This function split a Y.Text at an index, delete what is after the index and returns the deleted content as a JSONText[]
export function splitText(
	this: Text,
	{ index = this.edytor.selection.textRange().yStart }: TextOperations['splitText']
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
