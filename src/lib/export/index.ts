/**
 * `edytor/export`: a document as HTML or Markdown, and HTML or Markdown
 * as a document, by each kind's own forms (the clipboard's: `html`,
 * `plain`, `markdown`, `parse`). Svelte-free and Worker-safe: it runs in a
 * browser, in Node and in a Worker. Without `kinds` it reads the bundled
 * kinds' forms ({@link bundledForms}); in a view, pass the view
 * (`kinds: edytor`) to read its own records, your kinds included.
 */
import type { JSONBlock, JSONDoc } from '$lib/utils/json.js';
import {
	blocksToHtml,
	blocksToMarkdown,
	type ExportKinds
} from '$lib/clipboard/serializeClipboardFragment.js';
import { linesOfHtml, type HtmlParser, type ImportKinds } from '$lib/clipboard/htmlFlow.js';
import {
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
	type KindForms
} from './forms.js';

export { escapeHtml } from '$lib/clipboard/serializeClipboardFragment.js';
export { textToBlocks, type TextToBlocksOptions } from '$lib/clipboard/textBlocks.js';
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
 * given no `kinds`. A view's own records (`kinds: edytor`) carry its
 * options (its callout icon, its embed providers, its page links).
 */
export const bundledForms = {
	blocks: {
		...richTextForms(),
		...codeForms(),
		...tableForms(),
		...imageForms(),
		...mediaForms(),
		...pageForms(),
		...tocForms(),
		...equationForms().blocks,
		...columnsForms()
	},
	marks: richTextMarkForms,
	inlineBlocks: {
		mention: mentionForms(),
		pageLink: pageLinkForms(),
		...equationForms().inlineBlocks
	}
} satisfies Required<KindForms>;

/** Which forms a conversion reads. */
export type ExportOptions = {
	/**
	 * The kinds, marks and atoms to read: a view (`edytor`, its own records),
	 * or forms by name. A section left out is the bundled one; listed, it is
	 * exactly those (`{ blocks: { ...bundledForms.blocks, mine } }` adds yours;
	 * a shorter list allows only those). Default {@link bundledForms}.
	 */
	kinds?: KindForms | ExportKinds;
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

/** `kinds` as the records the conversions read. */
const recordsOf = (kinds: KindForms | ExportKinds = bundledForms): ExportKinds => {
	if (isView(kinds)) return kinds;
	const forms = kinds as KindForms;
	return {
		blocks: new Map(Object.entries(forms.blocks ?? bundledForms.blocks)),
		marks: new Map(Object.entries(forms.marks ?? bundledForms.marks)),
		inlineBlocks: new Map(Object.entries(forms.inlineBlocks ?? bundledForms.inlineBlocks))
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
export const toHTML = (doc: JSONDoc | readonly JSONBlock[], options: ExportOptions = {}): string =>
	blocksToHtml([...blocksOf(doc)], recordsOf(options.kinds));

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
	const md = blocksToMarkdown([...blocksOf(doc)], recordsOf(options.kinds));
	return md ? `${md}\n` : '';
};

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
	const records = recordsOf(options.kinds);
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
	const lines = linesOfHtml({ ...records, document: { defaultChild } }, html, parser) ?? [];
	return { children: lines.map((line) => settle(line, null, defaultChild)) };
};
