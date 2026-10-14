/**
 * `edytor/export`: a document as HTML or Markdown, and HTML or Markdown
 * as a document, by each kind's own forms (the clipboard's: `html`,
 * `plain`, `markdown`, `parse`). Svelte-free and Worker-safe: it runs in a
 * browser, in Node and in a Worker. Without `kinds` it reads the bundled
 * kinds' forms ({@link bundledForms}); in a view, pass the view
 * (`kinds: edytor`) to read its own records, your kinds included.
 */
import type { JSONBlock, JSONDoc } from '$lib/utils/json.js';
import { blocksToHtml, type ExportKinds } from '$lib/clipboard/serializeClipboardFragment.js';
import { blocksToMarkdown } from './markdownWriter.js';
import { linesOfHtml, type HtmlParser, type ImportKinds } from '$lib/clipboard/htmlFlow.js';
import {
	bundledMarkdown,
	bundledRead,
	bundledWrite,
	codeForms,
	columnsForms,
	equationForms,
	htmlExtras,
	imageForms,
	listSiblings,
	markdownExtras,
	mediaForms,
	mentionForms,
	pageForms,
	pageLinkForms,
	parseExtras,
	richTextForms,
	richTextMarkForms,
	tableForms,
	tocForms,
	type KindForms
} from './forms.js';
import { textToBlocks, type MarkdownComponents, type MarkdownOptions } from './markdown.js';
import { mdxComponent } from './mdx.js';
import { iconOf } from '$lib/plugins/richtext/callouts.js';
import type { BlockForms } from './forms.js';

export { escapeHtml } from '$lib/clipboard/serializeClipboardFragment.js';
export {
	textToBlocks,
	type MarkdownComponents,
	type MarkdownIssue,
	type MarkdownOptions
} from './markdown.js';
export { mdxComponent } from './mdx.js';
export {
	codeForms,
	columnsForms,
	equationForms,
	imageForms,
	mediaForms,
	mentionForms,
	pageForms,
	pageLinkForms,
	richTextForms,
	richTextMarkForms,
	tableForms,
	tocForms,
	type AtomForms,
	type BlockForms,
	type KindForms,
	type MarkForms,
	type MathML
} from './forms.js';
export type { ExportKinds, HtmlParser };
export type { MarkdownContext } from '$lib/plugins.js';

/**
 * Every bundled kind's, mark's and atom's forms, with each plugin's
 * default options: what `toHTML`, `toMarkdown` and `fromHTML` read when
 * given no `kinds` (each its own direction of them). A view's own records
 * (`kinds: edytor`) carry its options (its callout icon, its embed
 * providers, its page links).
 */
export const bundledForms = /* @__PURE__ */ (() => {
	const read = bundledRead().blocks;
	const rich = { paragraph: {}, ...richTextForms(iconOf) } as Record<string, BlockForms>;
	// A rich text kind's presets' data, as its plugin lists them: HTML import finds a kind by a
	// preset's tag (an `h2`, a `blockquote`). A view's records carry their own.
	for (const type in rich)
		if (read[type]?.presets) rich[type] = { ...rich[type], presets: read[type].presets };
	const equation = equationForms();
	return {
		blocks: {
			...rich,
			...codeForms(),
			...tableForms(),
			...imageForms(),
			...mediaForms(),
			...pageForms(),
			...tocForms(),
			...equation.blocks,
			...columnsForms()
		},
		marks: richTextMarkForms,
		inlineBlocks: { mention: mentionForms(), pageLink: pageLinkForms(), ...equation.inlineBlocks }
	} satisfies Required<KindForms>;
})();

/** Which forms a conversion reads. */
export type ExportOptions = {
	/**
	 * The kinds, marks and atoms to read: a view (`edytor`, its own records),
	 * or forms by name. A section left out is the bundled one; listed, it is
	 * exactly those (`{ blocks: { ...bundledForms.blocks, mine } }` adds yours;
	 * a shorter list allows only those). Default {@link bundledForms}.
	 */
	kinds?: KindForms | ExportKinds;
	/**
	 * MDX-lite, for `toMarkdown`: the tags to write, each the kind it stands
	 * for (`{ Endpoint: 'endpoint' }`), the map `fromMarkdown` reads. A block
	 * of a listed kind is its tag, its data the attributes (see
	 * {@link mdxComponent}); its kind's own `markdown` form is not used.
	 */
	components?: MarkdownComponents;
};

/** What {@link fromHTML} reads. */
export type ImportOptions = ExportOptions & {
	/**
	 * The HTML parser: the browser's `DOMParser` by default. On a server pass
	 * one (`import { DOMParser } from 'linkedom'`, or jsdom's
	 * `new JSDOM().window.DOMParser`). It only parses: nothing in the HTML
	 * runs or loads.
	 */
	DOMParser?: HtmlParser;
};

const isView = (kinds: KindForms | ExportKinds): kinds is ExportKinds =>
	kinds.blocks instanceof Map;

/** A direction's default records (`bundledWrite`, …) as the records the conversions read. */
type Defaults = Required<KindForms>;

/**
 * `kinds` as the records a conversion reads, each with the forms of
 * `extras` (by name) it lacks: its own win. A section left out is the
 * direction's bundled one.
 */
const recordsOf = (
	kinds: KindForms | ExportKinds | undefined,
	defaults: () => Defaults,
	extras: Defaults
) => {
	const own = kinds && isView(kinds) ? kinds : undefined;
	const forms = (kinds ?? {}) as KindForms;
	let bundled: Defaults | undefined;
	const section = <K extends keyof Defaults>(key: K) =>
		new Map(
			[...(own?.[key] ?? Object.entries(forms[key] ?? (bundled ??= defaults())[key]))].map(
				([name, form]) => [
					name,
					{
						...(Object.hasOwn(extras[key], name) && extras[key][name]),
						...Object.fromEntries(Object.entries(form).filter(([, value]) => value !== undefined))
					}
				]
			)
		) as Map<string, NonNullable<Defaults[K][string]>>;
	return {
		blocks: section('blocks'),
		marks: section('marks'),
		inlineBlocks: section('inlineBlocks')
	};
};

const blocksOf = (doc: JSONDoc | readonly JSONBlock[]) =>
	(Array.isArray(doc) ? doc : (doc as JSONDoc).children) ?? [];

/**
 * A document (or blocks) as HTML: each block by its kind's `html` form, a
 * run of list items in their list's element, text by its marks' elements.
 * Values are escaped and links through the link sanitizer; ids and empty
 * data are never written.
 *
 * ```ts
 * import { toHTML } from 'edytor/export';
 * const html = toHTML(value);
 * ```
 */
export const toHTML = (
	doc: JSONDoc | readonly JSONBlock[],
	options: ExportOptions = {}
): string => {
	const records = recordsOf(options.kinds, bundledWrite, {
		blocks: htmlExtras(),
		marks: {},
		inlineBlocks: {}
	});
	return blocksToHtml([...blocksOf(doc)], records, listSiblings(records));
};

/**
 * A document (or blocks) as Markdown (CommonMark with GFM tables, task
 * lists and strikethrough): each block by its kind's `markdown` form (else
 * its `plain` form), marks by theirs, atoms by theirs (else their `plain`
 * form). A toggle is a `<details>` disclosure, a callout a `> [!NOTE]`
 * alert; `textToBlocks` reads both back.
 */
export const toMarkdown = (
	doc: JSONDoc | readonly JSONBlock[],
	options: ExportOptions = {}
): string => {
	const records = recordsOf(options.kinds, bundledMarkdown, markdownExtras());
	// Each kind `components` lists written as its tag (the first tag naming it).
	for (const [tag, type] of Object.entries(options.components ?? {}).reverse())
		records.blocks.set(type, {
			...records.blocks.get(type),
			markdown: (block, content, children) => mdxComponent(tag, block.data, content, children)
		});
	const md = blocksToMarkdown([...blocksOf(doc)], records);
	return md ? `${md}\n` : '';
};

/**
 * Markdown as a document: {@link textToBlocks}'s reading, as a `JSONDoc`.
 * With `components`, MDX-lite tags (`<Endpoint operationId="getPet" />`)
 * are blocks of the kinds they name; a tag it does not name, an
 * expression, an import or an export stays text and is told to `onUnknown`.
 *
 * ```ts
 * import { fromMarkdown } from 'edytor/export';
 * const value = fromMarkdown(source, { components: { Endpoint: 'endpoint' } });
 * ```
 */
export const fromMarkdown = (source: string, options: MarkdownOptions = {}): JSONDoc => ({
	children: textToBlocks(source, options)
});

/** A parsed line's type resolved (its parent's default child), its empty data and children dropped. */
const settle = (
	line: JSONBlock,
	parent: string | null,
	defaultChild: (parent: string | null) => string
): JSONBlock => {
	const type = line.type ?? defaultChild(parent);
	const block: JSONBlock = { type, content: line.content ?? [] };
	if (line.data && Object.keys(line.data).length) block.data = line.data;
	if (line.children?.length)
		block.children = line.children.map((child) => settle(child, type, defaultChild));
	return block;
};

/**
 * HTML as a document, the paste's reading (`flow.html.*`): only the kinds,
 * marks and atoms of `kinds` survive (an unknown element is its text, a
 * `script` or `style` nothing), every value through its record's `parse`
 * hook (a link's href through the link sanitizer: `javascript:` drops the
 * link, an image's source through the image's), and nothing executes: the
 * parser only parses, no attribute is copied (`onerror`, `style`).
 *
 * ```ts
 * import { DOMParser } from 'linkedom'; // on a server; the browser has its own
 * import { fromHTML } from 'edytor/export';
 * const value = fromHTML(html, { DOMParser });
 * ```
 */
export const fromHTML = (html: string, options: ImportOptions = {}): JSONDoc => {
	const records = recordsOf(options.kinds, bundledRead, {
		blocks: parseExtras(),
		marks: {},
		inlineBlocks: {}
	});
	const own = (options.kinds as { document?: ImportKinds['document'] } | undefined)?.document;
	const defaultChild =
		own?.defaultChild.bind(own) ??
		((parent: string | null) =>
			(parent !== null && records.blocks.get(parent)?.defaultChild) || 'paragraph');
	const parser = options.DOMParser ?? globalThis.DOMParser;
	if (!parser)
		throw new Error(
			"fromHTML: no DOMParser here; pass one (`import { DOMParser } from 'linkedom'`)."
		);
	// A fragment as a document's body: a server parser (linkedom) reads only whole documents.
	const whole = /<(?:html|body)[\s>]/i.test(html)
		? html
		: `<!doctype html><html><head></head><body>${html}</body></html>`;
	const lines = linesOfHtml({ ...records, document: { defaultChild } }, whole, parser) ?? [];
	return { children: lines.map((line) => settle(line, null, defaultChild)) };
};
