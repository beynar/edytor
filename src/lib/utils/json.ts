/* eslint-disable @typescript-eslint/no-explicit-any */
import { Text, AbstractType, Array as YArray, Map, Doc } from 'yjs';
import { makeId } from './getId.js';

export type YBlock = Map<any>;

export type Mark = [string, Record<string, unknown> | boolean | string];

export type SerializableContent = {
	[key: string]: string | boolean | SerializableContent;
};

export type JSONText = {
	text: string;
	marks?: SerializableContent;
};

export type JSONBlock = {
	type: string;
	id?: string;
	children?: JSONBlock[];
	content?: JSONText[];
} & Record<string, unknown>;
export type PartialJSONBlock = Omit<JSONBlock, 'children' | 'content'>;

export type JSONDoc = {
	children: JSONBlock[];
} & Partial<Record<string, unknown>>;

export type Delta = {
	insert?: string;
	retain?: number;
	delete?: number;
	attributes?: Record<string, boolean | string | Record<string, unknown>>;
};
export const yTextToJSON = (text: Text): JSONText[] => {
	const deltas = text.toDelta() as Delta[];
	return deltas.map((delta) => {
		return {
			text: delta.insert || '',
			marks: !delta.attributes ? [] : Object.entries(delta.attributes)
		} satisfies JSONText;
	});
};

export const yTextFromJson = (parts: JSONText[]): Text => {
	const yText = new Text();
	let offset = 0;
	parts.forEach((part) => {
		const { text, marks } = part;
		yText.insert(offset, text, marks);
		offset += text.length;
	});
	return yText;
};

export const partialBlockToJson = (yBlock: YBlock): PartialJSONBlock => {
	const block = {} as Omit<JSONBlock, 'children' | 'content'>;
	yBlock._map.forEach((item, key) => {
		if (!item.deleted && key !== 'children' && key !== 'content') {
			const v = item.content.getContent()[item.length - 1];
			Object.assign(block, { [key]: v instanceof AbstractType ? v.toJSON() : v });
		}
	});
	return block;
};

export const blockToJson = (block: YBlock): JSONBlock => {
	const content = yTextToJSON(block.get('content') as Text);
	const children = (block.get('children') as YArray<YBlock>)
		.toArray()
		.map(blockToJson) as JSONBlock[];

	return {
		...partialBlockToJson(block),
		content,
		children
	} as JSONBlock;
};

export const yBlockFromJson = ({
	type,
	value = {},
	id = makeId(),
	content = [{ text: '' }],
	children = []
}: JSONBlock): YBlock => {
	// Create a new YMap and initialize it with required properties first
	const node = new Map<any>();
	node.set('type', type);
	node.set('id', id);

	// Create and set content
	const yText = yTextFromJson(content);
	node.set('content', yText);

	// Create and set children
	const yChildren = new YArray<YBlock>();
	children.forEach((child) => {
		yChildren.insert(yChildren.length, [yBlockFromJson(child)]);
	});
	node.set('children', yChildren);

	// Set any additional properties
	Object.entries(value as Record<string, unknown>).forEach(([key, val]) => {
		if (key !== 'type' && key !== 'id' && key !== 'content' && key !== 'children') {
			node.set(key, val);
		}
	});

	return node;
};

export const docFromJson = ({ children, ...properties }: JSONDoc): Doc => {
	const doc = new Doc();
	doc.getArray('children').insert(0, children.map(yBlockFromJson));
	const propertiesMap = doc.getMap('properties');
	Object.entries(properties).forEach(([key, value]) => {
		propertiesMap.set(key, value);
	});
	return doc;
};

export const docToJson = (doc: Doc): JSONDoc => {
	const children = (doc.getArray('children').toArray() as YBlock[]).map(blockToJson);
	const properties = doc.getMap('properties').toJSON();
	return {
		children,
		...properties
	};
};

export const blockToText = (block: YBlock): string => {
	const content = block.get('content') as Text;
	const contentArray = block.get('children').toArray();
	const text = contentArray
		.map((item: Text | YBlock) => (item instanceof Text ? item.toString() : blockToText(item)))
		.join(' ');
	return `${content.toString()} ${text}`;
};
