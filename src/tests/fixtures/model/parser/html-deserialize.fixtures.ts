import { expect } from 'vitest';

import { Edytor } from '$lib/edytor.svelte.js';
import type { Edytor as EdytorInstance } from '$lib/edytor.svelte.js';
import { parseHtml, validateHtmlMappings } from '$lib/plugins/html/deserialize.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONBlock } from '$lib/utils/json.js';
import { defineFixtures, defineParserFixture } from '../../types.js';

const defaultBlockTypes = [
	'paragraph',
	'heading',
	'quote',
	'unordered-list',
	'ordered-list',
	'list-item',
	'bulleted-list-item',
	'numbered-list-item',
	'divider'
];
const defaultMarkTypes = [
	'bold',
	'italic',
	'underline',
	'strike',
	'code',
	'link',
	'superscript',
	'subscript',
	'highlight'
];
const defaultInlineBlockTypes = ['mention'];

type RegistryOverrides = {
	blocks?: string[];
	marks?: string[];
	inlineBlocks?: string[];
};

const createRegistry = (types: string[]) => new Map(types.map((type) => [type, {}]));

const createParsingEdytor = ({
	blocks = [],
	marks = [],
	inlineBlocks = []
}: RegistryOverrides = {}) =>
	({
		blocks: createRegistry([...defaultBlockTypes, ...blocks]),
		marks: createRegistry([...defaultMarkTypes, ...marks]),
		inlineBlocks: createRegistry([...defaultInlineBlockTypes, ...inlineBlocks])
	}) as unknown as EdytorInstance;

const createExactParsingEdytor = ({
	blocks = defaultBlockTypes,
	marks = defaultMarkTypes,
	inlineBlocks = defaultInlineBlockTypes
}: RegistryOverrides = {}) =>
	({
		blocks: createRegistry(blocks),
		marks: createRegistry(marks),
		inlineBlocks: createRegistry(inlineBlocks)
	}) as unknown as EdytorInstance;

const createRichTextParsingEdytor = () =>
	new Edytor({
		value: { children: [] },
		plugins: [richTextPlugin, mentionPlugin]
	});

type ParseHtmlOptions = Parameters<typeof parseHtml>[1];
type ParserElementResolver = NonNullable<NonNullable<ParseHtmlOptions>['blocks']>[string];
type ParserElementDefinition = NonNullable<ParseHtmlOptions>['blocks'];

const getTextPart = (content: JSONBlock['content'], index: number) => {
	const part = content?.[index];
	if (!part || !('text' in part)) {
		throw new Error(`Expected text content at index ${index}`);
	}
	return part;
};

const getNestedBlock = (block: JSONBlock | undefined, path: number[]) => {
	let current = block;
	for (const index of path) {
		current = current?.children?.[index];
	}
	if (!current) {
		throw new Error(`Expected nested block at path ${path.join('.')}`);
	}
	return current;
};

const runParseHtml = (
	html: string,
	options?: ParseHtmlOptions,
	registryOverrides?: RegistryOverrides
) => parseHtml.call(createParsingEdytor(registryOverrides), html, options);

const runParseHtmlWithoutRegistries = (html: string, options?: ParseHtmlOptions) =>
	parseHtml.call({} as EdytorInstance, html, options);

export const fixtures = defineFixtures([
	defineParserFixture({
		description: 'parses basic HTML into blocks',
		input: '<p>Hello world</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result.length).toBe(1);
			expect(result[0].type).toBe('paragraph');
			expect(result[0].content).toEqual([{ text: 'Hello world' }]);
		}
	}),
	defineParserFixture({
		description: 'parses nested HTML with formatting',
		input: '<p>This is <strong>bold</strong> and <em>italic</em> text</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result.length).toBe(1);
			expect(result[0].type).toBe('paragraph');
			expect(result[0].content).toEqual([
				{ text: 'This is ' },
				{ text: 'bold', marks: { bold: true } },
				{ text: ' and ' },
				{ text: 'italic', marks: { italic: true } },
				{ text: ' text' }
			]);
		}
	}),
	defineParserFixture({
		description: 'maps links to link marks with href and target data',
		input: '<p>Visit <a href="https://example.com?a=1&amp;b=2" target="_blank">Example</a></p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].content).toEqual([
				{ text: 'Visit ' },
				{
					text: 'Example',
					marks: {
						link: {
							href: 'https://example.com?a=1&b=2',
							target: '_blank'
						}
					}
				}
			]);
		}
	}),
	defineParserFixture({
		description: 'handles multiple blocks',
		input: '<p>First paragraph</p><blockquote>A quote</blockquote><p>Last paragraph</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result.map((block) => block.type)).toEqual(['paragraph', 'quote', 'paragraph']);
			expect(result[0].content).toEqual([{ text: 'First paragraph' }]);
			expect(result[1].content).toEqual([{ text: 'A quote' }]);
			expect(result[2].content).toEqual([{ text: 'Last paragraph' }]);
		}
	}),
	defineParserFixture({
		description: 'decodes HTML entities',
		input: '<p>&lt;div&gt; &amp; &quot;quotes&quot;</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(getTextPart(result[0].content, 0).text).toBe('<div> & "quotes"');
		}
	}),
	defineParserFixture({
		description: 'skips script and style tags',
		input: '<p>Before</p><script>var x = 5;</script><p>After</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(2);
			expect(result[0].content).toEqual([{ text: 'Before' }]);
			expect(result[1].content).toEqual([{ text: 'After' }]);
			const styleBlocks = runParseHtml('<p>Start</p><style>.test{color:red;}</style><p>End</p>');
			expect(styleBlocks).toHaveLength(2);
			expect(styleBlocks[0].content).toEqual([{ text: 'Start' }]);
			expect(styleBlocks[1].content).toEqual([{ text: 'End' }]);
		}
	}),
	defineParserFixture({
		description: 'unwraps cite as plain text unless an inline-block mapping is provided',
		input: '<p>Text with <cite>citation</cite> inline</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].content).toEqual([
				{ text: 'Text with ' },
				{ text: 'citation' },
				{ text: ' inline' }
			]);
		}
	}),
	defineParserFixture({
		description: 'handles line breaks',
		input: '<p>Line with<br>break</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].content).toEqual([{ text: 'Line with' }, { text: '\n' }, { text: 'break' }]);
		}
	}),
	defineParserFixture({
		description: 'handles empty input',
		input: '',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('paragraph');
			expect(result[0].content).toEqual([{ text: '' }]);
		}
	}),
	defineParserFixture({
		description: 'handles malformed HTML',
		input: '<p>Unclosed paragraph tag<div>New div</div>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result.length).toBeGreaterThan(0);
			expect(result[0].type).toBe('paragraph');
			expect(
				result.some((block) =>
					block.content?.some(
						(item) => 'text' in item && item.text.includes('Unclosed paragraph tag')
					)
				)
			).toBe(true);
		}
	}),
	defineParserFixture({
		description: 'handles nested block elements',
		input: '<blockquote><p>Nested paragraph</p></blockquote>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('quote');
			expect(result[0].children?.[0]).toMatchObject({
				type: 'paragraph',
				content: [{ text: 'Nested paragraph' }]
			});
		}
	}),
	defineParserFixture({
		description: 'allows customizing tag mappings',
		input: '<div>Custom block</div><span>Custom mark</span><abbr>Custom inline</abbr>',
		run: (html) =>
			runParseHtml(
				html,
				{
					blocks: {
						div: (node) => ({ type: 'custom-block', data: { node } })
					},
					marks: {
						span: () => ({ type: 'custom-mark' })
					},
					inlineBlocks: {
						abbr: (node) => ({ type: 'custom-inline', data: { label: node.text() } })
					}
				},
				{
					blocks: ['custom-block'],
					marks: ['custom-mark'],
					inlineBlocks: ['custom-inline']
				}
			),
		assert: ({ result }) => {
			expect(result[0].type).toBe('custom-block');
			expect(getTextPart(result[0].content, 0).text).toBe('Custom block');
			expect(result[1].type).toBe('$fragment');
			expect(result[1].content?.[0]).toEqual({
				text: 'Custom mark',
				marks: { 'custom-mark': true }
			});
			expect(result[2].type).toBe('$fragment');
			expect(result[2].content?.[0]).toEqual({
				type: 'custom-inline',
				data: { label: 'Custom inline' }
			});
		}
	}),
	defineParserFixture({
		description: 'validates default HTML mappings against registered editor types',
		input: '<h1>Title</h1><blockquote>A quote</blockquote><p><s>Removed</s></p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result[0]).toMatchObject({
				type: 'heading',
				data: { level: 'h1' },
				content: [{ text: 'Title' }]
			});
			expect(result[1]).toMatchObject({
				type: 'quote',
				content: [{ text: 'A quote' }]
			});
			expect(result[2].content?.[0]).toEqual({
				text: 'Removed',
				marks: { strike: true }
			});
		}
	}),
	defineParserFixture({
		description: 'validates every default HTML mapping against registered editor types',
		input:
			'<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6><blockquote>Quote</blockquote><ul><li>Bullet</li></ul><ol><li>Number</li></ol><pre>Pre</pre><hr><p><a href="https://example.com">Link</a><strong>Strong</strong><b>Bold</b><em>Emphasis</em><i>Italic</i><u>Under</u><s>Strike</s><strike>Struck</strike><del>Deleted</del><sup>Sup</sup><sub>Sub</sub><mark>Marked</mark><code>Code</code></p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result.map((block) => block.type)).toEqual([
				'heading',
				'heading',
				'heading',
				'heading',
				'heading',
				'heading',
				'quote',
				'bulleted-list-item',
				'numbered-list-item',
				'paragraph',
				'divider',
				'paragraph'
			]);
			expect(result[7]).toMatchObject({
				type: 'bulleted-list-item',
				content: [{ text: 'Bullet' }]
			});
			expect(result[8]).toMatchObject({
				type: 'numbered-list-item',
				content: [{ text: 'Number' }]
			});

			const serializedContent = JSON.stringify(result);
			expect(serializedContent).toContain('"bold":true');
			expect(serializedContent).toContain('"italic":true');
			expect(serializedContent).toContain('"underline":true');
			expect(serializedContent).toContain('"strike":true');
			expect(serializedContent).toContain('"superscript":true');
			expect(serializedContent).toContain('"subscript":true');
			expect(serializedContent).toContain('"highlight":"yellow"');
			expect(serializedContent).toContain('"code":true');
			expect(serializedContent).toContain('"link":{"href":"https://example.com"}');
		}
	}),
	defineParserFixture({
		description: 'validates default mappings against the actual rich text plugin registry',
		input:
			'<h1>Title</h1><blockquote>Quote</blockquote><ul><li>Bullet</li></ul><p><a href="https://example.com">Link</a></p><hr>',
		run: (html) => parseHtml.call(createRichTextParsingEdytor(), html),
		assert: ({ result }) => {
			expect(result.map((block) => block.type)).toEqual([
				'heading',
				'quote',
				'bulleted-list-item',
				'paragraph',
				'divider'
			]);
			expect(result[2]).toMatchObject({
				type: 'bulleted-list-item',
				content: [{ text: 'Bullet' }]
			});
			expect(result[3].content?.[0]).toEqual({
				text: 'Link',
				marks: { link: { href: 'https://example.com' } }
			});
		}
	}),
	defineParserFixture({
		description: 'validates user HTML mappings against registered editor types',
		input: '<div>Custom quote</div><span>Custom mark</span><p><abbr>Custom inline</abbr></p>',
		run: (html) =>
			runParseHtml(html, {
				blocks: {
					div: () => ({ type: 'quote' })
				},
				marks: {
					span: () => ({ type: 'bold' })
				},
				inlineBlocks: {
					abbr: () => ({ type: 'mention', data: { name: 'Ada' } })
				}
			}),
		assert: ({ result }) => {
			expect(result[0]).toMatchObject({
				type: 'quote',
				content: [{ text: 'Custom quote' }]
			});
			expect(result[1].content?.[0]).toEqual({
				text: 'Custom mark',
				marks: { bold: true }
			});
			expect(result[2].content?.[0]).toEqual({
				type: 'mention',
				data: { name: 'Ada' }
			});
		}
	}),
	defineParserFixture({
		description: 'normalizes user HTML mapping tag names before parsing',
		input: '<div>Uppercase block</div><p><abbr>Uppercase inline</abbr></p>',
		run: (html) =>
			runParseHtml(html, {
				blocks: {
					DIV: () => ({ type: 'quote' })
				},
				inlineBlocks: {
					ABBR: () => ({ type: 'mention', data: { name: 'Ada' } })
				}
			}),
		assert: ({ result }) => {
			expect(result[0]).toMatchObject({
				type: 'quote',
				content: [{ text: 'Uppercase block' }]
			});
			expect(result[1].content?.[0]).toEqual({
				type: 'mention',
				data: { name: 'Ada' }
			});
		}
	}),
	defineParserFixture({
		description: 'exposes parsed attributes to user-defined HTML mappings',
		input: '<p>Hello <abbr data-name="Ada" title="Ada Lovelace">Ada</abbr></p>',
		run: (html) =>
			runParseHtml(html, {
				inlineBlocks: {
					abbr: (node) => ({
						type: 'mention',
						data: {
							name: node.attributes['data-name'],
							title: node.attributes.title
						}
					})
				}
			}),
		assert: ({ result }) => {
			expect(result[0].content).toEqual([
				{ text: 'Hello ' },
				{ type: 'mention', data: { name: 'Ada', title: 'Ada Lovelace' } }
			]);
		}
	}),
	defineParserFixture({
		description: 'merges user HTML mappings with the default mappings',
		input: '<div>Custom quote</div><p><strong>Default bold</strong></p>',
		run: (html) =>
			runParseHtml(html, {
				blocks: {
					div: () => ({ type: 'quote' })
				}
			}),
		assert: ({ result }) => {
			expect(result[0]).toMatchObject({
				type: 'quote',
				content: [{ text: 'Custom quote' }]
			});
			expect(result[1]).toMatchObject({
				type: 'paragraph',
				content: [{ text: 'Default bold', marks: { bold: true } }]
			});
		}
	}),
	defineParserFixture({
		description: 'rejects user HTML mappings that point to missing editor types',
		input: 'unused',
		run: () => ({
			missingBlock: () =>
				runParseHtml('<div>Missing block</div>', {
					blocks: {
						div: () => ({ type: 'missing-block' })
					}
				}),
			missingMark: () =>
				runParseHtml('<span>Missing mark</span>', {
					marks: {
						span: () => ({ type: 'missing-mark' })
					}
				}),
			missingInline: () =>
				runParseHtml('<p><abbr>Missing inline</abbr></p>', {
					inlineBlocks: {
						abbr: () => ({ type: 'missing-inline' })
					}
				})
		}),
		assert: ({ result }) => {
			expect(result.missingBlock).toThrow('missing-block');
			expect(result.missingMark).toThrow('missing-mark');
			expect(result.missingInline).toThrow('missing-inline');
		}
	}),
	defineParserFixture({
		description: 'rejects user HTML mappings that point to existing types in the wrong registry',
		input: 'unused',
		run: () => ({
			blockMappedToMark: () =>
				runParseHtml('<div>Wrong registry</div>', {
					blocks: {
						div: () => ({ type: 'bold' })
					}
				}),
			markMappedToBlock: () =>
				runParseHtml('<span>Wrong registry</span>', {
					marks: {
						span: () => ({ type: 'paragraph' })
					}
				}),
			inlineMappedToBlock: () =>
				runParseHtml('<p><abbr>Wrong registry</abbr></p>', {
					inlineBlocks: {
						abbr: () => ({ type: 'paragraph' })
					}
				})
		}),
		assert: ({ result }) => {
			expect(result.blockMappedToMark).toThrow(
				'HTML <div> blocks mapping returned "bold", but that type is not registered on the editor'
			);
			expect(result.markMappedToBlock).toThrow(
				'HTML <span> marks mapping returned "paragraph", but that type is not registered on the editor'
			);
			expect(result.inlineMappedToBlock).toThrow(
				'HTML <abbr> inlineBlocks mapping returned "paragraph", but that type is not registered on the editor'
			);
		}
	}),
	defineParserFixture({
		description: 'rejects actual user HTML mapping results that point to missing editor types',
		input: 'unused',
		run: () => ({
			missingBlock: () =>
				runParseHtml('<div data-type="missing-block">Missing block</div>', {
					blocks: {
						div: (node) => ({
							type: node.attributes['data-type'] || 'paragraph'
						})
					}
				}),
			missingMark: () =>
				runParseHtml('<span data-type="missing-mark">Missing mark</span>', {
					marks: {
						span: (node) => ({
							type: node.attributes['data-type'] || 'bold'
						})
					}
				}),
			missingInline: () =>
				runParseHtml('<p><abbr data-type="missing-inline">Missing inline</abbr></p>', {
					inlineBlocks: {
						abbr: (node) => ({
							type: node.attributes['data-type'] || 'mention'
						})
					}
				})
		}),
		assert: ({ result }) => {
			expect(result.missingBlock).toThrow('missing-block');
			expect(result.missingMark).toThrow('missing-mark');
			expect(result.missingInline).toThrow('missing-inline');
		}
	}),
	defineParserFixture({
		description: 'rejects malformed user HTML mapping entries',
		input: 'unused',
		run: () => ({
			malformedBlock: () =>
				runParseHtml('<p>Paragraph only</p>', {
					blocks: {
						div: null as unknown as ParserElementResolver
					}
				}),
			malformedMark: () =>
				runParseHtml('<p>Paragraph only</p>', {
					marks: {
						span: null as unknown as ParserElementResolver
					}
				}),
			malformedInline: () =>
				runParseHtml('<p>Paragraph only</p>', {
					inlineBlocks: {
						abbr: null as unknown as ParserElementResolver
					}
				}),
			emptyTagName: () =>
				runParseHtml('<p>Paragraph only</p>', {
					blocks: {
						' ': () => ({ type: 'quote' })
					}
				}),
			duplicateTagName: () =>
				runParseHtml('<p>Paragraph only</p>', {
					blocks: {
						div: () => ({ type: 'quote' }),
						DIV: () => ({ type: 'paragraph' })
					}
				}),
			malformedBlockGroup: () =>
				runParseHtml('<p>Paragraph only</p>', {
					blocks: null as unknown as ParserElementDefinition
				}),
			malformedMarkGroup: () =>
				runParseHtml('<p>Paragraph only</p>', {
					marks: null as unknown as ParserElementDefinition
				}),
			malformedInlineGroup: () =>
				runParseHtml('<p>Paragraph only</p>', {
					inlineBlocks: null as unknown as ParserElementDefinition
				})
		}),
		assert: ({ result }) => {
			expect(result.malformedBlock).toThrow('HTML <div> blocks mapping must be a function');
			expect(result.malformedMark).toThrow('HTML <span> marks mapping must be a function');
			expect(result.malformedInline).toThrow('HTML <abbr> inlineBlocks mapping must be a function');
			expect(result.emptyTagName).toThrow('HTML mapping tag names must be non-empty');
			expect(result.duplicateTagName).toThrow('Duplicate HTML mapping for <div>');
			expect(result.malformedBlockGroup).toThrow('HTML blocks mappings must be an object');
			expect(result.malformedMarkGroup).toThrow('HTML marks mappings must be an object');
			expect(result.malformedInlineGroup).toThrow('HTML inlineBlocks mappings must be an object');
		}
	}),
	defineParserFixture({
		description: 'rejects default HTML mappings that point to missing editor types',
		input: 'unused',
		run: () => ({
			missingParagraph: () =>
				parseHtml.call(
					createExactParsingEdytor({
						blocks: defaultBlockTypes.filter((type) => type !== 'paragraph')
					}),
					'<p>Missing paragraph</p>'
				),
			missingHeading: () =>
				parseHtml.call(
					createExactParsingEdytor({
						blocks: defaultBlockTypes.filter((type) => type !== 'heading')
					}),
					'<h1>Missing heading</h1>'
				),
			missingQuote: () =>
				parseHtml.call(
					createExactParsingEdytor({
						blocks: defaultBlockTypes.filter((type) => type !== 'quote')
					}),
					'<blockquote>Missing quote</blockquote>'
				),
			missingDivider: () =>
				parseHtml.call(
					createExactParsingEdytor({
						blocks: defaultBlockTypes.filter((type) => type !== 'divider')
					}),
					'<hr>'
				),
			missingBold: () =>
				parseHtml.call(
					createExactParsingEdytor({
						marks: defaultMarkTypes.filter((type) => type !== 'bold')
					}),
					'<p><strong>Missing bold</strong></p>'
				),
			missingItalic: () =>
				parseHtml.call(
					createExactParsingEdytor({
						marks: defaultMarkTypes.filter((type) => type !== 'italic')
					}),
					'<p><em>Missing italic</em></p>'
				),
			missingUnderline: () =>
				parseHtml.call(
					createExactParsingEdytor({
						marks: defaultMarkTypes.filter((type) => type !== 'underline')
					}),
					'<p><u>Missing underline</u></p>'
				),
			missingStrike: () =>
				parseHtml.call(
					createExactParsingEdytor({
						marks: defaultMarkTypes.filter((type) => type !== 'strike')
					}),
					'<p><s>Missing strike</s></p>'
				),
			missingCode: () =>
				parseHtml.call(
					createExactParsingEdytor({
						marks: defaultMarkTypes.filter((type) => type !== 'code')
					}),
					'<p><code>Missing code</code></p>'
				),
			missingSuperscript: () =>
				parseHtml.call(
					createExactParsingEdytor({
						marks: defaultMarkTypes.filter((type) => type !== 'superscript')
					}),
					'<p><sup>Missing superscript</sup></p>'
				),
			missingSubscript: () =>
				parseHtml.call(
					createExactParsingEdytor({
						marks: defaultMarkTypes.filter((type) => type !== 'subscript')
					}),
					'<p><sub>Missing subscript</sub></p>'
				),
			missingHighlight: () =>
				parseHtml.call(
					createExactParsingEdytor({
						marks: defaultMarkTypes.filter((type) => type !== 'highlight')
					}),
					'<p><mark>Missing highlight</mark></p>'
				),
			missingLink: () =>
				parseHtml.call(
					createExactParsingEdytor({
						marks: defaultMarkTypes.filter((type) => type !== 'link')
					}),
					'<p><a href="https://example.com">Missing link</a></p>'
				),
			missingBulletedListItem: () =>
				parseHtml.call(
					createExactParsingEdytor({
						blocks: defaultBlockTypes.filter((type) => type !== 'bulleted-list-item')
					}),
					'<ul><li>Missing list item</li></ul>'
				),
			missingNumberedListItem: () =>
				parseHtml.call(
					createExactParsingEdytor({
						blocks: defaultBlockTypes.filter((type) => type !== 'numbered-list-item')
					}),
					'<ol><li>Missing list item</li></ol>'
				)
		}),
		assert: ({ result }) => {
			expect(result.missingParagraph).toThrow('paragraph');
			expect(result.missingHeading).toThrow('heading');
			expect(result.missingQuote).toThrow('quote');
			expect(result.missingDivider).toThrow('divider');
			expect(result.missingBold).toThrow('bold');
			expect(result.missingItalic).toThrow('italic');
			expect(result.missingUnderline).toThrow('underline');
			expect(result.missingStrike).toThrow('strike');
			expect(result.missingCode).toThrow('code');
			expect(result.missingSuperscript).toThrow('superscript');
			expect(result.missingSubscript).toThrow('subscript');
			expect(result.missingHighlight).toThrow('highlight');
			expect(result.missingLink).toThrow('link');
			expect(result.missingBulletedListItem).toThrow('bulleted-list-item');
			expect(result.missingNumberedListItem).toThrow('numbered-list-item');
		}
	}),
	defineParserFixture({
		description: 'rejects unused default and user mappings that point to missing editor types',
		input: 'unused',
		run: () => ({
			unusedDefaultMapping: () =>
				parseHtml.call(
					createExactParsingEdytor({
						blocks: defaultBlockTypes.filter((type) => type !== 'heading')
					}),
					'<p>Paragraph only</p>'
				),
			unusedUserBlockMapping: () =>
				runParseHtml('<p>Paragraph only</p>', {
					blocks: {
						section: () => ({ type: 'missing-block' })
					}
				}),
			unusedUserMarkMapping: () =>
				runParseHtml('<p>Paragraph only</p>', {
					marks: {
						span: () => ({ type: 'missing-mark' })
					}
				}),
			unusedUserInlineMapping: () =>
				runParseHtml('<p>Paragraph only</p>', {
					inlineBlocks: {
						abbr: () => ({ type: 'missing-inline' })
					}
				}),
			unusedUserOverrideOfDefaultBlockMapping: () =>
				runParseHtml('<p>Paragraph only</p>', {
					blocks: {
						h1: () => ({ type: 'missing-heading' })
					}
				}),
			unusedUserOverrideOfDefaultMarkMapping: () =>
				runParseHtml('<p>Paragraph only</p>', {
					marks: {
						strong: () => ({ type: 'missing-bold' })
					}
				})
		}),
		assert: ({ result }) => {
			expect(result.unusedDefaultMapping).toThrow('heading');
			expect(result.unusedUserBlockMapping).toThrow('missing-block');
			expect(result.unusedUserMarkMapping).toThrow('missing-mark');
			expect(result.unusedUserInlineMapping).toThrow('missing-inline');
			expect(result.unusedUserOverrideOfDefaultBlockMapping).toThrow('missing-heading');
			expect(result.unusedUserOverrideOfDefaultMarkMapping).toThrow('missing-bold');
		}
	}),
	defineParserFixture({
		description: 'requires editor registries before accepting HTML mappings',
		input: 'unused',
		run: () => () => runParseHtmlWithoutRegistries('<p>Unvalidated</p>'),
		assert: ({ result }) => {
			expect(result).toThrow('registry is unavailable');
		}
	}),
	defineParserFixture({
		description: 'validates default and user HTML mappings without parsing a matching tag',
		input: 'unused',
		run: () => ({
			validDefaultMappings: () => validateHtmlMappings.call(createRichTextParsingEdytor()),
			missingDefaultMapping: () =>
				validateHtmlMappings.call(
					createExactParsingEdytor({
						blocks: defaultBlockTypes.filter((type) => type !== 'heading')
					})
				),
			missingUserMapping: () =>
				validateHtmlMappings.call(createParsingEdytor(), {
					blocks: {
						section: () => ({ type: 'missing-section' })
					}
				}),
			missingUserOverrideOfDefaultMapping: () =>
				validateHtmlMappings.call(createParsingEdytor(), {
					blocks: {
						h1: () => ({ type: 'missing-heading' })
					}
				})
		}),
		assert: ({ result }) => {
			expect(result.validDefaultMappings).not.toThrow();
			expect(result.missingDefaultMapping).toThrow('heading');
			expect(result.missingUserMapping).toThrow('missing-section');
			expect(result.missingUserOverrideOfDefaultMapping).toThrow('missing-heading');
		}
	}),
	defineParserFixture({
		description: 'validates parent-sensitive list mappings without parsing a matching tag',
		input: 'unused',
		run: () => ({
			missingDefaultListItemBranch: () =>
				validateHtmlMappings.call(
					createExactParsingEdytor({
						blocks: defaultBlockTypes.filter((type) => type !== 'numbered-list-item')
					}),
					{
						blocks: {
							ol: () => ({ type: 'ordered-list' })
						}
					}
				),
			missingUserListItemBranch: () =>
				validateHtmlMappings.call(createParsingEdytor(), {
					blocks: {
						li: (node) => ({
							type: node.parent?.tagName === 'ol' ? 'missing-numbered-item' : 'list-item'
						})
					}
				})
		}),
		assert: ({ result }) => {
			expect(result.missingDefaultListItemBranch).toThrow('numbered-list-item');
			expect(result.missingUserListItemBranch).toThrow('missing-numbered-item');
		}
	}),
	defineParserFixture({
		description: 'handles nested marks correctly',
		input: '<p><strong><em>Bold and italic</em></strong> text</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].content?.[0]).toEqual({
				text: 'Bold and italic',
				marks: { italic: true, bold: true }
			});
			expect(getTextPart(result[0].content, 1).text).toBe(' text');
		}
	}),
	defineParserFixture({
		description: 'handles undefined or unknown HTML elements',
		input: '<p>Text with <unknown-element>unknown tag</unknown-element> inside</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].content).toEqual([
				{ text: 'Text with ' },
				{ text: 'unknown tag' },
				{ text: ' inside' }
			]);
		}
	}),
	defineParserFixture({
		description: 'handles deeply nested content correctly',
		input:
			'<div><blockquote><ul><li><p><strong><em>Deeply</em> <u>nested</u></strong> content</p></li></ul></blockquote></div>',
		run: (html) =>
			runParseHtml(html, {
				blocks: {
					ul: (node) => ({ type: 'unordered-list', data: { node } }),
					li: (node) => ({ type: 'list-item', data: { node } }),
					p: () => ({ type: 'paragraph' }),
					blockquote: () => ({ type: 'quote' })
				}
			}),
		assert: ({ result }) => {
			const outerBlock = result[0];
			expect(outerBlock.type).toBe('quote');
			expect(outerBlock.children?.[0]?.type).toBe('unordered-list');
			expect(outerBlock.children?.[0]?.children?.[0]?.type).toBe('list-item');
			const paragraph = getNestedBlock(outerBlock, [0, 0, 0]);
			expect(paragraph.type).toBe('paragraph');
			expect(paragraph.content?.[0]).toEqual({
				text: 'Deeply',
				marks: { bold: true, italic: true }
			});
			expect(paragraph.content?.[1]).toEqual({ text: ' ', marks: { bold: true } });
			expect(paragraph.content?.[2]).toEqual({
				text: 'nested',
				marks: { underline: true, bold: true }
			});
			expect(getTextPart(paragraph.content, 3).text).toBe(' content');
		}
	}),
	defineParserFixture({
		description: 'handles mixed content with both block and inline elements',
		input: `
			<div>
				<h1>Title</h1>
				<p>Text with <span>inline</span> and <strong><em>nested inline</em></strong> elements</p>
				<blockquote>
					Quote with <a href="https://example.com">link</a>
				</blockquote>
			</div>
		`,
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			const title = result.find(
				(block) =>
					block.type === 'heading-1' ||
					block.content?.some((item) => 'text' in item && item.text.includes('Title'))
			);
			const paragraph = result.find(
				(block) =>
					block.type === 'paragraph' &&
					block.content?.some((item) => 'text' in item && item.text.includes('Text with'))
			);
			const quote = result.find((block) => block.type === 'quote');
			expect(title).toBeDefined();
			expect(paragraph).toBeDefined();
			expect(quote).toBeDefined();
			expect(
				quote?.content?.some(
					(item) =>
						('type' in item && item.type === 'link') ||
						('text' in item && item.text.includes('link'))
				)
			).toBe(true);
		}
	}),
	defineParserFixture({
		description: 'handles empty and whitespace-only elements',
		input: '<p></p><div>   </div><span></span><blockquote>  \n  </blockquote>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result.length).toBeGreaterThan(0);
			for (const block of result) {
				if (block.content?.length) {
					expect(
						block.content.every(
							(item) => !('text' in item) || item.text === '' || item.text.trim() === ''
						)
					).toBe(true);
				}
			}
		}
	}),
	defineParserFixture({
		description: 'handles HTML with comments',
		input: '<p>Before<!-- This is a comment -->After</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].content).toEqual([{ text: 'BeforeAfter' }]);
		}
	}),
	defineParserFixture({
		description: 'handles HTML beginning with a text string',
		input: 'Before<p>Content</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(2);
			expect(result[0]).toMatchObject({ type: '$fragment', content: [{ text: 'Before' }] });
			expect(result[1]).toMatchObject({ type: 'paragraph', content: [{ text: 'Content' }] });
		}
	}),
	defineParserFixture({
		description: 'handles self-closing tags correctly',
		input:
			'<p>Text with <img src="image.jpg" alt="An image"/> and <input type="text"/> elements</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(
				result[0].content?.some((item) => 'text' in item && item.text.includes('elements'))
			).toBe(true);
		}
	}),
	defineParserFixture({
		description: 'handles numeric and named character references',
		input: '<p>Special chars: &#169; copyright, &#x2665; heart, &euro; euro</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			const text = getTextPart(result[0].content, 0).text;
			expect(text).toContain('© copyright');
			expect(text).toContain('♥ heart');
			expect(text).toContain('€ euro');
		}
	}),
	defineParserFixture({
		description: 'handles HTML ending with a text string',
		input: '<p>Content</p>After',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('paragraph');
			expect(result[0].content).toEqual([{ text: 'Content' }, { text: 'After' }]);
		}
	}),
	defineParserFixture({
		description: 'handles HTML with both leading and trailing text',
		input: 'Before<p>Content</p>After',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(2);
			expect(result[0]).toMatchObject({ type: '$fragment', content: [{ text: 'Before' }] });
			expect(result[1]).toMatchObject({
				type: 'paragraph',
				content: [{ text: 'Content' }, { text: 'After' }]
			});
		}
	}),
	defineParserFixture({
		description: 'handles HTML with leading marks',
		input: '<strong><em>Before</em></strong><p>Content</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(2);
			expect(result[0]).toMatchObject({
				type: '$fragment',
				content: [{ text: 'Before', marks: { italic: true, bold: true } }]
			});
			expect(result[1]).toMatchObject({ type: 'paragraph', content: [{ text: 'Content' }] });
		}
	}),
	defineParserFixture({
		description: 'handles HTML with both leading marks and trailing text',
		input: '<strong><em>Before</em></strong><p>Content</p>After',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(2);
			expect(result[0]).toMatchObject({
				type: '$fragment',
				content: [{ text: 'Before', marks: { italic: true, bold: true } }]
			});
			expect(result[1]).toMatchObject({
				type: 'paragraph',
				content: [{ text: 'Content' }, { text: 'After' }]
			});
		}
	}),
	defineParserFixture({
		description: 'handles HTML ending with trailing marks',
		input: '<p>Content</p><strong><em>After</em></strong>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				type: 'paragraph',
				content: [{ text: 'Content' }, { text: 'After', marks: { italic: true, bold: true } }]
			});
		}
	}),
	defineParserFixture({
		description: 'handles HTML with both leading and trailing marks',
		input: '<strong>Before</strong><p>Content</p><em>After</em>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(2);
			expect(result[0]).toMatchObject({
				type: '$fragment',
				content: [{ text: 'Before', marks: { bold: true } }]
			});
			expect(result[1]).toMatchObject({
				type: 'paragraph',
				content: [{ text: 'Content' }, { text: 'After', marks: { italic: true } }]
			});
		}
	}),
	defineParserFixture({
		description: 'handles incomplete tag structures when deserializing',
		input: '<p>This paragraph is not closed <strong>This is bold',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result.length).toBeGreaterThan(0);
			expect(result[0].type).toBe('paragraph');
			const content = result[0].content ?? [];
			const hasRegular = content.some(
				(item) =>
					'text' in item && item.text.includes('This paragraph is not closed') && !item.marks
			);
			const hasBold = content.some(
				(item) => 'text' in item && item.text.includes('This is bold') && item.marks?.bold
			);
			expect(hasRegular || hasBold).toBe(true);
		}
	}),
	defineParserFixture({
		description: 'handles malformed HTML with missing brackets when deserializing',
		input: '<p>This is valid HTML</p><strong>Text outside</strong>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			const allText = result
				.flatMap(
					(block) =>
						block.content
							?.filter((item) => 'text' in item)
							.map((item) => ('text' in item ? item.text : '')) ?? []
				)
				.join(' ');
			expect(allText).toContain('This is valid HTML');
		}
	}),
	defineParserFixture({
		description: 'handles invalid nesting of elements when deserializing',
		input: '<p><strong>Improperly <em>nested</strong> tags</em></p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('paragraph');
			const content = result[0].content ?? [];
			expect(content.map((item) => ('text' in item ? item.text : '')).join('')).toContain(
				'Improperly nested tags'
			);
			expect(content.some((item) => 'text' in item && !!item.marks)).toBe(true);
		}
	}),
	defineParserFixture({
		description: 'preserves unusual whitespace patterns when deserializing',
		input: '<p>  \n  Text with \t\t  excessive   \n  whitespace  \t  </p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(getTextPart(result[0].content, 0).text).toBe(
				'  \n  Text with \t\t  excessive   \n  whitespace  \t  '
			);
		}
	}),
	defineParserFixture({
		description: 'handles interleaved tag structures when deserializing',
		input: '<p>First <strong>paragraph with <em>formatting</em></strong>.</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('paragraph');
			const content = result[0].content ?? [];
			expect(content.some((item) => 'text' in item && !!item.marks)).toBe(true);
			const paragraphText = content.map((item) => ('text' in item ? item.text : '')).join('');
			expect(paragraphText).toContain('First');
			expect(paragraphText).toContain('paragraph with');
			expect(paragraphText).toContain('formatting');
		}
	}),
	defineParserFixture({
		description: 'handles deeply nested but valid HTML without stack overflow when deserializing',
		input: Array.from({ length: 100 }).reduce<string>((html) => `<div>${html}</div>`, 'Text'),
		run: (html: string) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result.length).toBeGreaterThan(0);
			expect(
				result.some((block) =>
					block.content?.some((item) => 'text' in item && item.text.includes('Text'))
				)
			).toBe(true);
		}
	}),
	defineParserFixture({
		description: 'gracefully handles document fragments with multiple top-level elements',
		input: '<p>First paragraph</p><strong>Bold text</strong><p>Second paragraph</p>',
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result.map((block) => block.type)).toEqual(['paragraph', '$fragment', 'paragraph']);
			expect(getTextPart(result[0].content, 0).text).toBe('First paragraph');
			expect(result[1].content?.[0]).toEqual({ text: 'Bold text', marks: { bold: true } });
			expect(getTextPart(result[2].content, 0).text).toBe('Second paragraph');
		}
	}),
	defineParserFixture({
		description: 'handles HTML copied from complex sources like websites',
		input: `
			<h1>Page Title</h1>
			<p>Article content with <strong>formatting</strong>.</p>
			<figure>
				<img src="image.jpg" alt="Image description">
				<figcaption>Figure caption</figcaption>
			</figure>
			<p>Footer content</p>
		`,
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			const collectChildTexts = (children: any[] | undefined): string[] => {
				if (!children) {
					return [];
				}
				return children.flatMap((child) => {
					const own =
						child.content
							?.filter(
								(item: unknown) => typeof item === 'object' && item !== null && 'text' in item
							)
							.map((item: any) => item.text) ?? [];
					return [...own, ...collectChildTexts(child.children)];
				});
			};

			const allText = result
				.flatMap((block) => {
					const own =
						block.content
							?.filter((item) => 'text' in item)
							.map((item) => ('text' in item ? item.text : '')) ?? [];
					return [...own, ...collectChildTexts(block.children)];
				})
				.join(' ');

			expect(allText).toContain('Page Title');
			expect(allText).toContain('Article content with');
			expect(allText).toContain('formatting');
			expect(allText).toContain('Figure caption');
			expect(allText).toContain('Footer content');
		}
	}),
	defineParserFixture({
		description: 'handles HTML with mixed content and unexpected structures',
		input: `
			Text outside any tag
			<div>
				<!-- Comment that should be ignored -->
				<p>Paragraph with <nonexistent>unknown tag</nonexistent></p>
				Text directly in div
				<script>This should be ignored</script>
				<style>This should also be ignored</style>
				<p>Another paragraph</p>
			</div>
			More text outside
		`,
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result.length).toBeGreaterThan(2);
			const allText = result
				.flatMap(
					(block) =>
						block.content
							?.filter((item) => 'text' in item)
							.map((item) => ('text' in item ? item.text : '')) ?? []
				)
				.join(' ');
			expect(allText).toContain('Text outside any tag');
			expect(allText).toContain('Paragraph with');
			expect(allText).toContain('unknown tag');
			expect(allText).toContain('Another paragraph');
			expect(allText).not.toContain('This should be ignored');
			expect(allText).not.toContain('This should also be ignored');
		}
	}),
	defineParserFixture({
		description: 'handles nested identical elements correctly',
		input: `
			<p>First paragraph</p>
			<div>
				Outer div
				<div>Inner div</div>
			</div>
			<p>Last paragraph</p>
		`,
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			expect(result.length).toBeGreaterThan(2);
			const allText = result
				.flatMap(
					(block) =>
						block.content
							?.filter((item) => 'text' in item)
							.map((item) => ('text' in item ? item.text : '')) ?? []
				)
				.join(' ');
			expect(allText).toContain('First paragraph');
			expect(allText).toContain('Outer div');
			expect(allText).toContain('Inner div');
			expect(allText).toContain('Last paragraph');
		}
	}),
	defineParserFixture({
		description: 'ignores head content while preserving body content',
		input: `
			<!DOCTYPE html>
			<html>
				<head>
					<title>This title should be ignored</title>
					<meta name="description" content="This description should be ignored">
					<style>.ignored-style { color: red; }</style>
					<script>console.log("This script should be ignored");</script>
					<link rel="stylesheet" href="ignored.css">
					<base href="https://example.com/">
				</head>
				<body>
					<h1>This heading should be preserved</h1>
					<p>This paragraph should be preserved</p>
				</body>
			</html>
		`,
		run: (html) => runParseHtml(html),
		assert: ({ result }) => {
			const serialized = JSON.stringify(result);
			expect(serialized).toContain('This heading should be preserved');
			expect(serialized).toContain('This paragraph should be preserved');
			expect(serialized).not.toContain('This title should be ignored');
			expect(serialized).not.toContain('This description should be ignored');
			expect(serialized).not.toContain('ignored-style');
			expect(serialized).not.toContain('This script should be ignored');
		}
	})
]);
