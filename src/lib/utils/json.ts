/* eslint-disable @typescript-eslint/no-explicit-any */
import { Text, AbstractType, Array as YArray, Map, Doc } from 'yjs';

export type YBlock = Map<any>;

export type Mark = [string, Record<string, unknown> | boolean | string];

export type SerializableContent =
	| {
			[key: string]: SerializableContent;
	  }
	| string
	| boolean
	| number
	| null;

export type JSONText = {
	text: string;
	marks?: Record<string, SerializableContent>;
};

export type JSONInlineBlock = {
	id?: string;
	data?: any;
	type: string;
};

export type JSONBlock = {
	type: string;
	id?: string;
	data?: Record<string, SerializableContent>;
	children?: JSONBlock[];
	content?: (JSONText | JSONInlineBlock)[];
};

export type PartialJSONBlock = Omit<JSONBlock, 'children' | 'content'>;

export type JSONDoc = {
	children: JSONBlock[];
} & Partial<Record<string, unknown>>;

export type Delta = {
	insert?: string;
	retain?: number;
	delete?: number;
	attributes?: SerializableContent;
};
