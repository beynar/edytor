/**
 * `edytor/export`: `toHTML`, `toMarkdown`, `fromHTML` and `textToBlocks`
 * over the bundled kinds' forms (site `editor/import-export`). Expected
 * values are written from the documented forms, never from a run; the
 * round trips read a corpus back through the other direction.
 */
import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOMParser as LinkedomParser } from 'linkedom';
import { JSDOM } from 'jsdom';
import {
	bundledForms,
	escapeHtml,
	fromHTML,
	fromMarkdown,
	mdxComponent,
	textToBlocks,
	type MarkdownIssue,
	toHTML,
	toMarkdown,
	type BlockForms,
	type HtmlParser
} from '$lib/export/index.js';
import { tableBlock } from '$lib/crdt/tables.js';
import type { JSONBlock } from '$lib/utils/json.js';

const linkedom = LinkedomParser as unknown as HtmlParser;
const jsdom = new JSDOM('').window.DOMParser as unknown as HtmlParser;
const p = (...content: JSONBlock['content'] & object) => ({ type: 'paragraph', content });

describe('toHTML', () => {
	test('each kind by its form; a run of list items in its list; marks by their tags', () => {
		expect(
			toHTML({
				children: [
					{ type: 'heading', data: { level: 'h2' }, content: [{ text: 'Title' }] },
					p({ text: 'a ' }, { text: 'b', marks: { bold: true, italic: true } }),
					{ type: 'bulleted-list-item', content: [{ text: 'x' }] },
					{ type: 'bulleted-list-item', content: [{ text: 'y' }] },
					{ type: 'numbered-list-item', content: [{ text: 'one' }] },
					{ type: 'divider', content: [] }
				]
			})
		).toBe(
			'<h2>Title</h2><p>a <em><strong>b</strong></em></p><ul><li>x</li><li>y</li></ul><ol><li>one</li></ol><hr>'
		);
	});

	test('a code block is one pre with its language; a table its rows, the header row th', () => {
		expect(
			toHTML([
				{
					type: 'code',
					data: { language: 'ts' },
					content: [],
					children: [
						{ type: 'codeLine', content: [{ text: 'let a = <b>' }] },
						{ type: 'codeLine', content: [{ text: 'b()' }] }
					]
				},
				tableBlock({
					cells: [
						['A', 'B'],
						['1', '2']
					],
					headerRow: true
				})
			])
		).toBe(
			'<pre data-language="ts"><code class="language-ts">let a = &lt;b&gt;\nb()</code></pre>' +
				'<table><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>'
		);
	});

	test('ids and empty data are never written; values are escaped', () => {
		expect(
			toHTML([{ type: 'paragraph', id: 'b_1', data: {}, content: [{ text: '<script>&' }] }])
		).toBe('<p>&lt;script&gt;&amp;</p>');
	});

	test('a javascript: link exports as an inert anchor; an unsafe image source as none', () => {
		expect(
			toHTML([
				p({ text: 'x', marks: { link: { href: 'javascript:alert(1)' } } }),
				{ type: 'image', data: { src: 'javascript:alert(1)' }, content: [] }
			])
		).toBe('<p><a>x</a></p><figure><figcaption></figcaption></figure>');
	});

	test('a custom kind plugs in through the same record fields', () => {
		const callout: BlockForms = {
			html: (block, content) =>
				`<aside data-tone="${escapeHtml(String(block.data?.tone))}">${content}</aside>`,
			markdown: (block, content) => `:::${block.data?.tone}\n${content}\n:::`
		};
		const kinds = { blocks: { ...bundledForms.blocks, banner: callout } };
		const doc = [{ type: 'banner', data: { tone: 'info' }, content: [{ text: 'Hi' }] }];
		expect(toHTML(doc, { kinds })).toBe('<aside data-tone="info">Hi</aside>');
		expect(toMarkdown(doc, { kinds })).toBe(':::info\nHi\n:::\n');
	});

	test('a view (its records as maps) is read as is', () => {
		const view = {
			blocks: new Map([['paragraph', { html: 'section' } as BlockForms]]),
			marks: new Map(),
			inlineBlocks: new Map()
		};
		expect(toHTML([p({ text: 'x' })], { kinds: view })).toBe('<section>x</section>');
	});
});

describe('toMarkdown', () => {
	const md = (blocks: JSONBlock[]) => toMarkdown({ children: blocks });

	test('headings, lists nested, to-dos, quotes, dividers', () => {
		expect(
			md([
				{ type: 'heading', data: { level: 'h1' }, content: [{ text: 'T' }] },
				{
					type: 'bulleted-list-item',
					content: [{ text: 'a' }],
					children: [{ type: 'bulleted-list-item', content: [{ text: 'b' }] }]
				},
				{ type: 'bulleted-list-item', content: [{ text: 'c' }] },
				{ type: 'numbered-list-item', content: [{ text: 'one' }] },
				{ type: 'numbered-list-item', content: [{ text: 'two' }] },
				{ type: 'todo-item', data: { checked: true }, content: [{ text: 'done' }] },
				{ type: 'quote', content: [{ text: 'said' }] },
				{ type: 'divider', content: [] }
			])
		).toBe('# T\n\n- a\n  - b\n- c\n1. one\n2. two\n- [x] done\n\n> said\n\n---\n');
	});

	test('marks nest: bold italic, a bold link, code; an unsafe link is its text', () => {
		expect(
			md([
				p(
					{ text: 'x', marks: { bold: true, italic: true } },
					{ text: ' ' },
					{ text: 'link', marks: { bold: true, link: { href: 'https://x.dev' } } },
					{ text: ' ' },
					{ text: 'a*b', marks: { code: true } },
					{ text: ' ' },
					{ text: 'bad', marks: { link: { href: 'javascript:alert(1)' } } },
					{ text: ' ' },
					{ text: 'gone', marks: { strike: true } }
				)
			])
		).toBe('***x*** [**link**](https://x.dev) `a*b` bad ~~gone~~\n');
	});

	test('text that reads as markdown is escaped', () => {
		expect(md([p({ text: '# not *a* heading' }), p({ text: '1. not a list' })])).toBe(
			'\\# not \\*a\\* heading\n\n1\\. not a list\n'
		);
	});

	test('code with its language, a GFM table, an image, a callout, a toggle', () => {
		expect(
			md([
				{
					type: 'code',
					data: { language: 'js' },
					content: [],
					children: [{ type: 'codeLine', content: [{ text: 'a()' }] }]
				},
				tableBlock({
					cells: [
						['A', 'B|C'],
						['1', '2']
					],
					headerRow: true
				}),
				{
					type: 'image',
					data: { src: 'https://x.dev/a.png', alt: 'A' },
					content: [{ text: 'cap' }]
				},
				{
					type: 'callout',
					data: { icon: '💡' },
					content: [{ text: 'Note' }],
					children: [p({ text: 'body' })]
				},
				{ type: 'toggle', content: [{ text: 'More' }], children: [p({ text: 'hidden' })] }
			])
		).toBe(
			[
				'```js\na()\n```',
				'| A | B\\|C |\n| --- | --- |\n| 1 | 2 |',
				'![A](https://x.dev/a.png "cap")',
				'> [!NOTE]\n> 💡 Note\n>\n> body',
				'<details>\n<summary>More</summary>\n\nhidden\n\n</details>'
			].join('\n\n') + '\n'
		);
	});

	test('mentions and page links by their plain form', () => {
		expect(
			md([
				p(
					{ text: 'Ask ' },
					{ type: 'mention', data: { id: 'u1', label: 'Ada' } },
					{ text: ' in ' },
					{ type: 'pageLink', data: { pageId: 'p1', title: 'Plans' } }
				)
			])
		).toBe('Ask @Ada in Plans\n');
	});
});

describe('textToBlocks — GFM and nesting', () => {
	test('a GFM table is a table block, its first row the header', () => {
		expect(textToBlocks('| Name | Role |\n| :--- | ---: |\n| Ada | **Eng** |')).toEqual([
			tableBlock({
				cells: [
					['Name', 'Role'],
					['Ada', [{ text: 'Eng', marks: { bold: true } }]]
				],
				headerRow: true
			})
		]);
	});

	test('a fence keeps its language in data.language', () => {
		expect(textToBlocks('```ts\nlet a\n```')).toEqual([
			{
				type: 'code',
				data: { language: 'ts' },
				content: [],
				children: [{ type: 'codeLine', content: [{ text: 'let a' }] }]
			}
		]);
	});

	test('marks nest: a bold link, bold italic, italic inside bold', () => {
		expect(textToBlocks('**[bold link](https://x.dev)** ***x*** **a *b* c**')).toEqual([
			p(
				{ text: 'bold link', marks: { bold: true, link: { href: 'https://x.dev' } } },
				{ text: ' ' },
				{ text: 'x', marks: { bold: true, italic: true } },
				{ text: ' ' },
				{ text: 'a ', marks: { bold: true } },
				{ text: 'b', marks: { bold: true, italic: true } },
				{ text: ' c', marks: { bold: true } }
			)
		]);
	});

	test('a javascript: link is its label; snake_case stays text; escapes are literal', () => {
		expect(textToBlocks('[x](javascript:alert(1)) snake_case_name \\*not\\*')).toEqual([
			p({ text: 'x snake_case_name *not*' })
		]);
	});
});

describe('textToBlocks — streaming', () => {
	const stream = (text: string) => textToBlocks(text, { streaming: true });

	test('an unfinished last line that is only a block marker is held back', () => {
		expect(stream('Intro\n\n#')).toEqual([p({ text: 'Intro' })]);
		expect(stream('Intro\n\n- ')).toEqual([p({ text: 'Intro' })]);
		expect(stream('Intro\n\n1.')).toEqual([p({ text: 'Intro' })]);
	});

	test('an unclosed inline marker holds back from where it opens', () => {
		expect(stream('Hello **wor')).toEqual([p({ text: 'Hello' })]);
		expect(stream('See [the do')).toEqual([p({ text: 'See' })]);
		expect(stream('Run `npm')).toEqual([p({ text: 'Run' })]);
		expect(stream('Hello **world** and *i')).toEqual([
			p({ text: 'Hello ' }, { text: 'world', marks: { bold: true } }, { text: ' and' })
		]);
	});

	test('a table header waits for its separator row; then rows show as they arrive', () => {
		expect(stream('Intro\n\n| A | B |\n')).toEqual([p({ text: 'Intro' })]);
		expect(stream('Intro\n\n| A | B |\n| --')).toEqual([p({ text: 'Intro' })]);
		expect(stream('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3')).toEqual([
			tableBlock({
				cells: [
					['A', 'B'],
					['1', '2']
				],
				headerRow: true
			})
		]);
	});

	test('inside an open fence everything is code; a finished text reads as without streaming', () => {
		expect(stream('```js\nlet *a')).toEqual([
			{
				type: 'code',
				data: { language: 'js' },
				content: [],
				children: [{ type: 'codeLine', content: [{ text: 'let *a' }] }]
			}
		]);
		const done = '# T\n\n- a **b**\n';
		expect(stream(done)).toEqual(textToBlocks(done));
	});
});

/** The common set: what markdown and HTML both carry. */
const corpus: JSONBlock[] = [
	{ type: 'heading', data: { level: 'h1' }, content: [{ text: 'Release notes' }] },
	{ type: 'heading', data: { level: 'h3' }, content: [{ text: 'Details' }] },
	p(
		{ text: 'Plain, ' },
		{ text: 'bold', marks: { bold: true } },
		{ text: ', ' },
		{ text: 'italic', marks: { italic: true } },
		{ text: ', ' },
		{ text: 'both', marks: { bold: true, italic: true } },
		{ text: ', ' },
		{ text: 'code', marks: { code: true } },
		{ text: ', ' },
		{ text: 'struck', marks: { strike: true } },
		{ text: ' and ' },
		{ text: 'a bold link', marks: { bold: true, link: { href: 'https://edytor.dev/docs' } } },
		{ text: '.' }
	),
	{
		type: 'bulleted-list-item',
		content: [{ text: 'one' }],
		children: [
			{
				type: 'bulleted-list-item',
				content: [{ text: 'nested' }],
				children: [{ type: 'bulleted-list-item', content: [{ text: 'deeper' }] }]
			}
		]
	},
	{ type: 'bulleted-list-item', content: [{ text: 'two' }] },
	{ type: 'numbered-list-item', content: [{ text: 'first' }] },
	{ type: 'numbered-list-item', content: [{ text: 'second' }] },
	{ type: 'todo-item', data: { checked: false }, content: [{ text: 'open' }] },
	{ type: 'todo-item', data: { checked: true }, content: [{ text: 'done' }] },
	{ type: 'quote', content: [{ text: 'A quote' }] },
	{
		type: 'code',
		data: { language: 'ts' },
		content: [],
		children: [
			{ type: 'codeLine', content: [{ text: 'const a = 1;' }] },
			{ type: 'codeLine', content: [{ text: '' }] },
			{ type: 'codeLine', content: [{ text: 'a <b> & c' }] }
		]
	},
	tableBlock({
		cells: [
			['Name', 'Role'],
			['Ada', [{ text: 'Eng', marks: { bold: true } }]]
		],
		headerRow: true
	}),
	{ type: 'divider', content: [] },
	{
		type: 'image',
		data: { src: 'https://edytor.dev/cover.png', alt: 'Cover' },
		content: [{ text: 'The cover' }]
	},
	{
		type: 'callout',
		data: { icon: '💡' },
		content: [{ text: 'Heads up' }],
		children: [p({ text: 'Inside the callout' })]
	},
	{ type: 'toggle', content: [{ text: 'More' }], children: [p({ text: 'Hidden text' })] }
];

describe('round trips', () => {
	test('blocks → markdown → blocks', () => {
		expect(textToBlocks(toMarkdown(corpus))).toEqual(corpus);
	});

	test('markdown → blocks → markdown is stable', () => {
		const md = toMarkdown(corpus);
		expect(toMarkdown(textToBlocks(md))).toBe(md);
	});

	test.each([
		['linkedom', linkedom],
		['jsdom', jsdom]
	])('blocks → HTML → blocks (%s)', (_, DOMParser) => {
		const back = fromHTML(toHTML(corpus), { DOMParser }).children;
		// HTML import gives every block its content (a table's rows hold none of their own),
		// an empty line none.
		const withContent = (blocks: JSONBlock[]): JSONBlock[] =>
			blocks.map(({ data, children, content, ...rest }) => ({
				...rest,
				content: content?.filter((part) => !('text' in part) || part.text) ?? [],
				...(data && Object.keys(data).length > 0 && { data }),
				...(children && { children: withContent(children) })
			}));
		expect(back).toEqual(withContent(corpus));
	});

	test('HTML → blocks → HTML is stable', () => {
		const html = toHTML(corpus);
		expect(toHTML(fromHTML(html, { DOMParser: linkedom }))).toBe(html);
	});
});

describe('fromHTML sanitizes', () => {
	const read = (html: string) => fromHTML(html, { DOMParser: linkedom }).children;

	test('a script, a style and an event handler carry nothing', () => {
		expect(read('<p onclick="alert(1)">Hi<script>alert(1)</script><style>p{}</style></p>')).toEqual(
			[p({ text: 'Hi' })]
		);
	});

	test('an image with an onerror handler keeps only its safe source; a javascript: source is no image', () => {
		expect(read('<img src="https://x.dev/a.png" onerror="alert(1)" alt="A">')).toEqual([
			{ type: 'image', content: [], data: { src: 'https://x.dev/a.png', alt: 'A' } }
		]);
		expect(read('<p>a</p><img src="javascript:alert(1)">')).toEqual([p({ text: 'a' })]);
	});

	test('a javascript: link is its text; a safe one keeps its href', () => {
		expect(
			read('<p><a href="javascript:alert(1)">bad</a> <a href=" https://x.dev ">ok</a></p>')
		).toEqual([p({ text: 'bad ' }, { text: 'ok', marks: { link: { href: 'https://x.dev' } } })]);
	});

	test('only the kinds and marks given survive: an allowlist', () => {
		const kinds = {
			blocks: { paragraph: {}, heading: bundledForms.blocks.heading },
			marks: { bold: bundledForms.marks.bold }
		};
		expect(
			fromHTML(
				'<h2>T</h2><ul><li><em>x</em> <b>y</b></li></ul><table><tr><td>c</td></tr></table>',
				{
					DOMParser: linkedom,
					kinds
				}
			).children
		).toEqual([
			{ type: 'heading', content: [{ text: 'T' }], data: { level: 'h2' } },
			p({ text: 'x ' }, { text: 'y', marks: { bold: true } }),
			p({ text: 'c' })
		]);
	});

	test('without a parser it says how to pass one', () => {
		const global = globalThis as { DOMParser?: unknown };
		const own = global.DOMParser;
		delete global.DOMParser;
		try {
			expect(() => fromHTML('<p>x</p>')).toThrow(/linkedom/);
		} finally {
			if (own) global.DOMParser = own;
		}
	});
});

describe("textToBlocks — the parser's reading", () => {
	test('reference links and autolinks are links; a soft break a space, a hard break a newline', () => {
		expect(textToBlocks('[r][ref] <https://x.dev>\nnext  \nline\n\n[ref]: https://r.dev')).toEqual([
			p(
				{ text: 'r', marks: { link: { href: 'https://r.dev' } } },
				{ text: ' ' },
				{ text: 'https://x.dev', marks: { link: { href: 'https://x.dev' } } },
				{ text: ' next\nline' }
			)
		]);
	});

	test('raw HTML is text, never markup; a javascript: image is its alt text', () => {
		expect(
			textToBlocks('<img src=x onerror=alert(1)> <b>x</b>\n\n![a](javascript:alert(1))')
		).toEqual([p({ text: '<img src=x onerror=alert(1)> <b>x</b>' }), p({ text: 'a' })]);
	});

	test('a GitHub alert is a callout, its leading emoji its icon; <details> a toggle; $$ an equation', () => {
		expect(
			textToBlocks(
				'> [!TIP]\n> 🔥 Hot\n\n<details>\n<summary><h2>More</h2></summary>\n\nbody\n\n</details>\n\n$$\nx^2\n$$'
			)
		).toEqual([
			{ type: 'callout', data: { icon: '🔥' }, content: [{ text: 'Hot' }] },
			{
				type: 'toggle-heading',
				data: { level: 'h2' },
				content: [{ text: 'More' }],
				children: [p({ text: 'body' })]
			},
			{ type: 'equation', data: { expression: 'x^2' }, content: [] }
		]);
	});
});

describe('textToBlocks — blockquotes (CommonMark)', () => {
	const quote = (text: string, ...children: JSONBlock[]): JSONBlock => ({
		type: 'quote',
		content: [{ text }],
		...(children.length ? { children } : {})
	});

	test('a blank line ends a quote: two quotes, never one', () => {
		expect(textToBlocks('> a\n\n> b')).toEqual([quote('a'), quote('b')]);
	});

	test('an alert right after a quote is a callout', () => {
		expect(textToBlocks('> quote\n\n> [!TIP]\n> Title\n>\n> Body')).toEqual([
			quote('quote'),
			{ type: 'callout', content: [{ text: 'Title' }], children: [p({ text: 'Body' })] }
		]);
	});

	test('an empty quote line keeps one quote; a lazy line continues its paragraph', () => {
		expect(textToBlocks('> a\n>\n> b')).toEqual([quote('a', p({ text: 'b' }))]);
		// A soft break reads as a space, as in any paragraph.
		expect(textToBlocks('> a\nb\n\nafter')).toEqual([quote('a b'), p({ text: 'after' })]);
	});

	test('a heading after a quote is no lazy line; nested quotes nest', () => {
		expect(textToBlocks('> a\n# H')).toEqual([
			quote('a'),
			{ type: 'heading', data: { level: 'h1' }, content: [{ text: 'H' }] }
		]);
		expect(textToBlocks('> > deep')).toEqual([
			{ type: 'quote', content: [], children: [quote('deep')] }
		]);
	});
});

describe('MDX-lite', () => {
	const components = { Endpoint: 'endpoint', Callout: 'callout' };

	test('a tag is a block of the kind it names, its literal attributes its data', () => {
		expect(
			fromMarkdown(
				'<Endpoint operationId="getPet" method=\'get\' version={2} deprecated={false} auth />\n\n<Callout type="warning" title="x">Read **this**</Callout>',
				{ components }
			).children
		).toEqual([
			{
				type: 'endpoint',
				data: { operationId: 'getPet', method: 'get', version: 2, deprecated: false, auth: true },
				content: []
			},
			{
				type: 'callout',
				data: { type: 'warning', title: 'x' },
				content: [{ text: 'Read ' }, { text: 'this', marks: { bold: true } }]
			}
		]);
	});

	test('a tag on its own lines: its first paragraph its text, the rest its children', () => {
		expect(
			textToBlocks('<Callout type="note">\nHead\n\n- item\n\n<Endpoint id="a" />\n</Callout>', {
				components
			})
		).toEqual([
			{
				type: 'callout',
				data: { type: 'note' },
				content: [{ text: 'Head' }],
				children: [
					{ type: 'bulleted-list-item', content: [{ text: 'item' }] },
					{ type: 'endpoint', data: { id: 'a' }, content: [] }
				]
			}
		]);
	});

	test('an unknown tag, an expression, an import or an unclosed tag stays text and is reported', () => {
		const issues: MarkdownIssue[] = [];
		const blocks = textToBlocks(
			'import X from "x"\n\n<Other a="1" />\n\n<Endpoint id={a + b} />\n\n<Callout>\nopen',
			{ components, onUnknown: (issue) => issues.push(issue) }
		);
		expect(blocks).toEqual([
			p({ text: 'import X from "x"' }),
			p({ text: '<Other a="1" />' }),
			p({ text: '<Endpoint id={a + b} />' }),
			p({ text: '<Callout> open' })
		]);
		expect(issues.map(({ reason, name }) => [reason, name])).toEqual([
			['import', undefined],
			['component', 'Other'],
			['expression', 'Endpoint'],
			['unclosed', 'Callout']
		]);
	});

	test("mdxComponent writes the tag a kind's markdown form stands for", () => {
		expect(mdxComponent('Endpoint', { id: 'a', n: 1, on: true, skip: { x: 1 } })).toBe(
			'<Endpoint id="a" n={1} on={true} />'
		);
		expect(mdxComponent('Note', { q: 'say "hi"' }, 'text')).toBe(`<Note q='say "hi"'>text</Note>`);
		expect(mdxComponent('Note', {}, 'head', 'child')).toBe('<Note>\nhead\n\nchild\n</Note>');
		const endpoint: BlockForms = {
			markdown: (block, content, children) =>
				mdxComponent('Endpoint', block.data, content, children)
		};
		expect(
			toMarkdown([{ type: 'endpoint', data: { operationId: 'getPet' }, content: [] }], {
				kinds: { blocks: { ...bundledForms.blocks, endpoint } }
			})
		).toBe('<Endpoint operationId="getPet" />\n');
	});

	test('round trip: toMarkdown(fromMarkdown(src)) is src', () => {
		const src =
			[
				'# Pets API',
				'<Endpoint operationId="getPet" method="get" version={2} beta={true} />',
				'<Callout type="warning" title="x">Read **this** first</Callout>',
				'<Callout type="note">\nHead\n\n- item\n- other\n\n<Endpoint operationId="listPets" />\n</Callout>',
				'Plain text after.'
			].join('\n\n') + '\n';
		expect(toMarkdown(fromMarkdown(src, { components }), { components })).toBe(src);
	});
});

test('only edytor/export imports @tanstack/markdown: the editor ships no markdown parser', () => {
	const lib = join(import.meta.dirname, '../../lib');
	const importers = readdirSync(lib, { recursive: true, encoding: 'utf8' })
		.filter((file) => /\.(ts|js|svelte)$/.test(file) && !file.includes('vendor'))
		.filter((file) => readFileSync(join(lib, file), 'utf8').includes("'@tanstack/markdown"))
		.map((file) => file.split('\\').join('/'));
	expect(importers.every((file) => file.startsWith('export/'))).toBe(true);
	expect(importers).toContain('export/markdown.ts');
});
