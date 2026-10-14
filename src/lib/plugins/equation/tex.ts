/**
 * An equation's pure forms: its data, its TeX source, the MathML that
 * carries the source (`sourceMathml`, the clipboard's form before KaTeX
 * loads and the export's on a server) and its HTML import. No Svelte.
 */
import { escapeHtml } from '$lib/clipboard/serializeClipboardFragment.js';

/** The data of a block equation and of an inline one: its TeX source. */
export type EquationData = { expression?: string };

/** The MathML annotation that carries an equation's TeX source. */
export const TEX = 'application/x-tex';

/** An equation's TeX source: its `expression`, a string. */
export const expressionOf = (data: unknown): string => {
	const value = (data as EquationData | undefined)?.expression;
	return typeof value === 'string' ? value : '';
};

/** MathML whose `application/x-tex` annotation is `tex`, the source as its text, in KaTeX's `katex` class. */
export const sourceMathml = (tex: string, display: boolean): string => {
	const source = escapeHtml(tex);
	return (
		`<span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ''}>` +
		`<semantics><mrow><mtext>${source}</mtext></mrow><annotation encoding="${TEX}">${source}</annotation></semantics></math></span>`
	);
};

/**
 * HTML import: the TeX source an equation's element carries — a `<math>`'s
 * `application/x-tex` annotation (or its `alttext`), alone or in KaTeX's
 * markup (`.katex`, `.katex-display`) — when the element is an equation of
 * the display asked (`display="block"`: a block), else `undefined`.
 */
export const parseEquation = (element: HTMLElement, display: boolean): EquationData | undefined => {
	const own = element.localName === 'math';
	const wrapper =
		element.classList.contains('katex') ||
		element.classList.contains('katex-display') ||
		element.hasAttribute('data-edytor-equation');
	if (!own && !wrapper) return undefined;
	const math = own ? element : element.querySelector('math');
	if (!math) return undefined;
	const block =
		math.getAttribute('display') === 'block' || element.classList.contains('katex-display');
	if (block !== display) return undefined;
	const tex =
		math.querySelector(`annotation[encoding="${TEX}"]`)?.textContent ??
		math.getAttribute('alttext');
	return tex?.trim() ? { expression: tex.trim() } : undefined;
};
