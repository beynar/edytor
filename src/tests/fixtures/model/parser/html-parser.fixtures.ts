import { expect } from 'vitest';

import HTMLNode, { type HTMLNodeInterface } from '$lib/plugins/html/parser.js';
import { defineFixtures, defineParserFixture } from '../../types.js';

const elementSets = {
	blocks: new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre']),
	marks: new Set(['strong', 'em', 'u', 'code', 'span']),
	inlineBlocks: new Set(['a', 'img'])
};

export const fixtures = defineFixtures([
	defineParserFixture({
		description: 'parses basic HTML with known blocks',
		input: '<p>This is a paragraph.</p>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].tagName).toBe('p');
			expect(result[0].text()).toBe('This is a paragraph.');
		}
	}),
	defineParserFixture({
		description: 'unwraps unknown blocks',
		input: '<unknown>This text should be unwrapped.</unknown>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].tagName).toBe('');
			expect(result[0].text()).toBe('This text should be unwrapped.');
		}
	}),
	defineParserFixture({
		description: 'preserves known blocks and marks',
		input: '<p>This is <strong>important</strong> text.</p><div>Another block</div>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result).toHaveLength(2);
			expect(result[0].tagName).toBe('p');
			expect(result[1].tagName).toBe('div');
			expect(result[0].content).toHaveLength(3);
			expect(result[0].content[1].tagName).toBe('strong');
		}
	}),
	defineParserFixture({
		description: 'unwraps unknown blocks while preserving nested known content',
		input: '<custom><p>This paragraph should be preserved.</p><span>This span too.</span></custom>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result).toHaveLength(2);
			const paragraph = result.find((node) => node.tagName === 'p');
			const span = result.find((node) => node.tagName === 'span');
			expect(paragraph?.text()).toBe('This paragraph should be preserved.');
			expect(span?.text()).toBe('This span too.');
		}
	}),
	defineParserFixture({
		description: 'handles nested unwrapping correctly',
		input: '<unknown1><unknown2>This text should be unwrapped twice.</unknown2></unknown1>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].tagName).toBe('');
			expect(result[0].text()).toBe('This text should be unwrapped twice.');
		}
	}),
	defineParserFixture({
		description: 'handles mixed content with unwrapping',
		input: '<unknown>Text before <p>Paragraph</p> text after</unknown>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result.length).toBeGreaterThanOrEqual(2);
			const paragraphs = result.filter((node) => node.tagName === 'p');
			expect(paragraphs).toHaveLength(1);
			expect(paragraphs[0].text()).toBe('Paragraph');
			const allText = result.map((node) => node.text()).join('');
			expect(allText).toContain('Text before');
			expect(allText).toContain('Paragraph');
			expect(allText).toContain('text after');
		}
	}),
	defineParserFixture({
		description: 'handles complex unwrapping with mixed content',
		input: '<outer><unknown>Before <strong>Bold</strong> after</unknown><p>Paragraph</p></outer>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result.length).toBeGreaterThanOrEqual(2);
			const paragraphs = result.filter((node) => node.tagName === 'p');
			expect(paragraphs).toHaveLength(1);
			expect(paragraphs[0].text()).toBe('Paragraph');

			const strongTags: HTMLNodeInterface[] = [];
			for (const node of result) {
				if (node.tagName === 'strong') {
					strongTags.push(node);
				}
				for (const content of node.content ?? []) {
					if (content.tagName === 'strong') {
						strongTags.push(content);
					}
				}
			}

			expect(strongTags.length).toBeGreaterThanOrEqual(1);
			expect(strongTags[0].text()).toBe('Bold');
			const allText = result.map((node) => node.text()).join('');
			expect(allText).toContain('Before');
			expect(allText).toContain('Bold');
			expect(allText).toContain('after');
			expect(allText).toContain('Paragraph');
		}
	}),
	defineParserFixture({
		description: 'handles mixed known and unknown blocks with nested content',
		input: `
			<article>
				<header>Header text</header>
				<p>Paragraph 1</p>
				<section>
					<h2>Section Title</h2>
					<p>Paragraph 2</p>
				</section>
				<footer>Footer text</footer>
			</article>
		`,
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			const paragraphs = result.filter((node) => node.tagName === 'p');
			const headings = result.filter((node) => node.tagName === 'h2');
			expect(paragraphs).toHaveLength(2);
			expect(headings).toHaveLength(1);
			expect(paragraphs[0].text()).toContain('Paragraph 1');
			expect(paragraphs[1].text()).toContain('Paragraph 2');
			expect(headings[0].text()).toContain('Section Title');
			expect(result.some((node) => node.tagName === '' && !!node.textContent)).toBe(true);
		}
	}),
	defineParserFixture({
		description: 'handles empty tags correctly',
		input: '<unknown></unknown>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result.length).toBeLessThanOrEqual(1);
			if (result.length === 1) {
				expect(result[0].text()).toBe('');
			}
		}
	}),
	defineParserFixture({
		description: 'handles incomplete tag structures',
		input: '<p>This paragraph is not closed <strong>This is bold',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result.length).toBeGreaterThan(0);
			const allText = result.map((node) => node.text()).join('');
			expect(allText).toContain('This paragraph is not closed');
		}
	}),
	defineParserFixture({
		description: 'handles malformed HTML with missing brackets',
		input: '<p>This is valid HTML</p> extra>text outside',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result.length).toBeGreaterThan(0);
			expect(result.map((node) => node.text()).join('')).toContain('This is valid HTML');
		}
	}),
	defineParserFixture({
		description: 'handles invalid nesting of elements',
		input: '<p><strong>Improperly <em>nested</strong> tags</em></p>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result.length).toBeGreaterThan(0);
			expect(result.find((node) => node.tagName === 'p')).toBeDefined();
			const allText = result.map((node) => node.text()).join('');
			expect(allText).toContain('Improperly nested tags');
		}
	}),
	defineParserFixture({
		description: 'preserves unusual whitespace patterns',
		input: '<p>  \n  Text with \t\t  excessive   \n  whitespace  \t  </p>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].tagName).toBe('p');
			expect(result[0].text()).toBe('  \n  Text with \t\t  excessive   \n  whitespace  \t  ');
		}
	}),
	defineParserFixture({
		description: 'handles HTML with mixed case tags',
		input: '<P>Mixed <sTrOnG>case</StRoNg> tags</p>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].tagName.toLowerCase()).toBe('p');
			expect(
				result[0].content.some(
					(content) => content.tagName.toLowerCase() === 'strong' && content.text() === 'case'
				)
			).toBe(true);
		}
	}),
	defineParserFixture({
		description: 'handles interleaved tag structures',
		input: '<p>First <strong>interleaved <em>with</em> content</strong></p>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].tagName).toBe('p');
			expect(result[0].content.length).toBeGreaterThan(1);
			expect(result[0].content.some((content) => content.tagName === 'strong')).toBe(true);
		}
	}),
	defineParserFixture({
		description: 'handles zero-width spaces and invisible characters',
		input: '<p>Text with\u200Bzero-width\u200Bspaces\u200B</p>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].text()).toContain('Text with');
			expect(result[0].text()).toContain('zero-width');
			expect(result[0].text()).toContain('spaces');

			const invisibleNodes = HTMLNode.create(
				'<p>Text\u2060with\u200Cinvisible\u2061chars</p>',
				elementSets
			);
			expect(invisibleNodes).toHaveLength(1);
			expect(invisibleNodes[0].text()).toContain('Text');
			expect(invisibleNodes[0].text()).toContain('with');
			expect(invisibleNodes[0].text()).toContain('invisible');
			expect(invisibleNodes[0].text()).toContain('chars');
		}
	}),
	defineParserFixture({
		description: 'handles duplicate attributes without crashing',
		input: '<p id="first" class="para" id="second">Duplicate attributes</p>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].tagName).toBe('p');
			expect(result[0].attributes).toEqual({ id: 'first', class: 'para' });
			expect(result[0].text()).toBe('Duplicate attributes');
		}
	}),
	defineParserFixture({
		description: 'parses quoted, unquoted, boolean, and entity-decoded attributes',
		input: '<p data-name="Ada &amp; Bob" data-kind=\'person\' draggable=true hidden>Text</p>',
		run: (html) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].attributes).toEqual({
				'data-name': 'Ada & Bob',
				'data-kind': 'person',
				draggable: 'true',
				hidden: ''
			});
		}
	}),
	defineParserFixture({
		description: 'handles deeply nested but valid HTML without stack overflow',
		input: Array.from({ length: 100 }).reduce<string>((html) => `<div>${html}</div>`, 'Text'),
		run: (html: string) => HTMLNode.create(html, elementSets),
		assert: ({ result }) => {
			expect(result.length).toBeGreaterThan(0);
			expect(result.map((node) => node.text()).join('')).toBe('Text');
		}
	})
]);
