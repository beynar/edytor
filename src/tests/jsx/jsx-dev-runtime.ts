import { renderJSX } from './rendering.js';
import { type JSXChildren, type JSXNode, RenderedNode } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace JSX {
	// Set the attributes to allow any keys and very permissive values
	export type HTMLAttributes = Record<string, JSXNode | undefined> & JSXChildren;

	// Allow any html tag
	export type IntrinsicElements = Record<string, HTMLAttributes> | undefined;

	// Declare the shape of JSX rendering result
	// This is required so the return types of components can be inferred
	export type Element = RenderedNode;
}

// Expose the main namespace
export type { JSX };

// Expose factories
export const jsx = renderJSX;
export const jsxs = renderJSX;
export const jsxDEV = renderJSX;
