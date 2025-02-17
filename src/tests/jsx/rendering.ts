import { type JSX } from './jsx-runtime.js';
import { type FunctionComponent, RenderedNode, type JSXNode, type JSXChildren } from './types.js';
import type { JSONBlock, JSONText, JSONInlineBlock } from '../../lib/utils/json.js';

function isMarkOrText(tag: string): boolean {
	return tag === 'text' || ['bold', 'italic', 'underline', 'strike', 'code'].includes(tag);
}

function isInlineBlock(tag: string): boolean {
	return tag === 'mention';
}

function isSpan(tag: string): boolean {
	return tag === 'span';
}

type HTMLAttributes = Record<string, JSXNode | undefined> & JSXChildren;

function renderAttributes(attributes: HTMLAttributes): Record<string, any> {
	return Object.fromEntries(
		Object.entries(attributes)
			.filter(([key]) => key !== 'children' && key !== 'data')
			.map(([key, value]) => [key, value])
	);
}

function _renderJSX(
	tag: string | FunctionComponent | undefined,
	props: HTMLAttributes,
	accumulatedMarks: Record<string, any>
): JSONBlock | JSONText {
	if (typeof tag === 'function') {
		const result = tag(props);
		return result.value;
	}
	if (tag === undefined) {
		const { children, content } = _renderChildren(props, accumulatedMarks);
		if (children.length === 0 && content.length === 1) return content[0];
		return {
			type: 'text',
			content: content
		};
	}
	if (tag === 'text') {
		const text =
			typeof props.children === 'string' || typeof props.children === 'number'
				? String(props.children)
				: '';
		const textNode: JSONText = { text };
		if (Object.keys(accumulatedMarks).length > 0) {
			textNode.marks = accumulatedMarks;
		}
		return textNode;
	}
	if (isSpan(tag)) {
		const { children, content } = _renderChildren(props, accumulatedMarks);
		return {
			type: 'text',
			content: content
		};
	}
	if (isMarkOrText(tag)) {
		const newMarks = { ...accumulatedMarks, [tag]: true };
		const { children, content } = _renderChildren(props, newMarks);
		return {
			type: 'text',
			content: content
		};
	}
	if (isInlineBlock(tag)) {
		const attributes = renderAttributes(props);
		return {
			type: 'text',
			content: [
				{
					type: tag,
					data: Object.keys(attributes).length > 0 ? attributes : undefined
				}
			]
		};
	}
	// Treat as block element
	const { children, content } = _renderChildren(props, {});
	const attributes = renderAttributes(props);

	const block: JSONBlock = {
		type: tag,
		data: Object.keys(attributes).length > 0 ? attributes : undefined
	};
	if (children.length) block.children = children;
	if (content.length) block.content = content;
	if (!block.data) delete block.data;
	return block;
}

function mergeAdjacentTextNodes(
	nodes: (JSONText | JSONInlineBlock)[]
): (JSONText | JSONInlineBlock)[] {
	// First filter out empty text nodes that have no marks
	const nonEmptyNodes = nodes.filter((node) => {
		if ('text' in node) {
			return node.text !== '' || node.marks;
		}
		return true; // Keep all inline blocks
	});

	return nonEmptyNodes.reduce((acc: (JSONText | JSONInlineBlock)[], node) => {
		if (!('text' in node)) {
			// If it's an inline block, just add it
			acc.push(node);
			return acc;
		}

		const prev = acc[acc.length - 1];
		if (
			prev &&
			'text' in prev &&
			((!prev.marks && !node.marks) || // both have no marks
				(prev.marks &&
					node.marks &&
					Object.keys(prev.marks).length === Object.keys(node.marks).length &&
					Object.entries(prev.marks).every(([key, value]) => node.marks?.[key] === value)))
		) {
			// Merge with previous node if marks match
			prev.text += node.text;
			return acc;
		}
		acc.push(node);
		return acc;
	}, []);
}

function _renderChildren(
	props: HTMLAttributes,
	accumulatedMarks: Record<string, any>
): { children: JSONBlock[]; content: (JSONText | JSONInlineBlock)[] } {
	const children: JSONBlock[] = [];
	const content: (JSONText | JSONInlineBlock)[] = [];
	const childrenProp = props.children;
	if (!childrenProp) return { children, content };

	const childArray = Array.isArray(childrenProp) ? childrenProp : [childrenProp];

	for (const child of childArray) {
		if (child === null || child === undefined) continue;

		if (typeof child === 'string' || typeof child === 'number') {
			const text = String(child);
			if (text === '') continue; // Skip empty strings
			const textNode: JSONText = { text };
			if (Object.keys(accumulatedMarks).length > 0) {
				textNode.marks = accumulatedMarks;
			}
			content.push(textNode);
		} else if (child instanceof RenderedNode) {
			const rendered = child.value;
			if ('text' in rendered) {
				if (rendered.text === '' && !rendered.marks) continue; // Skip empty text without marks
				const textNode: JSONText = { text: rendered.text };
				if (rendered.marks || Object.keys(accumulatedMarks).length > 0) {
					textNode.marks = { ...accumulatedMarks, ...(rendered.marks || {}) };
				}
				content.push(textNode);
			} else if (
				rendered.type === 'text' &&
				'content' in rendered &&
				Array.isArray(rendered.content)
			) {
				rendered.content.forEach((node: JSONText | JSONInlineBlock) => {
					if ('text' in node) {
						if (node.text === '' && !node.marks) return; // Skip empty text without marks
						const textNode: JSONText = { text: node.text };
						if (node.marks || Object.keys(accumulatedMarks).length > 0) {
							textNode.marks = { ...accumulatedMarks, ...(node.marks || {}) };
						}
						content.push(textNode);
					} else if ('type' in node) {
						// This is an inline block
						content.push(node);
					}
				});
			} else {
				children.push(rendered as JSONBlock);
			}
		} else if (typeof child === 'object' && 'type' in child && 'props' in child) {
			const rendered = _renderJSX(
				child.type as string | FunctionComponent | undefined,
				child.props as HTMLAttributes,
				accumulatedMarks
			);
			if ('text' in rendered) {
				if (rendered.text === '' && !rendered.marks) continue; // Skip empty text without marks
				const textNode: JSONText = { text: rendered.text };
				if (rendered.marks || Object.keys(accumulatedMarks).length > 0) {
					textNode.marks = { ...accumulatedMarks, ...(rendered.marks || {}) };
				}
				content.push(textNode);
			} else if (
				rendered.type === 'text' &&
				'content' in rendered &&
				Array.isArray(rendered.content)
			) {
				rendered.content.forEach((node: JSONText | JSONInlineBlock) => {
					if ('text' in node) {
						if (node.text === '' && !node.marks) return; // Skip empty text without marks
						const textNode: JSONText = { text: node.text };
						if (node.marks || Object.keys(accumulatedMarks).length > 0) {
							textNode.marks = { ...accumulatedMarks, ...(node.marks || {}) };
						}
						content.push(textNode);
					} else if ('type' in node) {
						// This is an inline block
						content.push(node);
					}
				});
			} else {
				children.push(rendered as JSONBlock);
			}
		} else if (typeof child === 'function') {
			const result = child();
			if (result instanceof RenderedNode) {
				const rendered = result.value;
				if ('text' in rendered) {
					if (rendered.text === '' && !rendered.marks) continue; // Skip empty text without marks
					const textNode: JSONText = { text: rendered.text };
					if (rendered.marks || Object.keys(accumulatedMarks).length > 0) {
						textNode.marks = { ...accumulatedMarks, ...(rendered.marks || {}) };
					}
					content.push(textNode);
				} else if (
					rendered.type === 'text' &&
					'content' in rendered &&
					Array.isArray(rendered.content)
				) {
					rendered.content.forEach((node: JSONText | JSONInlineBlock) => {
						if ('text' in node) {
							if (node.text === '' && !node.marks) return; // Skip empty text without marks
							const textNode: JSONText = { text: node.text };
							if (node.marks || Object.keys(accumulatedMarks).length > 0) {
								textNode.marks = { ...accumulatedMarks, ...(node.marks || {}) };
							}
							content.push(textNode);
						} else if ('type' in node) {
							// This is an inline block
							content.push(node);
						}
					});
				} else {
					children.push(rendered as JSONBlock);
				}
			}
		}
	}
	return { children, content: mergeAdjacentTextNodes(content) };
}

export function renderJSX(
	tag: string | FunctionComponent | undefined,
	props: HTMLAttributes,
	_key?: string
): JSX.Element {
	const rendered = _renderJSX(tag, props, {});
	return new RenderedNode(rendered);
}
