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
	HEADING_LEVELS,
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
import {
	atomMarkdown,
	blockExtras,
	blockMarkdown,
	listSiblings,
	markMarkdown
} from './exportForms.js';
import { DEFAULT_CALLOUT_ICON } from '$lib/plugins/richtext/callouts.js';

/** A callout's icon on a server: its own, else the bundled default. */
const defaultCalloutIcon = (data: Record<string, unknown> | undefined) =>
	typeof data?.icon === 'string' ? data.icon : DEFAULT_CALLOUT_ICON;
import type { AtomForms, BlockForms, MarkForms } from './forms.js';

export { escapeHtml } from '$lib/clipboard/serializeClipboardFragment.js';
export { textToBlocks, type MarkdownOptions } from './markdown.js';
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
/**
 * The rich text kinds' presets' data, as their plugin lists them: HTML
 * import finds a kind by a preset's tag (an `h2`, a `blockquote`). A view's
 * records carry their own presets; only a server reading needs these.
 */
const levels = HEADING_LEVELS.map((level) => ({ data: { level } }));
const PRESETS: Record<string, BlockForms['presets']> = {
	heading: levels,
	'toggle-heading': levels,
	'bulleted-list-item': [{}],
	'numbered-list-item': [{}],
	'todo-item': [{ data: { checked: false } }],
	toggle: [{}],
	callout: [{}],
	quote: [{}],
	divider: [{}]
};
const rich = { paragraph: {}, ...richTextForms(defaultCalloutIcon) };
const richWithPresets = Object.fromEntries(
	Object.entries(rich).map(([type, form]) => [type, { ...form, presets: PRESETS[type] }])
) as Record<keyof typeof rich, BlockForms>;

export const bundledForms = {
	blocks: {
		...richWithPresets,
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

const BLOCK_MARKDOWN: Record<string, BlockForms['markdown']> = blockMarkdown();
const EXTRAS: Record<string, BlockForms> = blockExtras;
const MARK_MARKDOWN: Record<string, MarkForms['markdown']> = markMarkdown;
const ATOM_MARKDOWN: Record<string, AtomForms['markdown']> = atomMarkdown;

/** Each record with the export's forms it lacks (`exportForms.ts`), by its name: its own win. */
const fill = <T extends { markdown?: unknown }>(
	map: ReadonlyMap<string, T>,
	markdown: Record<string, T['markdown']>,
	extras: Record<string, Partial<T>> = {}
) =>
	new Map(
		[...map].map(([name, form]) => [
			name,
			{
				...(Object.hasOwn(extras, name) && extras[name]),
				...(Object.hasOwn(markdown, name) && { markdown: markdown[name] }),
				...Object.fromEntries(Object.entries(form).filter(([, value]) => value !== undefined))
			} as T
		])
	);
const complete = (records: ExportKinds): ExportKinds => ({
	blocks: fill(records.blocks, BLOCK_MARKDOWN, EXTRAS),
	marks: fill(records.marks, MARK_MARKDOWN),
	inlineBlocks: fill(records.inlineBlocks, ATOM_MARKDOWN)
});

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
	const records = complete(recordsOf(options.kinds));
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
	const md = blocksToMarkdown([...blocksOf(doc)], complete(recordsOf(options.kinds)));
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
	const records = complete(recordsOf(options.kinds));
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
