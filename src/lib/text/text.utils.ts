import { prevent } from '$lib/utils.js';
import type { Delta, JSONText, SerializableContent } from '$lib/utils/json.js';
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
		let finalPayload = payload;
		for (const plugin of this.edytor.plugins) {
			// @ts-expect-error
			const normalizedPayload = plugin.onBeforeOperation?.({
				operation,
				payload,
				text: this,
				block: this.parent,
				prevent
			}) as TextOperations[O] | undefined;
			if (normalizedPayload) {
				finalPayload = normalizedPayload;
				break;
			}
		}

		const result = this.edytor.transact(() => func.bind(this)(finalPayload));

		for (const plugin of this.edytor.plugins) {
			plugin.onAfterOperation?.({
				operation,
				payload,
				text: this,
				block: this.parent
			}) as TextOperations[O] | undefined;
		}

		return result;
	} as T;
}

export function insertText(
	this: Text,
	{
		value,
		isAutoDot,
		start = this.edytor.selection.state.yStart,
		end = this.edytor.selection.state.yEnd,
		marks = this.markOnNextInsert
	}: TextOperations['insertText']
) {
	const isCollapsed = start === end || !end;
	// const attributes = this.getAttributesAtPosition(yStart);
	const deltas: Delta[] = [{ retain: start }, { insert: value, attributes: marks }];

	if (isAutoDot) {
		deltas[0].retain = start - 1;
		deltas.splice(1, 0, { delete: 1 });
	}

	if (!isCollapsed) {
		deltas.splice(1, 0, { delete: end - start });
	}
	this.edytor.doc.transact(() => {
		if (isAutoDot || !isCollapsed) {
			this.yText.applyDelta(deltas);
		} else {
			this.yText.insert(start, value, marks);
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

	for (let i = 0; i < this.children.length; i++) {
		const { text, marks } = this.children[i];
		const length = text.length;
		const end = offset + length;

		if (yStart >= offset && yStart < end) {
			// Found start of range
			entered = true;
			const startOffset = yStart - offset;
			const endOffset = Math.min(length, yEnd - offset);
			result.push({
				text: text.slice(startOffset, endOffset),
				marks: Object.fromEntries(marks)
			});
		} else if (entered && end <= yEnd) {
			// Middle of range
			result.push({
				text,
				marks: Object.fromEntries(marks)
			});
		} else if (entered && offset < yEnd && yEnd <= end) {
			// End of range
			const endOffset = yEnd - offset;
			result.push({
				text: text.slice(0, endOffset),
				marks: Object.fromEntries(marks)
			});
			break;
		}

		offset += length;
	}

	return result;
}

export function deleteText(this: Text, { direction, length = 1 }: TextOperations['deleteText']) {
	const { yStart, isCollapsed } = this.edytor.selection.state;

	const deltas: Delta[] =
		direction === 'BACKWARD'
			? [{ retain: isCollapsed ? yStart - 1 : yStart }, { delete: isCollapsed ? 1 : length }]
			: [{ retain: isCollapsed ? yStart : yStart }, { delete: isCollapsed ? 1 : length }];
	console.log({ deltas });
	this.yText.applyDelta(deltas);
}

export function removeMarksFromText(
	this: Text,
	{
		start = this.edytor.selection.state.yStart || 0,
		end = this.edytor.selection.state.yEnd || this.yText.length
	}: TextOperations['markText']
) {
	const marksAtRange = this.getMarksAtRange(start, end);
	const attributes = marksAtRange.reduce((acc, { marks }) => {
		Object.entries(marks || {}).forEach(([key, value]) => {
			if (value === null) {
				Object.assign({ key: null });
			}
		});
		return acc;
	}, {});
	this.yText.format(start, end, attributes);
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
	const length = end - start;
	const isCollasped = end - start === 0;
	const marksAtRange = this.getMarksAtRange(isCollasped ? start - 1 : start, end);
	const isNextActiveMark = isCollasped && this.markOnNextInsert && mark in this.markOnNextInsert;
	const spreadOnAllRange = marksAtRange.every(({ marks }) => marks && mark in marks);
	const markValue = (spreadOnAllRange || isNextActiveMark) && toggle ? null : value;

	if (isCollasped) {
		const activeMarks = marksAtRange.reduce((acc, { marks }) => {
			Object.entries(marks || {}).forEach(([key, value]) => {
				if (value === true) {
					Object.assign(acc, { [key]: true });
				}
			});
			return acc;
		}, {});

		if (isNextActiveMark && markValue === null) {
			delete this.markOnNextInsert![mark];
		} else {
			this.markOnNextInsert = {
				...(this.markOnNextInsert || {}),
				...activeMarks,
				[mark]: markValue
			};
		}
	} else {
		this.yText.format(start, length, {
			[mark]: markValue
		});
	}
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
	this.yText.delete(index, this.yText.length - index);
	return content;
}

export function setText(this: Text, { value }: TextOperations['setText']) {
	this.yText.applyDelta([
		{ delete: this.yText.length },
		...value.map((part) => ({ insert: part.text, attributes: part.marks }))
	]);
}
