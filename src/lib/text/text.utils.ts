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
	{ value, isAutoDot, start, end, marks }: TextOperations['insertText']
) {
	// The caret's pending marks apply to an insertion at the caret, which consumes them.
	const { selection } = this.edytor;
	const { startText, yStart, yEnd } = selection.textRange();
	start ??= yStart;
	end ??= yEnd;
	const isCollapsed = start === end || !end;
	const pending = startText === this && yStart === start ? selection.pending : undefined;
	marks ??= marksForInsertion(this, start, {
		replaced: isCollapsed ? undefined : this.getMarksAtRange(start, end),
		pending
	});
	// Autocorrect replaces the character before the inserted value.
	const [from, length] = isAutoDot ? [start - 1, 1] : [start, isCollapsed ? 0 : end - start];
	this.edytor.transact(() => {
		if (length) this.deleteAt(from, length);
		this.insertAt(from, value, marks);
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
	const count = Math.max(0, length);
	if (!count || !this.length) return;
	// At a caret one character is one grapheme; backward deletes before it.
	const back = isCollapsed && direction === 'BACKWARD';
	const one = isCollapsed && count === 1;
	const value = this.stringContent;
	const start = Math.max(
		0,
		back ? (one ? getPreviousGraphemeStart(value, yStart) : yStart - count) : yStart
	);
	const end = Math.min(
		this.length,
		back ? yStart : one ? getNextGraphemeEnd(value, yStart) : start + count
	);
	if (end <= start) return;
	this.deleteAt(start, end - start);
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

/** Delete what follows `index` and answer it (one run per run of the text, cut at `index`). */
export function splitText(
	this: Text,
	{ index = this.edytor.selection.textRange().yStart }: TextOperations['splitText']
): JSONText[] {
	let offset = 0;
	const content = this.value.map(({ text, marks }) => {
		const part = { text: text.slice(Math.max(0, index - offset)), marks };
		offset += text.length;
		return part;
	});
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
