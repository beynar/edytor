/**
 * `textToBlocks` — a plain or markdown-ish string as blocks (the suggestion
 * layer's string content, AI output). Expected values are written from the
 * documented rules (site `editor/suggestions#text-to-blocks`), never from a run.
 */
import { describe, expect, test } from 'vitest';
import { textToBlocks } from '$lib/clipboard/textBlocks.js';

const p = (text: string) => ({ type: 'paragraph', content: [{ text }] });

describe('textToBlocks — plain text', () => {
	test('blank lines split paragraphs; a single newline stays in the text', () => {
		expect(textToBlocks('One\ntwo\n\n\nThree', { markdown: false })).toEqual([
			p('One\ntwo'),
			p('Three')
		]);
	});

	test('nothing but whitespace is no block; the paragraph kind is configurable', () => {
		expect(textToBlocks('  \n\n ', { markdown: false })).toEqual([]);
		expect(textToBlocks('x', { markdown: false, type: 'text' })).toEqual([
			{ type: 'text', content: [{ text: 'x' }] }
		]);
	});

	test('markdown syntax stays text', () => {
		expect(textToBlocks('# Not a heading', { markdown: false })).toEqual([p('# Not a heading')]);
	});
});

describe('textToBlocks — markdown', () => {
	test('headings, bullets, numbers, to-dos, quotes and dividers', () => {
		expect(
			textToBlocks(
				[
					'# Title',
					'## Sub',
					'#### Deep',
					'- one',
					'* two',
					'1. first',
					'- [ ] open',
					'[x] done',
					'> said',
					'---'
				].join('\n')
			)
		).toEqual([
			{ type: 'heading', data: { level: 'h1' }, content: [{ text: 'Title' }] },
			{ type: 'heading', data: { level: 'h2' }, content: [{ text: 'Sub' }] },
			{ type: 'heading', data: { level: 'h3' }, content: [{ text: 'Deep' }] },
			{ type: 'bulleted-list-item', content: [{ text: 'one' }] },
			{ type: 'bulleted-list-item', content: [{ text: 'two' }] },
			{ type: 'numbered-list-item', content: [{ text: 'first' }] },
			{ type: 'todo-item', data: { checked: false }, content: [{ text: 'open' }] },
			{ type: 'todo-item', data: { checked: true }, content: [{ text: 'done' }] },
			{ type: 'quote', content: [{ text: 'said' }] },
			{ type: 'divider', content: [] }
		]);
	});

	test('consecutive lines join one paragraph with a space; a blank line ends it', () => {
		expect(textToBlocks('Hello\nworld\n\nNext')).toEqual([p('Hello world'), p('Next')]);
	});

	test('an indented list item nests under the item before it', () => {
		expect(textToBlocks('- a\n  - b\n    - c\n- d')).toEqual([
			{
				type: 'bulleted-list-item',
				content: [{ text: 'a' }],
				children: [
					{
						type: 'bulleted-list-item',
						content: [{ text: 'b' }],
						children: [{ type: 'bulleted-list-item', content: [{ text: 'c' }] }]
					}
				]
			},
			{ type: 'bulleted-list-item', content: [{ text: 'd' }] }
		]);
	});

	test('bold, italic, code and links become marks', () => {
		expect(textToBlocks('A **b** *i* `c` [l](https://x.dev) _u_')).toEqual([
			{
				type: 'paragraph',
				content: [
					{ text: 'A ' },
					{ text: 'b', marks: { bold: true } },
					{ text: ' ' },
					{ text: 'i', marks: { italic: true } },
					{ text: ' ' },
					{ text: 'c', marks: { code: true } },
					{ text: ' ' },
					{ text: 'l', marks: { link: { href: 'https://x.dev' } } },
					{ text: ' ' },
					{ text: 'u', marks: { italic: true } }
				]
			}
		]);
	});

	test('a fenced code block is a code block of lines', () => {
		expect(textToBlocks('```js\nlet a\n\nb()\n```')).toEqual([
			{
				type: 'code',
				content: [],
				children: [
					{ type: 'codeLine', content: [{ text: 'let a' }] },
					{ type: 'codeLine', content: [{ text: '' }] },
					{ type: 'codeLine', content: [{ text: 'b()' }] }
				]
			}
		]);
	});

	test('an unclosed fence (a stream cut mid-block) keeps the lines so far', () => {
		expect(textToBlocks('```\nlet a')).toEqual([
			{ type: 'code', content: [], children: [{ type: 'codeLine', content: [{ text: 'let a' }] }] }
		]);
	});
});
