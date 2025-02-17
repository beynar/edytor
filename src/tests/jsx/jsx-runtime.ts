import { renderJSX } from './rendering.js';
import { type IntrinsicElements as _IntrinsicElements, RenderedNode } from './types.js';

export { RenderedNode };

namespace JSX {
	export type IntrinsicElements = _IntrinsicElements;

	// Declare the shape of JSX rendering result
	// This is required so the return types of components can be inferred
	export type Element = RenderedNode;
}

// Export the main namespace
export type { JSX };

// Export factories
export const jsx = renderJSX;
export const jsxs = renderJSX;
export const jsxDEV = renderJSX;
export const Fragment = undefined;
