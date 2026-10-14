/**
 * The bundled kinds' export and import forms as data: each kind's `html`,
 * `plain` and `parse` forms (a mark's `tag`, `attributes` and `parse`),
 * the rows the bundled plugins spread into their
 * kind records. One rule per kind: the clipboard, `toHTML`, `toMarkdown`
 * and `fromHTML` read these same functions, in a view (its records) and on
 * a server ({@link bundledForms}). No Svelte, no DOM state: Worker-safe.
 */
import type { JSONBlock } from '$lib/utils/json.js';
import { sanitizeCssColorValue, sanitizeLinkHref } from '$lib/utils/sanitize.js';
import {
	escapeHtml,
	type AtomForms,
	type BlockForms,
	type MarkForms
} from '$lib/clipboard/serializeClipboardFragment.js';
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
import { calloutHtml } from '$lib/plugins/richtext/callouts.js';
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
	safeMediaSrc,
	safeWebUrl,
	type EmbedProvider
} from '$lib/plugins/media/sources.js';
import { pageHtml, pageIdOf, pageTitleOf, type PagePluginOptions } from '$lib/plugins/page/page.js';
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

// Rich text ---------------------------------------------------------------

/**
 * Notion's three heading levels: a missing level is h1, any other (a
 * stored `h4`–`h6`, as HTML import reads them) h3.
 */
export const headingLevel = (level: unknown) =>
	level === 'h1' || level === 'h2' || level === 'h3' ? level : level === undefined ? 'h1' : 'h3';
/** The heading levels the rich text kinds create (their presets' data). */
export const HEADING_LEVELS = ['h1', 'h2', 'h3'] as const;
/**
 * A list's elements without list semantics (`role="none"`): a list's items
 * are sibling blocks, never the only children of one `ul` or `ol`, so an
 * `li` would be an orphan list item to assistive technology (WCAG 1.3.1);
 * the tags stay for styles and the HTML export.
 */
export const unlisted = (tag: 'li' | 'ul' | 'ol') => ({ tag, attributes: { role: 'none' } });
/** An unsafe scheme drops the href (and its target): an inert anchor still carries the text. */
const linkAttributes = (mark: { href?: unknown; target?: string }) => {
	const href = sanitizeLinkHref(mark?.href) ?? undefined;
	return { href, target: href && mark.target };
};
/** A hostile color value (a `;` payload would inject declarations) drops the style. */
const styled = (property: string) => (value: unknown) => {
	const safe = sanitizeCssColorValue(value);
	return { style: safe ? `${property}: ${safe};` : undefined };
};
/**
 * HTML import: a pasted color, sanitized, unless it is the page's
 * default (Google Docs writes black text and transparent backgrounds on
 * every span: they are no mark, and a black mark is unreadable in dark mode).
 */
const colorOf = (value: string, none: RegExp) =>
	none.test(value.replace(/\s+/g, '').toLowerCase())
		? undefined
		: (sanitizeCssColorValue(value) ?? undefined);
const INHERITED = 'initial|inherit|unset|revert|currentcolor';
const NO_COLOR = new RegExp(`^(${INHERITED}|black|windowtext|#000|#000000|rgba?\\(0,0,0(,1)?\\))$`);
const NO_HIGHLIGHT = new RegExp(
	`^(${INHERITED}|transparent|rgba\\(\\d+,\\d+,\\d+,0\\)|white|#fff|#ffffff|rgba?\\(255,255,255(,1)?\\))$`
);
/** HTML import: a tag alias (unless its own style says otherwise) or a style (Google Docs). */
const alias =
	(tags: RegExp, property: 'fontWeight' | 'fontStyle' | 'textDecoration', value: RegExp) =>
	(el: HTMLElement) =>
		(tags.test(el.localName) && !el.style[property]) || value.test(el.style[property]) || undefined;

/** The rich text marks' forms, in their registration order (export wraps the first innermost). */
export const richTextMarkForms = {
	bold: {
		tag: 'strong',
		parse: alias(/^b$/, 'fontWeight', /^(bold|[6-9]00)$/)
	},
	italic: { tag: 'em', parse: alias(/^i$/, 'fontStyle', /italic/) },
	underline: { tag: 'u', parse: alias(/^u$/, 'textDecoration', /underline/) },
	strike: {
		tag: 's',
		parse: alias(/^(strike|del)$/, 'textDecoration', /line-through/)
	},
	code: { tag: 'code' },
	// Typing at a link's trailing edge extends it only from inside the anchor.
	link: {
		...richTextMarks.link,
		tag: 'a',
		attributes: linkAttributes,
		parse: (el: HTMLElement) => {
			const href = el.localName === 'a' && sanitizeLinkHref(el.getAttribute('href'));
			const target = el.getAttribute('target');
			return href ? { href, ...(target ? { target } : {}) } : undefined;
		}
	},
	superscript: { tag: 'sup' },
	subscript: { tag: 'sub' },
	color: {
		tag: 'span',
		attributes: styled('color'),
		parse: (el: HTMLElement) => colorOf(el.style.color ?? '', NO_COLOR)
	},
	highlight: {
		tag: 'span',
		attributes: styled('background-color'),
		parse: (el: HTMLElement) => {
			const background = el.style.backgroundColor;
			if (background) return colorOf(background, NO_HIGHLIGHT);
			return el.localName === 'mark' ? 'yellow' : undefined;
		}
	}
} satisfies Record<string, MarkForms>;

/** A heading's element: its level's tag. */
const levelElement = (data: Record<string, unknown>) => headingLevel(data.level);
export const headingForms = {
	contentElement: levelElement,
	// HTML import: h1–h3 come from the presets (the plugin's); h4–h6 read as h3.
	parse: (el: HTMLElement) => (/^h[4-6]$/.test(el.localName) ? { level: 'h3' } : undefined),
	html: (block, content, children) => {
		const tag = headingLevel(block.data?.level);
		return `<${tag}>${content}</${tag}>${children}`;
	}
} satisfies BlockForms;
export const bulletedForms = { element: unlisted('li'), html: 'li' } satisfies BlockForms;
export const numberedForms = {
	...bulletedForms,
	// HTML import: an `li` is a bulleted item (the first `li` kind) unless its list is ordered.
	parse: (el: HTMLElement) =>
		el.localName === 'li' && el.parentElement?.localName === 'ol' ? {} : undefined
} satisfies BlockForms;
export const todoForms = {
	html: (block, content, children) =>
		`<li data-edytor-todo-item="true"><input type="checkbox"${block.data?.checked === true ? ' checked' : ''}>${content}${children}</li>`,
	plain: (block, content, children) =>
		[`${block.data?.checked === true ? '[x]' : '[ ]'} ${content}`.trim(), children]
			.filter(Boolean)
			.join('\n')
} satisfies BlockForms;
export const toggleForms = { element: 'details' } satisfies BlockForms;
export const toggleHeadingForms = {
	element: 'details',
	contentElement: levelElement,
	// HTML import: a `details` whose summary holds an h1–h3 (its own export).
	parse: (el: HTMLElement) => {
		if (el.localName !== 'details') return;
		const tag = el.querySelector(':scope > summary > :is(h1, h2, h3, h4, h5, h6)');
		return tag ? { level: headingLevel(tag.localName) } : undefined;
	},
	html: (block, content, children) => {
		const tag = headingLevel(block.data?.level);
		return `<details><summary><${tag}>${content}</${tag}></summary>${children}</details>`;
	}
} satisfies BlockForms;
export const calloutForms = {
	// HTML import: its own export, the icon in its attribute.
	parse: (el: HTMLElement) => {
		const own = el.getAttribute('data-edytor-callout');
		return own === null ? undefined : { icon: own };
	}
} satisfies BlockForms;
export const quoteForms = {
	contentElement: 'blockquote',
	html: 'blockquote'
} satisfies BlockForms;
export const dividerForms = {
	...richTextKinds.divider,
	element: 'hr',
	html: () => '<hr>',
	plain: () => '---'
} satisfies BlockForms;
export const orderedListForms = {
	...richTextKinds['ordered-list'],
	itemKind: 'numbered-list-item',
	element: unlisted('ol'),
	html: 'ol'
} satisfies BlockForms;
export const unorderedListForms = {
	...richTextKinds['unordered-list'],
	itemKind: 'bulleted-list-item',
	element: unlisted('ul'),
	html: 'ul'
} satisfies BlockForms;
export const listItemForms = bulletedForms;

/**
 * The rich text kinds' forms as one table (a server's). `callout` is the icon a
 * callout without one of its own shows.
 */
export const richTextForms = (callout: (data: Data) => string) =>
	({
		heading: headingForms,
		'bulleted-list-item': bulletedForms,
		'numbered-list-item': numberedForms,
		'todo-item': todoForms,
		toggle: toggleForms,
		'toggle-heading': toggleHeadingForms,
		callout: {
			...calloutForms,
			html: (block, content, children) => calloutHtml(callout(block.data), content, children)
		},
		quote: quoteForms,
		divider: dividerForms,
		'ordered-list': orderedListForms,
		'unordered-list': unorderedListForms,
		'list-item': listItemForms
	}) satisfies Record<string, BlockForms>;

// Code --------------------------------------------------------------------

/** The code plugin's forms: a block of `codeLine`s. */
export const codeForms = () =>
	({
		code: codeKinds.code,
		codeLine: {
			html: (_, content) => `<pre><code>${content}</code></pre>`
		}
	}) satisfies Record<string, BlockForms>;

// Tables ------------------------------------------------------------------

/** A table's HTML: its rows, the header row's and column's cells as `th`. */
export const tableHtml = (data: Record<string, unknown>, rows: string) => {
	let html = rows;
	if (data.headerColumn === true)
		html = html.replace(/<tr><td>([\s\S]*?)<\/td>/g, '<tr><th>$1</th>');
	if (data.headerRow === true)
		html = html.replace(
			/^<tr>([\s\S]*?)<\/tr>/,
			(_, row: string) => `<tr>${row.replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>')}</tr>`
		);
	return `<table><tbody>${html}</tbody></table>`;
};

/** The rows of an imported `<table>` (its own, not a nested table's). */
const rowsOf = (table: HTMLElement): HTMLElement[] =>
	[...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table) as HTMLElement[];
/** A row's cells (`td`, `th`). */
const cellsOf = (row: Element | undefined) =>
	[...(row?.children ?? [])].filter((cell) => /^t[dh]$/.test(cell.localName));

/** An imported `<table>`'s data: a column per cell of its widest row, its header flags. */
export const parseTable = (table: HTMLElement) => {
	const rows = rowsOf(table);
	const width = Math.max(1, ...rows.map((tr) => cellsOf(tr).length));
	const head = (cell: Element | undefined) => cell?.localName === 'th';
	const headerRow = rows.length > 1 && cellsOf(rows[0]).every((c) => head(c));
	const headerColumn =
		rows.length > 0 && rows.slice(headerRow ? 1 : 0).every((tr) => head(cellsOf(tr)[0]));
	return {
		columns: Array.from({ length: width }, (_, i) => ({ id: `c${i + 1}` })),
		...(headerRow && { headerRow: true }),
		...(headerColumn && !headerRow && { headerColumn: true })
	};
};

/** An imported cell's column: its position in its row (`c1`, `c2`, … as its table's). */
export const parseCell = (cell: HTMLElement) => {
	const index = cellsOf(cell.parentElement ?? undefined).indexOf(cell);
	return { column: `c${(index >= 0 ? index : 0) + 1}` };
};

/** The table plugin's forms. */
export const tableForms = () =>
	({
		table: {
			...tableKinds.table,
			html: (block, _, children) => tableHtml(block.data ?? {}, children),
			plain: (_, __, children) => children,
			parse: (element: HTMLElement) =>
				element.localName === 'table' ? parseTable(element) : undefined
		},
		tableRow: {
			...tableKinds.tableRow,
			html: (_, __, children) => `<tr>${children}</tr>`,
			plain: (_, __, children) => children.split('\n').join('\t'),
			parse: (element: HTMLElement) => (element.localName === 'tr' ? {} : undefined)
		},
		tableCell: {
			...tableKinds.tableCell,
			html: (_, content) => `<td>${content}</td>`,
			plain: (_, content) => content.replace(/\n/g, ' '),
			parse: (element: HTMLElement) =>
				/^t[dh]$/.test(element.localName) ? parseCell(element) : undefined
		}
	}) satisfies Record<string, BlockForms>;

// Images and media --------------------------------------------------------

/** The image plugin's forms: a `figure`. */
export const imageForms = () =>
	({
		image: {
			...imageKinds.image,
			html: (block, caption) => {
				const src = safeImageSrc(block.data?.src);
				const width = imageWidthOf(block.data);
				const align = imageAlignOf(block.data);
				const img = src
					? `<img src="${escapeHtml(src)}" alt="${escapeHtml(imageAltOf(block.data))}"${width ? ` width="${Math.round(width)}"` : ''}>`
					: '';
				return figure(img, caption, align === 'center' ? '' : ` data-align="${align}"`);
			},
			// A `figure` holding an `img`, or a bare `img`, with an accepted
			// source; a pasted inline image over the cap is not imported.
			parse: (el: HTMLElement) => {
				if (el.localName === 'img') return imgData(el) ?? undefined;
				const data = el.localName === 'figure' && imgData(el.querySelector('img'));
				if (!data) return undefined;
				const align = el.getAttribute('data-align');
				return align === 'left' || align === 'right' ? { ...data, align } : data;
			}
		}
	}) satisfies Record<string, BlockForms>;

/** A bookmark's stored text field: trimmed, capped. */
export const capped = (value: unknown, max: number) =>
	typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

/** A media block's HTML: its `figure` (with `mark`), `media` in it, then its caption. */
const figure = (media: string, caption: string, mark = '') =>
	`<figure${mark}>${media}<figcaption>${caption}</figcaption></figure>`;

/** A link to `href` reading `text` (escaped), or nothing without `href`. */
const anchor = (href: string | null | undefined, text: string | null | undefined) =>
	href ? `<a href="${escapeHtml(href)}">${escapeHtml(text ?? '')}</a>` : '';

/** A media block's plain text: its source (`read` of `data[key]`), then its caption. */
const sourcePlain =
	(
		read: (value: unknown) => string | null | undefined,
		key: string
	): ((block: JSONBlock, caption: string) => string) =>
	(block, caption) =>
		[read(block.data?.[key]), caption].filter(Boolean).join('\n');

/** The link of a media block's own export: a `figure[mark]` holding it. */
const ownLink = (el: HTMLElement, mark: string) =>
	el.localName === 'figure' && el.hasAttribute(mark) ? el.querySelector('a[href]') : undefined;

/** The media plugins' forms; `providers` are the embed players the view allows. */
export const mediaForms = (providers: readonly EmbedProvider[] = EMBED_PROVIDERS) => {
	/** A `video`'s or an `audio`'s forms. */
	const source = (kind: 'video' | 'audio') =>
		({
			...mediaKinds[kind],
			html: (block, caption) => {
				const src = safeMediaSrc(block.data?.src);
				// The tag, then its attributes: `<video src="…" controls></video>`.
				return figure(
					src ? `<${kind}` + ` src="${escapeHtml(src)}" controls></${kind}>` : '',
					caption
				);
			},
			parse: (el: HTMLElement) => {
				const src = mediaSourceOf(claimed(el, kind));
				return src ? { src } : undefined;
			}
		}) satisfies BlockForms;
	return {
		embed: {
			...mediaKinds.embed,
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
			plain: sourcePlain(safeWebUrl, 'url'),
			// An allowlisted `iframe` (bare, or in a `figure`): its `src` is the link.
			parse: (el) => {
				const src = claimed(el, 'iframe')?.getAttribute('src');
				const url = embedSourceOf(src, providers) && safeWebUrl(src);
				return url ? { url } : undefined;
			}
		},
		bookmark: {
			...mediaKinds.bookmark,
			html: (block, caption) => {
				const url = safeWebUrl(block.data?.url);
				return figure(
					anchor(url, capped(block.data?.title, 300) ?? url),
					caption,
					' data-edytor-bookmark'
				);
			},
			plain: sourcePlain(safeWebUrl, 'url'),
			// Its own export: a `figure[data-edytor-bookmark]` holding the link.
			parse: (el) => {
				const link = ownLink(el, 'data-edytor-bookmark');
				const url = safeWebUrl(link?.getAttribute('href'));
				const title = capped(link?.textContent, 300);
				return url ? { url, ...(title && title !== url ? { title } : {}) } : undefined;
			}
		},
		file: {
			...mediaKinds.file,
			html: (block, caption) => {
				const src = safeMediaSrc(block.data?.src);
				return figure(anchor(src, fileNameFor(block.data, src)), caption, ' data-edytor-file');
			},
			plain: sourcePlain(safeMediaSrc, 'src'),
			// Its own export: a `figure[data-edytor-file]` holding the link.
			parse: (el) => {
				const link = ownLink(el, 'data-edytor-file');
				const src = safeMediaSrc(link?.getAttribute('href'));
				const name = link?.textContent?.trim().slice(0, 300);
				return src ? { src, name: name || fileNameOf(src) } : undefined;
			}
		},
		video: source('video'),
		audio: source('audio')
	} satisfies Record<string, BlockForms>;
};

// Pages, contents, equations, columns -------------------------------------

/** The page plugin's forms; `untitled` names a page without a title. */
export const pageForms = (options: PagePluginOptions = {}, untitled = 'Untitled') =>
	({
		page: {
			...pageKinds.page,
			html: (block) => pageHtml(block.data, options, untitled),
			plain: (block) => pageTitleOf(block.data?.title) ?? untitled,
			// Its own export: a `p[data-edytor-page]` naming the page.
			parse: (el: HTMLElement) => {
				const pageId = pageIdOf(el.getAttribute('data-edytor-page'));
				if (el.localName !== 'p' || !pageId) return;
				const title = pageTitleOf(el.textContent);
				return { pageId, ...(title && { title }) };
			}
		}
	}) satisfies Record<string, BlockForms>;

/** The table of contents plugin's forms: drawn from the document, never carried. */
export const tocForms = () =>
	({
		toc: {
			...tocKinds.toc,
			html: () => '<nav data-edytor-toc></nav>',
			plain: () => '',
			parse: (el: HTMLElement) =>
				el.localName === 'nav' && el.hasAttribute('data-edytor-toc') ? {} : undefined
		}
	}) satisfies Record<string, BlockForms>;

/** MathML for a TeX source: KaTeX's in a view once loaded, else the source in its annotation. */
export type MathML = (tex: string, display: boolean) => string;

/** The equation plugin's forms. */
export const equationForms = (mathml: MathML = sourceMathml) => ({
	blocks: {
		equation: {
			...equationKinds.equation,
			html: (block) => `<div data-edytor-equation>${mathml(expressionOf(block.data), true)}</div>`,
			plain: (block) => expressionOf(block.data),
			parse: (element: HTMLElement) => parseEquation(element, true)
		}
	} satisfies Record<string, BlockForms>,
	inlineBlocks: {
		inlineEquation: {
			plain: (data) => expressionOf(data),
			html: (data) => mathml(expressionOf(data), false),
			parse: (element: HTMLElement) => parseEquation(element, false)
		}
	} satisfies Record<string, AtomForms>
});

/** A column's weight: `data.width`, a positive number, else 1. */
export const weightOf = (data: Data) => {
	const width = data?.width;
	return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 1;
};
/** A weight read back from HTML (`data-width`), when it is one. */
const parsedWidth = (element: HTMLElement): Record<string, number> => {
	const width = Number(element.getAttribute('data-width'));
	return Number.isFinite(width) && width > 0 ? { width } : {};
};

/** The columns plugin's forms. */
export const columnsForms = () =>
	({
		columns: {
			...layoutKinds.columns,
			html: (_, __, children) => `<div data-edytor-columns>${children}</div>`,
			plain: (_, __, children) => children,
			parse: (element: HTMLElement) =>
				element.hasAttribute('data-edytor-columns') ? {} : undefined
		},
		column: {
			...layoutKinds.column,
			html: (block, _, children) =>
				`<div data-edytor-column data-width="${weightOf(block.data)}">${children}</div>`,
			plain: (_, __, children) => children,
			parse: (element: HTMLElement) =>
				element.hasAttribute('data-edytor-column') ? parsedWidth(element) : undefined
		}
	}) satisfies Record<string, BlockForms>;

// Atoms -------------------------------------------------------------------

/** A mention's stored label. */
const mentionLabel = (data: unknown) => {
	const value = (data as { label?: unknown } | undefined)?.label;
	return typeof value === 'string' ? value : '';
};

/** A mention atom's forms (`@Ada`): `kind` is its atom type, `char` its trigger. */
export const mentionForms = (kind = 'mention', char = '@') =>
	({
		plain: (data) => char + mentionLabel(data),
		html: (data) => {
			const id = (data as { id?: unknown } | undefined)?.id;
			return (
				`<span data-edytor-mention="${escapeHtml(kind)}"` +
				(typeof id === 'string' ? ` data-mention-id="${escapeHtml(id)}"` : '') +
				`>${escapeHtml(char + mentionLabel(data))}</span>`
			);
		},
		parse: (element: HTMLElement) => {
			// A bare `data-edytor-mention` (an older export) is a `mention`.
			const own = element.getAttribute('data-edytor-mention');
			if (own === null || (own || 'mention') !== kind) return undefined;
			const text = element.textContent ?? '';
			const name = text.startsWith(char) ? text.slice(char.length) : text;
			return { id: element.getAttribute('data-mention-id') ?? '', label: name };
		}
	}) satisfies AtomForms;

/** A page link atom's forms: its title. */
export const pageLinkForms = () =>
	({
		plain: (data) => {
			const title = (data as { title?: unknown } | undefined)?.title;
			return typeof title === 'string' ? title : '';
		}
	}) satisfies AtomForms;
