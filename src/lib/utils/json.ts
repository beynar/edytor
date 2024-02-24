/* eslint-disable @typescript-eslint/no-explicit-any */
import { Text, AbstractType, Array, Map, Doc } from 'yjs';

export type YBlock = Map<any>;

export type JSONText = {
	text: string;
	marks?: Record<string, unknown>[];
};

export type JSONBlock = {
	type: string;
	children?: JSONBlock[];
	content?: JSONText[];
} & Record<string, unknown>;

export type JSONDoc = {
	children: JSONBlock[];
} & Partial<Record<string, unknown>>;

export const yTextToJSON = (text: Text): JSONText[] => {
	const deltas = text.toDelta() as { insert: string; attributes?: Record<string, unknown> }[];
	return deltas.map((delta) => {
		return {
			text: delta.insert,
			marks: !delta.attributes
				? []
				: Object.entries(delta.attributes).map(([key, value]) => {
						return {
							[key]: value
						};
					})
		} satisfies JSONText;
	});
};

export const yTextFromJson = (parts: JSONText[]): Text => {
	const yText = new Text();
	let offset = 0;
	parts.forEach((part) => {
		const { text, marks } = part;
		yText.insert(
			offset,
			text,
			marks?.reduce((acc, mark) => Object.assign(acc, mark), {}) as Record<string, unknown>
		);
		offset += text.length;
	});
	return yText;
};

export const partialBlockToJson = (yBlock: YBlock): Omit<JSONBlock, 'children' | 'content'> => {
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
	const children = (block.get('children') as Array<YBlock>)
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
	content = [{ text: '' }],
	children = []
}: JSONBlock): YBlock => {
	const node = new Map<any>(
		Object.entries(
			Object.assign(
				{},
				value,
				{ type },
				{ content: yTextFromJson(content), children: Array.from(children.map(yBlockFromJson)) }
			)
		)
	);
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
		.map((item) => (item instanceof Text ? item.toString() : item))
		.join(' ');
	return `${content.toString()} ${text}`;
};
