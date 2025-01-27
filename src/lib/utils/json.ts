/* eslint-disable @typescript-eslint/no-explicit-any */
import { Text, AbstractType, Array as YArray, Map, Doc } from 'yjs';

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
