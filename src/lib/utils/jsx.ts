import type { JSONBlock, JSONText, JSONInlineBlock, SerializableContent } from './json.js';

type JSXAttributes = {
	children?: JSXChild | JSXChild[];
	data?: any;
} & {
	[key: string]:
		| string
		| number
		| boolean
		| SerializableContent
		| JSXChild
		| JSXChild[]
		| undefined;
};

type JSXChild = string | number | boolean | JSXElement | null | undefined;

interface JSXElement {
	type: string;
	props: JSXAttributes;
}

declare global {
	namespace JSX {
		interface Element extends JSXElement {}
		interface IntrinsicElements {
			[elemName: string]: JSXAttributes;
		}
	}
}

function jsx(type: string, props: JSXAttributes): JSXElement {
	return { type, props };
}

function jsxs(type: string, props: JSXAttributes): JSXElement {
	return jsx(type, props);
}

const MARK_ELEMENTS = new Set(['bold', 'italic', 'underline', 'strike', 'code']);

function convertJSXToJSONBlock(element: JSXElement): JSONBlock {
	const { type, props } = element;
	const { children, data, ...rest } = props;

	// Handle mark wrapper elements (bold, italic, etc)
	if (MARK_ELEMENTS.has(type)) {
		const textContent = convertChildrenToTextContent(children);
		return {
			type: 'text',
			content: [
				{
					text: textContent,
					marks: { [type]: true }
				}
			]
		};
	}

	// Handle inline blocks
	if (type === 'inline') {
		const inlineContent: JSONInlineBlock = {
			type: (props.blockType as string) || 'inline',
			...(data && { data })
		};
		return {
			type: 'inline',
			content: [inlineContent],
			...rest
		};
	}

	// Convert children
	const convertedChildren = children
		? (Array.isArray(children) ? children : [children])
				.filter(
					(child): child is JSXElement | string | number =>
						child != null &&
						(typeof child === 'object' || typeof child === 'string' || typeof child === 'number')
				)
				.map((child) => {
					if (typeof child === 'string' || typeof child === 'number') {
						return {
							type: 'text',
							content: [{ text: child.toString() }]
						};
					}
					return convertJSXToJSONBlock(child);
				})
		: undefined;

	return {
		type,
		...(convertedChildren && { children: convertedChildren }),
		...rest
	};
}

function convertChildrenToTextContent(children: JSXChild | JSXChild[] | undefined): string {
	if (!children) return '';

	const childArray = Array.isArray(children) ? children : [children];
	return childArray
		.filter(
			(child): child is string | number => typeof child === 'string' || typeof child === 'number'
		)
		.map((child) => child.toString())
		.join('');
}

export { jsx, jsxs, convertJSXToJSONBlock };
