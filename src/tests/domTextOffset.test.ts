/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { getTextContentOffsetAtPoint } from '$lib/events/domTextOffset.js';
import { getYIndex } from '$lib/selection/selection.utils.js';
import type { Text } from '$lib/text/text.svelte.js';

// D11 — the suppressed-input repair target read element-anchored carets
// wrong: an element anchor's `offset` is a CHILD INDEX, not a character
// count, so `textBefore + offset` produced garbage. The helper counts
// the text content of children before that index — the same rule
// `getYIndex` applies.
const createHost = (html: string) => {
	const host = document.createElement('div');
	host.innerHTML = html;
	return host;
};

describe('getTextContentOffsetAtPoint', () => {
	it('reads a text-node anchor as a character offset', () => {
		const host = createHost('<span class="text">foo<b>bar</b>baz</span>');
		const textElement = host.firstElementChild!;
		const firstTextNode = textElement.childNodes[0];

		expect(getTextContentOffsetAtPoint(textElement, firstTextNode, 2)).toBe(2);
		expect(getTextContentOffsetAtPoint(textElement, firstTextNode, 99)).toBe(3);
	});

	it('reads an element anchor on the text element as a child index', () => {
		const host = createHost('<span class="text">foo<b>bar</b>baz</span>');
		const textElement = host.firstElementChild!;

		expect(getTextContentOffsetAtPoint(textElement, textElement, 0)).toBe(0);
		expect(getTextContentOffsetAtPoint(textElement, textElement, 1)).toBe(3);
		expect(getTextContentOffsetAtPoint(textElement, textElement, 2)).toBe(6);
		expect(getTextContentOffsetAtPoint(textElement, textElement, 3)).toBe(9);
		// A child index past the end clamps to the text length.
		expect(getTextContentOffsetAtPoint(textElement, textElement, 99)).toBe(9);
	});

	it('reads an element anchor inside the text element', () => {
		const host = createHost('<span class="text">foo<b>bar</b>baz</span>');
		const textElement = host.firstElementChild!;
		const bold = textElement.querySelector('b')!;

		expect(getTextContentOffsetAtPoint(textElement, bold, 0)).toBe(3);
		expect(getTextContentOffsetAtPoint(textElement, bold, 1)).toBe(6);
	});

	it('resolves an ancestor-anchored child index to the side of the text', () => {
		const host = createHost('<span class="text">foo<b>bar</b>baz</span><i>x</i>');
		const textElement = host.firstElementChild!;

		expect(getTextContentOffsetAtPoint(textElement, host, 0)).toBe(0);
		expect(getTextContentOffsetAtPoint(textElement, host, 1)).toBe(9);
		expect(getTextContentOffsetAtPoint(textElement, host, 2)).toBe(9);
	});

	it('clamps stray points to the nearest edge by document order', () => {
		const host = createHost('<b>pre</b><span class="text">foo</span><i>post</i>');
		const textElement = host.querySelector('.text')!;
		const before = host.querySelector('b')!.firstChild!;
		const after = host.querySelector('i')!.firstChild!;

		expect(getTextContentOffsetAtPoint(textElement, after, 0)).toBe(3);
		expect(getTextContentOffsetAtPoint(textElement, before, 0)).toBe(0);
	});
});

// P2.4 — getYIndex is the one mapper plus the editor's marker, boundary and
// filler rules; the point shapes it must keep.
describe('getYIndex over the shared mapper', () => {
	const textOf = (node: HTMLElement, length: number, extra: Partial<Text> = {}) =>
		({ node, length, isEmpty: length === 0, endsWithNewline: false, ...extra }) as Text;

	it('counts leaves across marks, and child indexes on element anchors', () => {
		const host = createHost('<span>foo<b>bar</b><!---->baz</span>');
		const element = host.firstElementChild as HTMLElement;
		const text = textOf(element, 9);
		expect(getYIndex(text, element.querySelector('b')!.firstChild, 2)).toBe(5);
		expect(getYIndex(text, element, 2)).toBe(6);
		expect(getYIndex(text, element, 4)).toBe(9);
	});

	it('clamps the empty text filler caret to 0 (F-I22)', () => {
		const host = createHost('<span>\u200b</span>');
		const element = host.firstElementChild as HTMLElement;
		expect(getYIndex(textOf(element, 0), element.firstChild, 1)).toBe(0);
		expect(getYIndex(textOf(element, 0), element, 1)).toBe(0);
	});

	it('reads a point in the trailing-newline marker as the text end', () => {
		const host = createHost('<span>ab\n<span data-edytor-trailing-newline>\u200b</span></span>');
		const element = host.firstElementChild as HTMLElement;
		const text = textOf(element, 3, { endsWithNewline: true });
		expect(getYIndex(text, element.lastElementChild!.firstChild, 1)).toBe(3);
		expect(getYIndex(text, element.lastElementChild!.firstChild, 0)).toBe(3);
	});

	it('counts an Apple-converted space as its one character', () => {
		const host = createHost('<span>a<span class="Apple-converted-space">\u00a0</span>b</span>');
		const element = host.firstElementChild as HTMLElement;
		expect(getYIndex(textOf(element, 3), element.lastChild, 1)).toBe(3);
	});

	it('clamps points outside the text element by document position', () => {
		const host = createHost('<p>x</p><span>abc</span><p>y</p>');
		const element = host.children[1] as HTMLElement;
		const text = textOf(element, 3);
		expect(getYIndex(text, host.children[2].firstChild, 1)).toBe(3);
		expect(getYIndex(text, host.children[0].firstChild, 0)).toBe(0);
	});
});
