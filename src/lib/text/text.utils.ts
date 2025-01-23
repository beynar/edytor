import type { Delta, JSONText, Mark, SerializableContent } from '$lib/utils/json.js';
import { tick } from 'svelte';
import type { Text } from './text.svelte.js';
import * as Y from 'yjs';

export function insertText(
	this: Text,
	value: string,
	specialCase: 'AUTO_DOT' | 'PASTE' | 'INSERT_LINE_BREAK' | null = null
) {
	this.startComposing();
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
	if (isCollapsed) {
		// virtually move the selection to the new position
		// this is to ensure that the selection is at the right place after the text is inserted
		// in case of rapid editing this can avoid swapped letter
		this.edytor.selection.state.yStart += value.length;
	}
	this.edytor.transact(
		() => {
			this.yText.applyDelta(deltas);
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
	const { yStart, yEnd, isCollapsed, startNode, start, ranges } = this.edytor.selection.state;

	const deltas: Delta[] =
		direction === 'BACKWARD'
			? [{ retain: isCollapsed ? yStart - 1 : yStart }, { delete: isCollapsed ? 1 : length }]
			: [{ retain: isCollapsed ? yStart : yStart }, { delete: isCollapsed ? 1 : length }];
	console.log({ deltas });
	this.edytor.transact(() => {
		this.yText.applyDelta(deltas);
	});
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
	console.log({ exists, attributesAtRange });
	this.edytor.transact(() => {
		this.yText.format(yStart, length, {
			[type]: true
		});
	});
	this.setChildren();
	tick().then(() => {
		this.edytor.selection.setSelectionAtTextRange(this, yStart, yEnd);
	});
}

export const createTextFromJson = (yText: Y.Text, parts: JSONText[]): Y.Text => {
	let offset = 0;
	parts.forEach((part) => {
		const { text, marks } = part;
		yText.insert(offset, text, marks);
		offset += text.length;
	});
	return yText;
};
