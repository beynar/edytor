// All of those values can be used as an attribute or node content
export type JSXNode =
	| RenderedNode
	| RawContentNode
	| (() => JSXNode)
	| boolean
	| number
	| bigint
	| string
	| null
	| undefined;

export interface JSXChildren {
	children?: JSXNode | JSXNode[] | undefined;
}

interface RawContentNode {
	htmlContent: string;
}

export type FunctionComponent = (props: Record<string, unknown>) => RenderedNode;

// Class to hold the result, required to differentiate
// between a string coming from outside versus already rendered jsx
// Required to handle escaping correctly
export class RenderedNode {
	public constructor(public readonly value: any) {}
}

export interface IntrinsicElements {
	span: any;
	color: any;
	root: any;
	bold: any;
	italic: any;
	underline: any;
	strike: any;
	code: any;
	link: any;
	mention: any;
	quote: any;
	paragraph: any;
	fragment: any;
	blockquote: any;
	'list-item': any;
	'ordered-list': any;
	'unordered-list': any;
}
