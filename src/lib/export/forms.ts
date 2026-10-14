/**
 * The bundled kinds' forms as data, one rule per kind and direction: the
 * HTML a kind writes (`html`, `plain`; a mark's `tag` and `attributes`),
 * the HTML it reads back (`parse`, and the tags its element shows), and
 * the Markdown it writes (`toMarkdown` only). The bundled plugins spread a
 * kind's halves into its record (`codeForms()`, …), so the clipboard,
 * `toHTML`, `toMarkdown` and `fromHTML` read the same functions, in a view
 * (its records) and on a server ({@link bundledForms}); each conversion
 * reads only its own direction's tables. No Svelte, no DOM state:
 * Worker-safe.
 */
import type { JSONBlock, SerializableContent } from '$lib/utils/json.js';
import {
	sanitizeCssColorValue,
	sanitizeLinkHref,
	safeMediaSrc,
	safeWebUrl
} from '$lib/utils/sanitize.js';
import {
	escapeHtml,
	type AtomForms,
	type BlockForms,
	type ExportKinds,
	type MarkForms,
	type SiblingsHtml
} from '$lib/clipboard/serializeClipboardFragment.js';
import type { BlockDefinition, InlineBlockDefinition, MarkDefinition } from '$lib/plugins.js';
import {
	codeKinds,
	equationKinds,
	imageKinds,
	layoutKinds,
	mediaKinds,
	pageKinds,
	richTextKinds,
	richTextMarks,
	tableKinds,
	tocKinds
} from '$lib/crdt/semantics.js';
import { calloutHtml, iconOf } from '$lib/plugins/richtext/callouts.js';
import {
	imageAlignOf,
	imageAltOf,
	imageWidthOf,
	imgData,
	safeImageSrc
} from '$lib/plugins/image/image.js';
import {
	EMBED_PROVIDERS,
	EMBED_SANDBOX,
	claimed,
	embedSourceOf,
	fileNameFor,
	fileNameOf,
	mediaSourceOf,
	type EmbedProvider
} from '$lib/plugins/media/sources.js';
import {
	pageHref,
	pageHtml,
	pageIdOf,
	pageTitleOf,
	type PagePluginOptions
} from '$lib/plugins/page/page.js';
import { expressionOf, parseEquation, sourceMathml } from '$lib/plugins/equation/tex.js';

export type { AtomForms, BlockForms, MarkForms };

/**
 * Kind, mark and atom forms by name: what `toHTML`, `toMarkdown` and
 * `fromHTML` read ({@link bundledForms} for the bundled ones). A kind
 * record of your own plugin is a valid row: list your kinds beside the
 * bundled ones (`{ blocks: { ...bundledForms.blocks, mine } }`).
 */
export type KindForms = {
	blocks?: Record<string, BlockForms>;
	marks?: Record<string, MarkForms>;
	inlineBlocks?: Record<string, AtomForms>;
};

type Data = Record<string, unknown> | undefined;
/** A kind's forms as its plugin spreads them (the plugin lists its own presets). */
type Form = Omit<BlockForms, 'presets'>;
type Rows = Record<string, Form>;
type BlockMarkdown = NonNullable<BlockDefinition['markdown']>;

/** Tables of rows by name as one: each name's rows merged, in the first table's order. */
/* @__NO_SIDE_EFFECTS__ */
export const joined = <T extends object = Form>(
	...tables: Record<string, Partial<NoInfer<T>>>[]
): Record<string, T> => {
	const out: Record<string, T> = {};
	for (const table of tables)
		for (const name in table) out[name] = { ...out[name], ...table[name] } as T;
	return out;
};

// Rich text ---------------------------------------------------------------

/**
 * Notion's three heading levels: a missing level is h1, any other (a
 * stored `h4`–`h6`, as HTML import reads them) h3.
 */
export const headingLevel = (level: unknown) =>
	level === 'h1' || level === 'h2' || level === 'h3' ? level : level === undefined ? 'h1' : 'h3';
/** A code block's language as stored: a short name, else none. */
export const languageOf = (name: unknown) =>
	typeof name === 'string' && /^[\w#+.-]{1,40}$/.test(name) ? name : undefined;
/** The heading levels the rich text kinds create (their presets' data). */
export const HEADING_LEVELS = ['h1', 'h2', 'h3'] as const;
/**
 * A list's elements without list semantics (`role="none"`): a list's items
 * are sibling blocks, never the only children of one `ul` or `ol`, so an
 * `li` would be an orphan list item to assistive technology (WCAG 1.3.1);
 * the tags stay for styles and the HTML export.
 */
export const unlisted = (tag: 'li' | 'ul' | 'ol') => ({ tag, attributes: { role: 'none' } });

/** A tag wrapping `inner`. */
const wrap = (tag: string, inner: string) => `<${tag}>${inner}</${tag}>`;
/** A heading's tag for `data`. */
const levelOf = (data: Data) => headingLevel(data?.level);
/** A `<details>` disclosure over `summary`. */
const disclosure = (summary: string, children: string) =>
	`<details><summary>${summary}</summary>${children}</details>`;
/** `children` alone: a container's plain text and Markdown. */
const children = (_: JSONBlock, __: string, children: string) => children;

/** A `parse` hook claiming the elements `selector` matches, as `data` reads them (none: `{}`). */
/* @__NO_SIDE_EFFECTS__ */
const claims = (selector: string, data: (el: HTMLElement) => object | undefined = () => ({})) =>
	((el: HTMLElement) => (el.matches(selector) ? data(el) : undefined)) as NonNullable<
		Form['parse']
	>;

// Each kind's halves: its HTML writing (`…Write`: `html`, `plain`) and its
// elements and HTML reading (`…Read`: `element`, `contentElement`, `parse`).

export const headingWrite: Form = {
	html: (block, content, children) => wrap(levelOf(block.data), content) + children
};
export const headingRead: Form = {
	contentElement: levelOf,
	// h1–h3 come from the presets' tags; h4–h6 read as h3.
	parse: claims('h4,h5,h6', () => ({ level: 'h3' }))
};
export const itemWrite: Form = { html: 'li' };
export const itemRead: Form = { element: unlisted('li') };
export const numberedRead: Form = {
	element: unlisted('li'),
	// An `li` is a bulleted item (the first `li` kind) unless its list is ordered.
	parse: claims('ol>li')
};
export const todoWrite: Form = {
	html: (block, content, children) =>
		`<li data-edytor-todo-item="true"><input type="checkbox"${block.data?.checked === true ? ' checked' : ''}>${content}${children}</li>`,
	plain: (block, content, children) =>
		[`${block.data?.checked === true ? '[x]' : '[ ]'} ${content}`.trim(), children]
			.filter(Boolean)
			.join('\n')
};
export const toggleRead: Form = { element: 'details' };
export const toggleHeadingWrite: Form = {
	html: (block, content, children) => disclosure(wrap(levelOf(block.data), content), children)
};
export const toggleHeadingRead: Form = {
	element: 'details',
	contentElement: levelOf,
	// A `details` whose summary holds an h1–h6 (its own export).
	parse: claims('details', (el) => {
		const tag = el.querySelector(':scope > summary > :is(h1, h2, h3, h4, h5, h6)');
		return tag ? { level: headingLevel(tag.localName) } : undefined;
	})
};
/** A callout's HTML; `icon` is the one a callout without its own shows. */
export const calloutWrite = (icon: (data: Data) => string): Form => ({
	html: (block, content, children) => calloutHtml(icon(block.data), content, children)
});
// Its own export, the icon in its attribute.
export const calloutRead: Form = {
	parse: claims('[data-edytor-callout]', (el) => ({
		icon: el.getAttribute('data-edytor-callout')!
	}))
};
export const quoteWrite: Form = { html: 'blockquote' };
export const quoteRead: Form = { contentElement: 'blockquote' };
export const dividerWrite: Form = { html: () => '<hr>', plain: () => '---' };
// Their roles are the semantics' (`richTextKinds`), spread beside them where a record is built.
export const dividerRead: Form = { element: 'hr' };
export const orderedRead: Form = { element: unlisted('ol') };
export const unorderedRead: Form = { element: unlisted('ul') };
export const orderedWrite: Form = { itemKind: 'numbered-list-item', html: 'ol' };
export const unorderedWrite: Form = { itemKind: 'bulleted-list-item', html: 'ul' };

/**
 * The rich text kinds' forms as one table (a server's). `callout` is the icon a
 * callout without one of its own shows.
 */
export const richTextForms = (callout: (data: Data) => string): Rows => ({
	heading: { ...headingRead, ...headingWrite },
	'bulleted-list-item': { ...itemRead, ...itemWrite },
	'numbered-list-item': { ...numberedRead, ...itemWrite },
	'todo-item': todoWrite,
	toggle: toggleRead,
	'toggle-heading': { ...toggleHeadingRead, ...toggleHeadingWrite },
	callout: { ...calloutRead, ...calloutWrite(callout) },
	quote: { ...quoteRead, ...quoteWrite },
	divider: { ...richTextKinds.divider, ...dividerRead, ...dividerWrite },
	'ordered-list': { ...richTextKinds['ordered-list'], ...orderedRead, ...orderedWrite },
	'unordered-list': { ...richTextKinds['unordered-list'], ...unorderedRead, ...unorderedWrite },
	'list-item': { ...itemRead, ...itemWrite }
});

/** A hostile color value (a `;` payload would inject declarations) drops the style. */
/* @__NO_SIDE_EFFECTS__ */
const styled = (property: string) => (value: unknown) => {
	const safe = sanitizeCssColorValue(value);
	return { style: safe ? `${property}: ${safe};` : undefined };
};
/** An unsafe scheme drops the href (and its target): an inert anchor still carries the text. */
const linkAttributes = (mark: { href?: unknown; target?: string }) => {
	const href = sanitizeLinkHref(mark?.href) ?? undefined;
	return { href, target: href && mark.target };
};
const linkRead = (el: HTMLElement) => {
	const href = el.localName === 'a' && sanitizeLinkHref(el.getAttribute('href'));
	const target = el.getAttribute('target');
	return href ? { href, ...(target ? { target } : {}) } : undefined;
};
/**
 * HTML import: a pasted color, sanitized, unless it is the page's
 * default (Google Docs writes black text and transparent backgrounds on
 * every span: they are no mark, and a black mark is unreadable in dark mode).
 */
const colorOf = (value: string | undefined, none: string) =>
	!value ||
	new RegExp(`^(initial|inherit|unset|revert|currentcolor|${none})$`).test(
		value.replace(/\s+/g, '').toLowerCase()
	)
		? undefined
		: (sanitizeCssColorValue(value) ?? undefined);
const colorRead = (el: HTMLElement) =>
	colorOf(el.style.color, 'black|windowtext|#000|#000000|rgba?\\(0,0,0(,1)?\\)');
const highlightRead = (el: HTMLElement) =>
	el.style.backgroundColor
		? colorOf(
				el.style.backgroundColor,
				'transparent|rgba\\(\\d+,\\d+,\\d+,0\\)|white|#fff|#ffffff|rgba?\\(255,255,255(,1)?\\)'
			)
		: el.localName === 'mark'
			? 'yellow'
			: undefined;
/** HTML import: a tag alias (unless its own style says otherwise) or a style (Google Docs). */
/* @__NO_SIDE_EFFECTS__ */
const alias =
	(tags: RegExp, property: 'fontWeight' | 'fontStyle' | 'textDecoration', value: RegExp) =>
	(el: HTMLElement) =>
		(tags.test(el.localName) && !el.style[property]) || value.test(el.style[property]) || undefined;
const boldRead = alias(/^b$/, 'fontWeight', /^(bold|[6-9]00)$/);
const italicRead = alias(/^i$/, 'fontStyle', /italic/);
const underlineRead = alias(/^u$/, 'textDecoration', /underline/);
const strikeRead = alias(/^(strike|del)$/, 'textDecoration', /line-through/);

/** The rich text marks' forms, in their registration order (export wraps the first innermost). */
/* @__NO_SIDE_EFFECTS__ */
const markForms = () =>
	({
		bold: { tag: 'strong', parse: boldRead },
		italic: { tag: 'em', parse: italicRead },
		underline: { tag: 'u', parse: underlineRead },
		strike: { tag: 's', parse: strikeRead },
		code: { tag: 'code' },
		// Typing at a link's trailing edge extends it only from inside the anchor.
		link: { ...richTextMarks.link, tag: 'a', attributes: linkAttributes, parse: linkRead },
		superscript: { tag: 'sup' },
		subscript: { tag: 'sub' },
		color: { tag: 'span', attributes: styled('color'), parse: colorRead },
		highlight: { tag: 'span', attributes: styled('background-color'), parse: highlightRead }
	}) satisfies Record<string, MarkForms & Pick<MarkDefinition, 'edge'>>;
/** The rich text marks' forms, in their registration order (export wraps the first innermost). */
export const richTextMarkForms = markForms();

// Code --------------------------------------------------------------------

const codeLineWrite: Form = { html: (_, content) => `<pre><code>${content}</code></pre>` };
/** The code plugin's forms: a block of `codeLine`s. */
export const codeForms = (): Rows => ({ code: codeKinds.code, codeLine: codeLineWrite });

// Tables ------------------------------------------------------------------

/** A table's HTML: its rows, the header row's and column's cells as `th`. */
export const tableHtml = (data: Record<string, unknown>, rows: string) => {
	let html = rows;
	if (data.headerColumn === true)
		html = html.replace(/<tr><td>([\s\S]*?)<\/td>/g, '<tr><th>$1</th>');
	if (data.headerRow === true)
		html = html.replace(/^<tr>[\s\S]*?<\/tr>/, (row) => row.replace(/<(\/?)td>/g, '<$1th>'));
	return `<table><tbody>${html}</tbody></table>`;
};
/** A row's cells (`td`, `th`). */
const cellsOf = (row: Element | null | undefined) =>
	[...(row?.children ?? [])].filter((cell) => /^t[dh]$/.test(cell.localName));
/** An imported `<table>`'s data: a column per cell of its widest row, its header flags. */
export const parseTable = (table: HTMLElement) => {
	// Its own rows, not a nested table's.
	const rows = [...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table);
	const width = Math.max(1, ...rows.map((tr) => cellsOf(tr).length));
	const head = (cell: Element | undefined) => cell?.localName === 'th';
	const headerRow = rows.length > 1 && cellsOf(rows[0]).every(head);
	const headerColumn =
		rows.length > 0 && rows.slice(headerRow ? 1 : 0).every((tr) => head(cellsOf(tr)[0]));
	return {
		columns: Array.from({ length: width }, (_, i) => ({ id: `c${i + 1}` })),
		...(headerRow && { headerRow: true }),
		...(headerColumn && !headerRow && { headerColumn: true })
	};
};
/** An imported cell's column: its position in its row (`c1`, `c2`, … as its table's). */
export const parseCell = (cell: HTMLElement) => ({
	column: `c${Math.max(0, cellsOf(cell.parentElement).indexOf(cell)) + 1}`
});
const tableWrite: Form = {
	html: (block, _, rows) => tableHtml(block.data ?? {}, rows),
	plain: children
};
const tableRead: Form = { parse: claims('table', parseTable) };
const rowWrite: Form = {
	html: (_, __, cells) => wrap('tr', cells),
	plain: (_, __, cells) => cells.split('\n').join('\t')
};
const rowRead: Form = { parse: claims('tr') };
const cellWrite: Form = {
	html: (_, content) => wrap('td', content),
	plain: (_, content) => content.replace(/\n/g, ' ')
};
const cellRead: Form = { parse: claims('td,th', parseCell) };
/** The table plugin's forms. */
export const tableForms = (): Rows => ({
	table: { ...tableKinds.table, ...tableWrite, ...tableRead },
	tableRow: { ...tableKinds.tableRow, ...rowWrite, ...rowRead },
	tableCell: { ...tableKinds.tableCell, ...cellWrite, ...cellRead }
});

// Images and media --------------------------------------------------------

/** A media block's HTML: its `figure` (with `mark`), `media` in it, then its caption. */
const figure = (media: string, caption: string, mark = '') =>
	`<figure${mark}>${media}<figcaption>${caption}</figcaption></figure>`;
/** A link to `href` reading `text` (escaped), or nothing without `href`. */
const anchor = (href: string | null | undefined, text: string | null | undefined) =>
	href ? `<a href="${escapeHtml(href)}">${escapeHtml(text ?? '')}</a>` : '';

const imageWrite: Form = {
	html: (block, caption) => {
		const src = safeImageSrc(block.data?.src);
		const width = imageWidthOf(block.data);
		const align = imageAlignOf(block.data);
		const img = src
			? `<img src="${escapeHtml(src)}" alt="${escapeHtml(imageAltOf(block.data))}"${width ? ` width="${Math.round(width)}"` : ''}>`
			: '';
		return figure(img, caption, align === 'center' ? '' : ` data-align="${align}"`);
	}
};
const imageRead: Form = {
	// A `figure` holding an `img`, or a bare `img`, with an accepted
	// source; a pasted inline image over the cap is not imported.
	parse: (el) => {
		if (el.localName === 'img') return imgData(el) ?? undefined;
		const data = el.localName === 'figure' && imgData(el.querySelector('img'));
		const align = data && el.getAttribute('data-align');
		return data ? (align === 'left' || align === 'right' ? { ...data, align } : data) : undefined;
	}
};
/** The image plugin's forms: a `figure`. */
export const imageForms = (): Rows => ({
	image: { ...imageKinds.image, ...imageWrite, ...imageRead }
});

/** A bookmark's stored text field: trimmed, capped. */
export const capped = (value: unknown, max: number) =>
	typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
/** A media block's plain text: its source, then its caption. */
const sourcePlain = (source: string | null, caption: string) =>
	[source, caption].filter(Boolean).join('\n');
const webPlain = (block: JSONBlock, caption: string) =>
	sourcePlain(safeWebUrl(block.data?.url), caption);

const embedWrite = (providers: readonly EmbedProvider[]): Form => ({
	html: (block, caption) => {
		const player = embedSourceOf(block.data?.url, providers);
		const url = safeWebUrl(block.data?.url);
		return figure(
			player
				? `<iframe src="${escapeHtml(player.src)}" title="${escapeHtml(player.provider.name)}" sandbox="${EMBED_SANDBOX}" allowfullscreen></iframe>`
				: anchor(url, url),
			caption
		);
	},
	plain: webPlain
});
const embedRead = (providers: readonly EmbedProvider[]): Form => ({
	// An allowlisted `iframe` (bare, or in a `figure`): its `src` is the link.
	parse: (el) => {
		const src = claimed(el, 'iframe')?.getAttribute('src');
		const url = embedSourceOf(src, providers) && safeWebUrl(src);
		return url ? { url } : undefined;
	}
});
const bookmarkWrite: Form = {
	html: (block, caption) => {
		const url = safeWebUrl(block.data?.url);
		return figure(
			anchor(url, capped(block.data?.title, 300) ?? url),
			caption,
			' data-edytor-bookmark'
		);
	},
	plain: webPlain
};
// Its own export: a `figure[data-edytor-bookmark]` holding the link.
const bookmarkRead: Form = {
	parse: claims('figure[data-edytor-bookmark]', (el) => {
		const link = el.querySelector('a[href]');
		const url = safeWebUrl(link?.getAttribute('href'));
		const title = capped(link?.textContent, 300);
		return url ? { url, ...(title && title !== url ? { title } : {}) } : undefined;
	})
};
const fileWrite: Form = {
	html: (block, caption) => {
		const src = safeMediaSrc(block.data?.src);
		return figure(anchor(src, fileNameFor(block.data, src)), caption, ' data-edytor-file');
	},
	plain: (block, caption) => sourcePlain(safeMediaSrc(block.data?.src), caption)
};
// Its own export: a `figure[data-edytor-file]` holding the link.
const fileRead: Form = {
	parse: claims('figure[data-edytor-file]', (el) => {
		const link = el.querySelector('a[href]');
		const src = safeMediaSrc(link?.getAttribute('href'));
		const name = link?.textContent?.trim().slice(0, 300);
		return src ? { src, name: name || fileNameOf(src) } : undefined;
	})
};
/** A `video`'s or an `audio`'s HTML: `<video src="…" controls></video>` in its `figure`. */
const sourceWrite = (kind: string): Form => ({
	html: (block, caption) => {
		const src = safeMediaSrc(block.data?.src);
		return figure(src ? `<${kind} src="${escapeHtml(src)}" controls></${kind}>` : '', caption);
	}
});
const sourceRead = (kind: string): Form => ({
	parse: (el) => {
		const src = mediaSourceOf(claimed(el, kind));
		return src ? { src } : undefined;
	}
});
/** The media plugins' forms; `providers` are the embed players the view allows. */
export const mediaForms = (providers: readonly EmbedProvider[] = EMBED_PROVIDERS): Rows => ({
	embed: { ...mediaKinds.embed, ...embedWrite(providers), ...embedRead(providers) },
	bookmark: { ...mediaKinds.bookmark, ...bookmarkWrite, ...bookmarkRead },
	file: { ...mediaKinds.file, ...fileWrite, ...fileRead },
	video: { ...mediaKinds.video, ...sourceWrite('video'), ...sourceRead('video') },
	audio: { ...mediaKinds.audio, ...sourceWrite('audio'), ...sourceRead('audio') }
});

// Pages, contents, equations, columns -------------------------------------

const pageWrite = (options: PagePluginOptions = {}, untitled = 'Untitled'): Form => ({
	html: (block) => pageHtml(block.data, options, untitled),
	plain: (block) => pageTitleOf(block.data?.title) ?? untitled
});
// Its own export: a `p[data-edytor-page]` naming the page.
const pageRead: Form = {
	parse: claims('p[data-edytor-page]', (el) => {
		const pageId = pageIdOf(el.getAttribute('data-edytor-page'));
		const title = pageTitleOf(el.textContent);
		return pageId ? { pageId, ...(title && { title }) } : undefined;
	})
};
/** The page plugin's forms; `untitled` names a page without a title. */
export const pageForms = (options: PagePluginOptions = {}, untitled = 'Untitled'): Rows => ({
	page: { ...pageKinds.page, ...pageWrite(options, untitled), ...pageRead }
});

const tocWrite: Form = { html: () => '<nav data-edytor-toc></nav>', plain: () => '' };
const tocRead: Form = { parse: claims('nav[data-edytor-toc]') };
/** The table of contents plugin's forms: drawn from the document, never carried. */
export const tocForms = (): Rows => ({ toc: { ...tocKinds.toc, ...tocWrite, ...tocRead } });

/** MathML for a TeX source: KaTeX's in a view once loaded, else the source in its annotation. */
export type MathML = (tex: string, display: boolean) => string;

const equationWrite = (mathml: MathML): Form => ({
	html: (block) => `<div data-edytor-equation>${mathml(expressionOf(block.data), true)}</div>`,
	plain: (block) => expressionOf(block.data)
});
const equationRead: Form = { parse: (el) => parseEquation(el, true) };
const inlineEquationWrite = (mathml: MathML): AtomForms => ({
	plain: expressionOf,
	html: (data) => mathml(expressionOf(data), false)
});
const inlineEquationRead: AtomForms = { parse: (el) => parseEquation(el, false) };
/** The equation plugin's forms. */
export const equationForms = (mathml: MathML = sourceMathml) => ({
	blocks: { equation: { ...equationKinds.equation, ...equationWrite(mathml), ...equationRead } },
	inlineBlocks: { inlineEquation: { ...inlineEquationWrite(mathml), ...inlineEquationRead } }
});

/** A column's weight: `data.width`, a positive number, else 1. */
export const weightOf = (data: Data) => {
	const width = data?.width;
	return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 1;
};
const columnsWrite: Form = {
	html: (_, __, inner) => `<div data-edytor-columns>${inner}</div>`,
	plain: children
};
const columnsRead: Form = { parse: claims('[data-edytor-columns]') };
const columnWrite: Form = {
	html: (block, _, inner) =>
		`<div data-edytor-column data-width="${weightOf(block.data)}">${inner}</div>`,
	plain: children
};
const columnRead: Form = {
	parse: claims('[data-edytor-column]', (el) => {
		// A weight read back from `data-width`, when it is one.
		const width = Number(el.getAttribute('data-width'));
		return Number.isFinite(width) && width > 0 ? { width } : {};
	})
};
/** The columns plugin's forms. */
export const columnsForms = (): Rows => ({
	columns: { ...layoutKinds.columns, ...columnsWrite, ...columnsRead },
	column: { ...layoutKinds.column, ...columnWrite, ...columnRead }
});

// Atoms -------------------------------------------------------------------

/** A string field of an atom's data, else `''`. */
const field = (data: unknown, key: string) => {
	const value = (data as Data)?.[key];
	return typeof value === 'string' ? value : '';
};
const mentionWrite = (kind: string, char: string): AtomForms => ({
	plain: (data) => char + field(data, 'label'),
	html: (data) => {
		const id = (data as Data)?.id;
		return (
			`<span data-edytor-mention="${escapeHtml(kind)}"` +
			(typeof id === 'string' ? ` data-mention-id="${escapeHtml(id)}"` : '') +
			`>${escapeHtml(char + field(data, 'label'))}</span>`
		);
	}
});
const mentionRead = (kind: string, char: string): AtomForms => ({
	parse: (element: HTMLElement) => {
		// A bare `data-edytor-mention` (an older export) is a `mention`.
		const own = element.getAttribute('data-edytor-mention');
		if (own === null || (own || 'mention') !== kind) return undefined;
		const text = element.textContent ?? '';
		const label = text.startsWith(char) ? text.slice(char.length) : text;
		return { id: element.getAttribute('data-mention-id') ?? '', label };
	}
});
/** A mention atom's forms (`@Ada`): `kind` is its atom type, `char` its trigger. */
export const mentionForms = (kind = 'mention', char = '@'): AtomForms => ({
	...mentionWrite(kind, char),
	...mentionRead(kind, char)
});
/** A page link atom's forms: its title. */
export const pageLinkForms = (): AtomForms => ({ plain: (data) => field(data, 'title') });

// The export's own forms -----------------------------------------------------

/** A child block's text joined (a code line's): marks and atoms aside. */
const textOf = (block: JSONBlock) =>
	(block.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
/** A code block's lines. */
const linesOf = (block: JSONBlock) => (block.children ?? []).map(textOf).join('\n');

/**
 * The HTML forms a view's clipboard does without, filled in by `toHTML` for
 * the records that lack them: a toggle's `<details>`, a code block's one
 * `<pre>` naming its language.
 */
export const htmlExtras = (): Rows => ({
	code: {
		html: (block) => {
			const language = languageOf(block.data?.language);
			const named = language ? escapeHtml(language) : '';
			return `<pre${named && ` data-language="${named}"`}><code${named && ` class="language-${named}"`}>${escapeHtml(linesOf(block))}</code></pre>`;
		},
		plain: linesOf
	},
	toggle: { html: (_, content, children) => disclosure(content, children) }
});
/** The import hooks a view's paste does without, filled in by `fromHTML`. */
export const parseExtras = (): Rows => ({
	// A `pre`, its language from its own or its `code`'s class or attribute.
	code: {
		parse: claims('pre', (el) => {
			const code = [...el.children].find((child) => child.localName === 'code');
			const named = [el, code].map(
				(at) =>
					at?.getAttribute('data-language') ??
					/(?:^|\s)(?:language|lang)-([\w#+.-]+)/.exec(at?.getAttribute('class') ?? '')?.[1]
			);
			const language = languageOf(named.find(Boolean));
			return language ? { language } : {};
		})
	},
	// Its own export, and a GitHub task list's item.
	'todo-item': {
		parse: claims('li', (el) => {
			const box = [...el.children].find(
				(child) => child.localName === 'input' && child.getAttribute('type') === 'checkbox'
			);
			return box ? { checked: box.hasAttribute('checked') } : undefined;
		})
	}
});

/** The records `toHTML` reads by default: every bundled kind's, mark's and atom's HTML writing. */
export const bundledWrite = () => ({
	blocks: {
		heading: headingWrite,
		'bulleted-list-item': itemWrite,
		'numbered-list-item': itemWrite,
		'todo-item': todoWrite,
		'toggle-heading': toggleHeadingWrite,
		callout: calloutWrite(iconOf),
		quote: quoteWrite,
		divider: dividerWrite,
		'ordered-list': orderedWrite,
		'unordered-list': unorderedWrite,
		'list-item': itemWrite,
		codeLine: codeLineWrite,
		table: tableWrite,
		tableRow: rowWrite,
		tableCell: cellWrite,
		image: imageWrite,
		embed: embedWrite(EMBED_PROVIDERS),
		bookmark: bookmarkWrite,
		file: fileWrite,
		video: sourceWrite('video'),
		audio: sourceWrite('audio'),
		page: pageWrite(),
		toc: tocWrite,
		equation: equationWrite(sourceMathml),
		columns: columnsWrite,
		column: columnWrite,
		...htmlExtras()
	} as Rows,
	marks: {
		bold: { tag: 'strong' },
		italic: { tag: 'em' },
		underline: { tag: 'u' },
		strike: { tag: 's' },
		code: { tag: 'code' },
		link: { tag: 'a', attributes: linkAttributes },
		superscript: { tag: 'sup' },
		subscript: { tag: 'sub' },
		color: { tag: 'span', attributes: styled('color') },
		highlight: { tag: 'span', attributes: styled('background-color') }
	} as Record<string, MarkForms>,
	inlineBlocks: {
		mention: mentionWrite('mention', '@'),
		pageLink: pageLinkForms(),
		inlineEquation: inlineEquationWrite(sourceMathml)
	}
});

/**
 * The records `fromHTML` reads by default: every bundled kind's roles, its
 * presets' data (HTML import finds a kind by a preset's tag: an `h2`, a
 * `blockquote`) and its HTML reading, in the plugins' order (the first
 * kind claiming an element wins).
 */
export const bundledRead = () => {
	const levels = { presets: HEADING_LEVELS.map((level) => ({ data: { level } })) };
	const one = { presets: [{}] };
	return {
		blocks: {
			paragraph: {},
			heading: { ...headingRead, ...levels },
			'bulleted-list-item': { ...itemRead, ...one },
			'numbered-list-item': { ...numberedRead, ...one },
			'todo-item': { presets: [{ data: { checked: false } }] },
			toggle: { ...toggleRead, ...one },
			'toggle-heading': { ...toggleHeadingRead, ...levels },
			callout: { ...calloutRead, ...one },
			quote: { ...quoteRead, ...one },
			divider: { ...richTextKinds.divider, ...dividerRead, ...one },
			'ordered-list': { ...richTextKinds['ordered-list'], ...orderedRead },
			'unordered-list': { ...richTextKinds['unordered-list'], ...unorderedRead },
			'list-item': itemRead,
			code: codeKinds.code,
			codeLine: {},
			table: { ...tableKinds.table, ...tableRead },
			tableRow: { ...tableKinds.tableRow, ...rowRead },
			tableCell: { ...tableKinds.tableCell, ...cellRead },
			image: { ...imageKinds.image, ...imageRead },
			embed: { ...mediaKinds.embed, ...embedRead(EMBED_PROVIDERS) },
			bookmark: { ...mediaKinds.bookmark, ...bookmarkRead },
			file: { ...mediaKinds.file, ...fileRead },
			video: { ...mediaKinds.video, ...sourceRead('video') },
			audio: { ...mediaKinds.audio, ...sourceRead('audio') },
			page: { ...pageKinds.page, ...pageRead },
			toc: { ...tocKinds.toc, ...tocRead },
			equation: { ...equationKinds.equation, ...equationRead },
			columns: { ...layoutKinds.columns, ...columnsRead },
			column: { ...layoutKinds.column, ...columnRead }
		} as Record<string, BlockForms>,
		marks: {
			bold: { tag: 'strong', parse: boldRead },
			italic: { tag: 'em', parse: italicRead },
			underline: { tag: 'u', parse: underlineRead },
			strike: { tag: 's', parse: strikeRead },
			code: { tag: 'code' },
			link: { parse: linkRead },
			superscript: { tag: 'sup' },
			subscript: { tag: 'sub' },
			color: { parse: colorRead },
			highlight: { parse: highlightRead }
		} as Record<string, MarkForms>,
		inlineBlocks: {
			mention: mentionRead('mention', '@'),
			inlineEquation: inlineEquationRead
		}
	};
};

/**
 * Sibling blocks' HTML (`toHTML`): a run of list items no list element
 * holds (a document's items are siblings, `<li>` alone) is wrapped in its
 * list's tag, the one its container kind exports (`ol` for numbered items).
 */
export const listSiblings =
	(kinds: ExportKinds): SiblingsHtml =>
	(blocks, html, parent) => {
		let out = '';
		let open: string | null = null;
		blocks.forEach((block, i) => {
			let list: string | null = null;
			if (parent !== 'ul' && parent !== 'ol' && /^<li[\s>]/.test(html[i]!)) {
				list = 'ul';
				for (const [, kind] of kinds.blocks)
					if (kind.itemKind === block.type && (kind.html === 'ol' || kind.html === 'ul'))
						list = kind.html;
			}
			if (open && open !== list) out += `</${open}>`;
			if (list && open !== list) out += `<${list}>`;
			open = list;
			out += html[i];
		});
		return open ? `${out}</${open}>` : out;
	};

// Markdown -------------------------------------------------------------------

/** A markdown link destination: `<…>` when it holds a space or a parenthesis. */
const destination = (href: string) =>
	/[\s()<>]/.test(href) ? `<${href.replace(/>/g, '%3E')}>` : href;
/** Text for a markdown link's label: its brackets and backslashes escaped. */
const label = (text: string) => text.replace(/[\\[\]]/g, (c) => `\\${c}`);
/** A markdown link reading `text` (else its href), or nothing without `href`. */
const link = (text: string, href: string | null | undefined) =>
	href ? `[${label(text || href)}](${destination(href)})` : '';
/** Parts a blank line apart, the empty ones left out. */
const apart = (...parts: string[]) => parts.filter(Boolean).join('\n\n');
/** A quote's lines, each behind `> `. */
const quoted = (text: string) => text.replace(/^(.?)/gm, (_, c: string) => (c ? `> ${c}` : '>'));
/** A list item's markdown: its marker and text, its children indented under it. */
const item =
	(marker: (block: JSONBlock, index: number) => string): BlockMarkdown =>
	(block, content, children, { index, indent }) => {
		const own = marker(block, index);
		return own + content + (children && `\n${indent(children, ' '.repeat(own.length))}`);
	};
/** A `<details>` disclosure: GitHub and most readers show it folded; `textToBlocks` reads it back. */
const details = (summary: string, children: string) =>
	`<details>\n<summary>${summary}</summary>\n\n${children && `${children}\n\n`}</details>`;
/** A media block's link line (a bookmark's, a file's) reading `text`, its caption after it. */
const linkLine =
	(read: (data: Data) => [string, string | null]): BlockMarkdown =>
	(block, caption, children) => {
		const [text, href] = read(block.data);
		return apart(link(text, href), caption, children);
	};

/** Each bundled kind's Markdown form. */
const markdownForms = (): Record<string, BlockMarkdown> => {
	const media = linkLine((data) => {
		const src = safeMediaSrc(data?.src);
		return [src ?? '', src];
	});
	return {
		heading: (block, content, children) =>
			apart(`${'#'.repeat(Number(levelOf(block.data).slice(1)))} ${content}`, children),
		'bulleted-list-item': item(() => '- '),
		'numbered-list-item': item((_, index) => `${index}. `),
		'todo-item': item((block) => `- [${block.data?.checked === true ? 'x' : ' '}] `),
		'list-item': item(() => '- '),
		toggle: (_, content, children) => details(content, children),
		'toggle-heading': (block, content, children) =>
			details(wrap(levelOf(block.data), content), children),
		// A GitHub alert: `> [!NOTE]`, then the icon and the title, then the content.
		callout: (block, content, children) =>
			quoted(
				[
					'[!NOTE]',
					[iconOf(block.data), content].filter(Boolean).join(' '),
					...(children ? ['', children] : [])
				].join('\n')
			),
		quote: (_, content, children) => quoted(apart(content, children)),
		divider: () => '---',
		// Its items are `list-item`s: numbered here.
		'ordered-list': (_, __, children) => {
			let n = 0;
			return children.replace(/^- /gm, () => `${++n}. `);
		},
		'unordered-list': children,
		code: (block) => {
			const lines = linesOf(block);
			// A fence longer than any backtick run its lines start with (three at least).
			const fence = '`'.repeat(
				Math.max(3, ...[...lines.matchAll(/^\s*(`{3,})/gm)].map((m) => m[1]!.length + 1))
			);
			return `${fence}${languageOf(block.data?.language) ?? ''}\n${lines}${lines && '\n'}${fence}`;
		},
		codeLine: textOf,
		table: (block, _, __, { inline }) => {
			// The rows as cells in the columns' order (`data.columns`), each row padded to them.
			const listed = block.data?.columns;
			const columns = (Array.isArray(listed) ? (listed as { id?: unknown }[]) : [])
				.map((c) => c?.id)
				.filter((id) => typeof id === 'string');
			const rows = (block.children ?? []).map((row) => {
				const cells = row.children ?? [];
				return (
					columns.length
						? columns.map((id) => cells.find((cell) => cell.data?.column === id)?.content)
						: cells.map((cell) => cell.content)
				).map((content) =>
					inline(content ?? [])
						.replace(/\|/g, '\\|')
						.replace(/\\\n/g, '<br>')
				);
			});
			if (!rows.length) return '';
			const width = Math.max(1, ...rows.map((row) => row.length));
			const line = (row: string[]) =>
				`| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
			return [line(rows[0]!), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join(
				'\n'
			);
		},
		tableCell: (_, content) => content,
		image: (block, caption, children) => {
			const src = safeImageSrc(block.data?.src);
			const title = caption && ` "${caption.replace(/"/g, '\\"')}"`;
			return src
				? apart(`![${label(imageAltOf(block.data))}](${destination(src)}${title})`, children)
				: apart(caption, children);
		},
		embed: linkLine((data) => {
			const url = safeWebUrl(data?.url);
			return [url ?? '', url];
		}),
		bookmark: linkLine((data) => {
			const url = safeWebUrl(data?.url);
			return [capped(data?.title, 300) ?? url ?? '', url];
		}),
		file: linkLine((data) => {
			const src = safeMediaSrc(data?.src);
			return [fileNameFor(data, src), src];
		}),
		video: media,
		audio: media,
		page: (block) => {
			const title = pageTitleOf(block.data?.title) ?? 'Untitled';
			return link(title, pageHref({}, pageIdOf(block.data?.pageId))) || label(title);
		},
		toc: () => '',
		equation: (block) => `$$\n${expressionOf(block.data)}\n$$`,
		columns: children,
		column: children
	};
};

/** Each rich text mark's delimiters; an unsafe link exports its text alone, as it renders inert. */
const markMarkdown = (): Record<string, NonNullable<MarkDefinition['markdown']>> => ({
	bold: ['**', '**'],
	italic: ['*', '*'],
	strike: ['~~', '~~'],
	code: ['`', '`'],
	link: (value: { href?: unknown }) => {
		const href = sanitizeLinkHref(value?.href);
		return href ? (['[', `](${destination(href)})`] as const) : undefined;
	}
});

/** Each bundled atom's Markdown form (else its `plain` form). */
const atomMarkdown = (): Record<string, NonNullable<InlineBlockDefinition['markdown']>> => ({
	inlineEquation: (data: unknown) => `$${expressionOf(data)}$`
});

/** Each form of `forms` as a record's `markdown` form. */
const rowsOf = <T>(forms: Record<string, unknown>) =>
	Object.fromEntries(
		Object.entries(forms).map(([name, markdown]) => [name, { markdown }])
	) as Record<string, T>;

/** The Markdown forms by name, filled in by `toMarkdown` for the records that lack them. */
export const markdownExtras = () => ({
	blocks: rowsOf<BlockForms>(markdownForms()),
	marks: rowsOf<MarkForms>(markMarkdown()),
	inlineBlocks: rowsOf<AtomForms>(atomMarkdown())
});

/** The records `toMarkdown` reads by default: the Markdown forms, and the atoms' plain text. */
export const bundledMarkdown = () => {
	const forms = markdownExtras();
	return {
		...forms,
		inlineBlocks: {
			mention: { plain: mentionWrite('mention', '@').plain },
			pageLink: pageLinkForms(),
			...forms.inlineBlocks
		}
	};
};
