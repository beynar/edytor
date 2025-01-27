import type { Delta, JSONDoc, JSONText, SerializableContent } from '$lib/utils/json.js';
import type { Text } from './text.svelte.js';

export function insertText(
	this: Text,
	value: string,
	specialCase: 'AUTO_DOT' | 'PASTE' | 'INSERT_LINE_BREAK' | null = null
) {
	const { yStart, yEnd, isCollapsed, startNode, start, ranges } = this.edytor.selection.state;
	const attributes = this.getAttributesAtPosition(yStart);
	const deltas: Delta[] = [
		{ retain: yStart },
		// delete the selection length
		{ insert: value, attributes }
	];

	if (specialCase === 'AUTO_DOT') {
		deltas[0].retain = yStart - 1;
		deltas.splice(1, 0, { delete: 1 });
	}

	if (!isCollapsed) {
		deltas.splice(1, 0, { delete: yEnd - yStart });
	}

	this.edytor.transactRemote(
		() => {
			if (specialCase === 'AUTO_DOT' || !isCollapsed) {
				this.yText.applyDelta(deltas);
			} else {
				this.yText.insert(yStart, value);
			}
		},
		!['INSERT_LINE_BREAK', 'PASTE'].includes(specialCase as any)
	);
}

export function getAttributesAtPosition(
	this: Text,
	yStart: number = this.edytor.selection.state.yStart
) {
	let attributes = {};
	let textIndex = 0;
	for (let i = 0; i < this.children.length; i++) {
		const { text, marks } = this.children[i];
		const length = text.length;
		if (yStart >= textIndex && yStart <= textIndex + length) {
			attributes = Object.fromEntries(marks);
			break;
		}
		textIndex += length;
	}
	return attributes;
}

export function getAttributesAtRange(
	this: Text,
	yStart: number = this.edytor.selection.state.yStart,
	yEnd: number = this.edytor.selection.state.yEnd
) {
	let attributes = {};
	let index = 0;
	let entered = false;
	for (let i = 0; i < this.children.length; i++) {
		const { text, marks } = this.children[i];
		const length = text.length;
		const end = index + length;
		if (index <= yStart) {
			entered = true;
			Object.assign(attributes, Object.fromEntries(marks));
		}
		if (end >= yEnd && entered) {
			Object.assign(attributes, Object.fromEntries(marks));
			break;
		}
		index += length;
	}
	return attributes;
}

export function deleteText(this: Text, direction: 'BACKWARD' | 'FORWARD', length: number = 1) {
	const { yStart, yEnd, isCollapsed } = this.edytor.selection.state;

	const deltas: Delta[] =
		direction === 'BACKWARD'
			? [{ retain: isCollapsed ? yStart - 1 : yStart }, { delete: isCollapsed ? 1 : length }]
			: [{ retain: isCollapsed ? yStart : yStart }, { delete: isCollapsed ? 1 : length }];

	this.yText.applyDelta(deltas);
}

export function mark(
	this: Text,
	{
		type,
		value,
		toggleIfExists = false
	}: {
		type: string;
		value: SerializableContent;
		toggleIfExists?: boolean;
	}
) {
	const { yStart, yEnd, length, end, ranges } = this.edytor.selection.state;
	const attributesAtRange = getAttributesAtRange.bind(this)(yStart, yEnd);
	const exists = type in attributesAtRange;

	this.yText.format(yStart, length, {
		[type]: true
	});

	this.edytor.selection.setSelectionAtTextRange(this, yStart, yEnd);
}

// This function split a Y.Text at an index, delete what is after the index and returns the deleted content as a JSONText[]
export function split(this: Text, index: number = this.edytor.selection.state.yStart) {
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

export function set(this: Text, value: JSONText[]) {
	this.yText.applyDelta([
		{ delete: this.yText.length },
		...value.map((part) => ({ insert: part.text, attributes: part.marks }))
	]);
}
