/**
 * The bundled kinds' export and import forms as data: each kind's `html`,
 * `plain`, `markdown` and `parse` forms (a mark's `tag`, `attributes`,
 * `markdown` and `parse`), the rows the bundled plugins spread into their
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
	tableKinds,
	tocKinds
} from '$lib/crdt/semantics.js';
import { DEFAULT_CALLOUT_ICON, calloutHtml } from '$lib/plugins/richtext/callouts.js';
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

/** A child block's text joined (a code line's, a cell's): marks and atoms aside. */
const textOf = (block: JSONBlock) =>
	(block.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');

/** A markdown link destination: `<…>` when it holds a space or a parenthesis. */
const destination = (href: string) =>
	/[\s()<>]/.test(href) ? `<${href.replace(/>/g, '%3E')}>` : href;
/** Text for a markdown link's label: its brackets and backslashes escaped. */
const label = (text: string) => text.replace(/[\\[\]]/g, (c) => `\\${c}`);

/** A block's children markdown after its own line(s), a blank line apart. */
const then = (own: string, children: string) => (children ? `${own}\n\n${children}` : own);

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
		(tags.test(el.localName) && !el.style?.[property]) ||
		value.test(el.style?.[property] ?? '') ||
		undefined;

/** The rich text marks' forms, in their registration order (export wraps the first innermost). */
export const richTextMarkForms = {
	bold: {
		tag: 'strong',
		markdown: ['**', '**'],
		parse: alias(/^b$/, 'fontWeight', /^(bold|[6-9]00)$/)
	},
	italic: { tag: 'em', markdown: ['*', '*'], parse: alias(/^i$/, 'fontStyle', /italic/) },
	underline: { tag: 'u', parse: alias(/^u$/, 'textDecoration', /underline/) },
	strike: {
		tag: 's',
		markdown: ['~~', '~~'],
		parse: alias(/^(strike|del)$/, 'textDecoration', /line-through/)
	},
	code: { tag: 'code', markdown: ['`', '`'] },
	link: {
		tag: 'a',
		attributes: linkAttributes,
		// An unsafe href exports the text alone, as the anchor renders inert.
		markdown: (value: { href?: unknown }) => {
			const href = sanitizeLinkHref(value?.href);
			return href ? (['[', `](${destination(href)})`] as const) : undefined;
		},
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
		parse: (el: HTMLElement) => colorOf(el.style?.color ?? '', NO_COLOR)
	},
	highlight: {
		tag: 'span',
		attributes: styled('background-color'),
		parse: (el: HTMLElement) => {
			const background = el.style?.backgroundColor;
			if (background) return colorOf(background, NO_HIGHLIGHT);
			return el.localName === 'mark' ? 'yellow' : undefined;
		}
	}
} satisfies Record<string, MarkForms>;

/** A quote's lines, each behind `> `. */
const quoted = (text: string) =>
	text
		.split('\n')
		.map((line) => (line ? `> ${line}` : '>'))
		.join('\n');

/** A list item's markdown: its marker and text, its children indented under it. */
const item =
	(marker: (block: JSONBlock, index: number) => string): BlockForms['markdown'] =>
	(block, content, children, { index, indent }) => {
		const own = marker(block, index);
		return children
			? `${own}${content}\n${indent(children, ' '.repeat(own.length))}`
			: own + content;
	};

/**
 * The rich text kinds' forms. `callout` is the icon a callout without one
 * of its own shows (the view's default).
 */
export const richTextForms = (callout: (data: Data) => string = defaultIcon) =>
	({
		paragraph: {},
		heading: {
			contentElement: (data: Record<string, unknown>) => headingLevel(data.level),
			presets: HEADING_LEVELS.map((level) => ({ data: { level } })),
			// HTML import: h1–h3 come from the presets; h4–h6 read as h3.
			parse: (el: HTMLElement) => (/^h[4-6]$/.test(el.localName) ? { level: 'h3' } : undefined),
			html: (block, content, children) => {
				const tag = headingLevel(block.data?.level);
				return `<${tag}>${content}</${tag}>${children}`;
			},
			markdown: (block, content, children) =>
				then(`${'#'.repeat(Number(headingLevel(block.data?.level).slice(1)))} ${content}`, children)
		},
		'bulleted-list-item': {
			element: unlisted('li'),
			presets: [{}],
			html: 'li',
			markdown: item(() => '- ')
		},
		'numbered-list-item': {
			element: unlisted('li'),
			presets: [{}],
			html: 'li',
			// HTML import: an `li` is a bulleted item (the first `li` kind) unless its list is ordered.
			parse: (el: HTMLElement) =>
				el.localName === 'li' && el.parentElement?.localName === 'ol' ? {} : undefined,
			markdown: item((_, index) => `${index}. `)
		},
		'todo-item': {
			presets: [{ data: { checked: false } }],
			// HTML import: its own export, and a GitHub task list's item.
			parse: (el: HTMLElement) => {
				if (el.localName !== 'li') return;
				const box = [...el.children].find(
					(child) => child.localName === 'input' && child.getAttribute('type') === 'checkbox'
				);
				return box ? { checked: box.hasAttribute('checked') } : undefined;
			},
			html: (block, content, children) =>
				`<li data-edytor-todo-item="true"><input type="checkbox"${block.data?.checked === true ? ' checked' : ''}>${content}${children}</li>`,
			plain: (block, content, children) =>
				[`${block.data?.checked === true ? '[x]' : '[ ]'} ${content}`.trim(), children]
					.filter(Boolean)
					.join('\n'),
			markdown: item((block) => `- [${block.data?.checked === true ? 'x' : ' '}] `)
		},
		toggle: {
			element: 'details',
			presets: [{}],
			html: (_, content, children) => `<details><summary>${content}</summary>${children}</details>`,
			// A GitHub-style disclosure: markdown readers show it, `textToBlocks` reads it back.
			markdown: (_, content, children) =>
				`<details>\n<summary>${content}</summary>\n\n${children ? `${children}\n\n` : ''}</details>`
		},
		'toggle-heading': {
			element: 'details',
			contentElement: (data: Record<string, unknown>) => headingLevel(data.level),
			presets: HEADING_LEVELS.map((level) => ({ data: { level } })),
			// HTML import: a `details` whose summary holds an h1–h3 (its own export).
			parse: (el: HTMLElement) => {
				if (el.localName !== 'details') return;
				const summary = [...el.children].find((child) => child.localName === 'summary');
				const tag = [...(summary?.children ?? [])].find((child) =>
					/^h[1-6]$/.test(child.localName)
				);
				return tag ? { level: headingLevel(tag.localName) } : undefined;
			},
			html: (block, content, children) => {
				const tag = headingLevel(block.data?.level);
				return `<details><summary><${tag}>${content}</${tag}></summary>${children}</details>`;
			},
			markdown: (block, content, children) => {
				const tag = headingLevel(block.data?.level);
				return `<details>\n<summary><${tag}>${content}</${tag}></summary>\n\n${children ? `${children}\n\n` : ''}</details>`;
			}
		},
		callout: {
			presets: [{}],
			// HTML import: its own export, the icon in its attribute.
			parse: (el: HTMLElement) => {
				const own = el.getAttribute('data-edytor-callout');
				return own === null ? undefined : { icon: own };
			},
			html: (block, content, children) => calloutHtml(callout(block.data), content, children),
			// A GitHub alert: `> [!NOTE]`, then the icon and the title, then the content.
			markdown: (block, content, children) => {
				const icon = callout(block.data);
				const title = [icon, content].filter(Boolean).join(' ');
				return quoted(['[!NOTE]', title, ...(children ? ['', children] : [])].join('\n'));
			}
		},
		quote: {
			contentElement: 'blockquote',
			presets: [{}],
			html: 'blockquote',
			markdown: (_, content, children) => quoted(then(content, children))
		},
		divider: {
			...richTextKinds.divider,
			element: 'hr',
			presets: [{}],
			html: () => '<hr>',
			plain: () => '---',
			markdown: () => '---'
		},
		'ordered-list': {
			...richTextKinds['ordered-list'],
			itemKind: 'numbered-list-item',
			element: unlisted('ol'),
			html: 'ol',
			// Its items are `list-item`s: numbered here.
			markdown: (_, __, children) => {
				let n = 0;
				return children.replace(/^- /gm, () => `${++n}. `);
			}
		},
		'unordered-list': {
			...richTextKinds['unordered-list'],
			itemKind: 'bulleted-list-item',
			element: unlisted('ul'),
			html: 'ul',
			markdown: (_, __, children) => children
		},
		'list-item': { element: unlisted('li'), html: 'li', markdown: item(() => '- ') }
	}) satisfies Record<string, BlockForms>;

const defaultIcon = (data: Data) =>
	typeof data?.icon === 'string' ? data.icon : DEFAULT_CALLOUT_ICON;

// Code --------------------------------------------------------------------

/** A code block's language as stored: a short name, else none. */
const languageOf = (data: Data) =>
	typeof data?.language === 'string' && /^[\w#+.-]{1,40}$/.test(data.language)
		? data.language
		: undefined;

/** A fence longer than any backtick run of `text`'s line starts (three at least). */
const fenceFor = (text: string) =>
	'`'.repeat(Math.max(3, ...[...text.matchAll(/^\s*(`{3,})/gm)].map((m) => m[1]!.length + 1)));

/** The code plugin's forms: a block of `codeLine`s, its language in `data.language`. */
export const codeForms = () =>
	({
		code: {
			...codeKinds.code,
			html: (block) => {
				const language = languageOf(block.data);
				const lines = (block.children ?? []).map(textOf).join('\n');
				const attribute = language ? ` class="language-${escapeHtml(language)}"` : '';
				return `<pre${language ? ` data-language="${escapeHtml(language)}"` : ''}><code${attribute}>${escapeHtml(lines)}</code></pre>`;
			},
			plain: (block) => (block.children ?? []).map(textOf).join('\n'),
			// HTML import: a `pre`, its language from its own or its `code`'s class or attribute.
			parse: (el: HTMLElement): Record<string, string> | undefined => {
				if (el.localName !== 'pre') return;
				const code = [...el.children].find((child) => child.localName === 'code');
				const named = [el, code].map(
					(at) =>
						at?.getAttribute('data-language') ??
						/(?:^|\s)(?:language|lang)-([\w#+.-]+)/.exec(at?.getAttribute('class') ?? '')?.[1]
				);
				const language = languageOf({ language: named.find(Boolean) });
				return language ? { language } : {};
			},
			markdown: (block) => {
				const lines = (block.children ?? []).map(textOf).join('\n');
				const fence = fenceFor(lines);
				return `${fence}${languageOf(block.data) ?? ''}\n${lines}${lines ? '\n' : ''}${fence}`;
			}
		},
		codeLine: {
			html: (_, content) => `<pre><code>${content}</code></pre>`,
			markdown: (block) => textOf(block)
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

/** A table's rows as cells in its columns' order (`data.columns`), each row padded to them. */
const gridOf = (table: JSONBlock): JSONBlock[][] => {
	const columns = Array.isArray(table.data?.columns)
		? (table.data.columns as { id?: unknown }[])
				.map((c) => c?.id)
				.filter((id) => typeof id === 'string')
		: [];
	return (table.children ?? []).map((row) => {
		const cells = row.children ?? [];
		if (!columns.length) return cells;
		return columns.map(
			(id) => cells.find((cell) => cell.data?.column === id) ?? { type: 'tableCell' }
		);
	});
};

/** The table plugin's forms: a GFM table in markdown (its first row the header). */
export const tableForms = () =>
	({
		table: {
			...tableKinds.table,
			html: (block, _, children) => tableHtml(block.data ?? {}, children),
			plain: (_, __, children) => children,
			parse: (element: HTMLElement) =>
				element.localName === 'table' ? parseTable(element) : undefined,
			markdown: (block, _, __, { inline }) => {
				const rows = gridOf(block).map((cells) =>
					cells.map((cell) => inline(cell.content).replace(/\|/g, '\\|').replace(/\\\n/g, '<br>'))
				);
				if (!rows.length) return '';
				const width = Math.max(1, ...rows.map((row) => row.length));
				const line = (row: string[]) =>
					`| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
				return [
					line(rows[0]!),
					line(Array.from({ length: width }, () => '---')),
					...rows.slice(1).map(line)
				].join('\n');
			}
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
				/^t[dh]$/.test(element.localName) ? parseCell(element) : undefined,
			markdown: (_, content) => content
		}
	}) satisfies Record<string, BlockForms>;

// Images and media --------------------------------------------------------

/** A markdown link line (a bookmark's, a file's), its caption after it. */
const linkLine = (text: string, href: string | null, caption: string, children: string) =>
	then(
		[href ? `[${label(text || href)}](${destination(href)})` : '', caption]
			.filter(Boolean)
			.join('\n\n'),
		children
	);

/** The image plugin's forms: a `figure` in HTML, `![alt](src "caption")` in markdown. */
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
				const at = align === 'center' ? '' : ` data-align="${align}"`;
				return `<figure${at}>${img}<figcaption>${caption}</figcaption></figure>`;
			},
			// A `figure` holding an `img`, or a bare `img`, with an accepted
			// source; a pasted inline image over the cap is not imported.
			parse: (el: HTMLElement) => {
				if (el.localName === 'img') return imgData(el) ?? undefined;
				const data = el.localName === 'figure' && imgData(el.querySelector('img'));
				if (!data) return undefined;
				const align = el.getAttribute('data-align');
				return align === 'left' || align === 'right' ? { ...data, align } : data;
			},
			markdown: (block, caption, children) => {
				const src = safeImageSrc(block.data?.src);
				if (!src) return then(caption, children);
				const title = caption ? ` "${caption.replace(/"/g, '\\"')}"` : '';
				return then(`![${label(imageAltOf(block.data))}](${destination(src)}${title})`, children);
			}
		}
	}) satisfies Record<string, BlockForms>;

/** A bookmark's stored text field: trimmed, capped. */
const capped = (value: unknown, max: number) =>
	typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

/** The media plugins' forms; `providers` are the embed players the view allows. */
export const mediaForms = (providers: readonly EmbedProvider[] = EMBED_PROVIDERS) => {
	/** A `video`'s or an `audio`'s forms. */
	const source = (kind: 'video' | 'audio') =>
		({
			...mediaKinds[kind],
			html: (block, caption) => {
				const src = safeMediaSrc(block.data?.src);
				// The tag, then its attributes: `<video src="…" controls></video>`.
				const media = src ? `<${kind}` + ` src="${escapeHtml(src)}" controls></${kind}>` : '';
				return `<figure>${media}<figcaption>${caption}</figcaption></figure>`;
			},
			parse: (el: HTMLElement) => {
				const src = mediaSourceOf(claimed(el, kind));
				return src ? { src } : undefined;
			},
			markdown: (block, caption, children) => {
				const src = safeMediaSrc(block.data?.src);
				return linkLine(src ?? '', src, caption, children);
			}
		}) satisfies BlockForms;
	return {
		embed: {
			...mediaKinds.embed,
			html: (block, caption) => {
				const player = embedSourceOf(block.data?.url, providers);
				const url = safeWebUrl(block.data?.url);
				const media = player
					? `<iframe src="${escapeHtml(player.src)}" title="${escapeHtml(player.provider.name)}" sandbox="${EMBED_SANDBOX}" allowfullscreen></iframe>`
					: url
						? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`
						: '';
				return `<figure>${media}<figcaption>${caption}</figcaption></figure>`;
			},
			plain: (block, caption) => [safeWebUrl(block.data?.url), caption].filter(Boolean).join('\n'),
			// An allowlisted `iframe` (bare, or in a `figure`): its `src` is the link.
			parse: (el) => {
				const src = claimed(el, 'iframe')?.getAttribute('src');
				const url = embedSourceOf(src, providers) && safeWebUrl(src);
				return url ? { url } : undefined;
			},
			markdown: (block, caption, children) => {
				const url = safeWebUrl(block.data?.url);
				return linkLine(url ?? '', url, caption, children);
			}
		},
		bookmark: {
			...mediaKinds.bookmark,
			html: (block, caption) => {
				const url = safeWebUrl(block.data?.url);
				const title = capped(block.data?.title, 300) ?? url;
				const link = url ? `<a href="${escapeHtml(url)}">${escapeHtml(title!)}</a>` : '';
				return `<figure data-edytor-bookmark>${link}<figcaption>${caption}</figcaption></figure>`;
			},
			plain: (block, caption) => [safeWebUrl(block.data?.url), caption].filter(Boolean).join('\n'),
			// Its own export: a `figure[data-edytor-bookmark]` holding the link.
			parse: (el) => {
				if (el.localName !== 'figure' || !el.hasAttribute('data-edytor-bookmark')) return;
				const anchor = el.querySelector('a[href]');
				const url = safeWebUrl(anchor?.getAttribute('href'));
				const title = capped(anchor?.textContent, 300);
				return url ? { url, ...(title && title !== url ? { title } : {}) } : undefined;
			},
			markdown: (block, caption, children) => {
				const url = safeWebUrl(block.data?.url);
				return linkLine(capped(block.data?.title, 300) ?? url ?? '', url, caption, children);
			}
		},
		file: {
			...mediaKinds.file,
			html: (block, caption) => {
				const src = safeMediaSrc(block.data?.src);
				const name = String(block.data?.name || (src && fileNameOf(src)) || '');
				const link = src ? `<a href="${escapeHtml(src)}">${escapeHtml(name)}</a>` : '';
				return `<figure data-edytor-file>${link}<figcaption>${caption}</figcaption></figure>`;
			},
			plain: (block, caption) =>
				[safeMediaSrc(block.data?.src), caption].filter(Boolean).join('\n'),
			// Its own export: a `figure[data-edytor-file]` holding the link.
			parse: (el) => {
				if (el.localName !== 'figure' || !el.hasAttribute('data-edytor-file')) return;
				const anchor = el.querySelector('a[href]');
				const src = safeMediaSrc(anchor?.getAttribute('href'));
				const name = anchor?.textContent?.trim().slice(0, 300);
				return src ? { src, name: name || fileNameOf(src) } : undefined;
			},
			markdown: (block, caption, children) => {
				const src = safeMediaSrc(block.data?.src);
				const name = String(block.data?.name || (src && fileNameOf(src)) || '');
				return linkLine(name, src, caption, children);
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
			},
			markdown: (block) => {
				const title = label(pageTitleOf(block.data?.title) ?? untitled);
				const pageId = pageIdOf(block.data?.pageId);
				const href = pageId && options.href ? sanitizeLinkHref(options.href(pageId)) : null;
				return href ? `[${title}](${destination(href)})` : title;
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
				el.localName === 'nav' && el.hasAttribute('data-edytor-toc') ? {} : undefined,
			markdown: () => ''
		}
	}) satisfies Record<string, BlockForms>;

/** MathML for a TeX source: KaTeX's in a view once loaded, else the source in its annotation. */
export type MathML = (tex: string, display: boolean) => string;

/** The equation plugin's forms: `$$…$$` and `$…$` in markdown. */
export const equationForms = (mathml: MathML = sourceMathml) => ({
	blocks: {
		equation: {
			...equationKinds.equation,
			html: (block) => `<div data-edytor-equation>${mathml(expressionOf(block.data), true)}</div>`,
			plain: (block) => expressionOf(block.data),
			parse: (element: HTMLElement) => parseEquation(element, true),
			markdown: (block) => `$$\n${expressionOf(block.data)}\n$$`
		}
	} satisfies Record<string, BlockForms>,
	inlineBlocks: {
		inlineEquation: {
			plain: (data) => expressionOf(data),
			html: (data) => mathml(expressionOf(data), false),
			parse: (element: HTMLElement) => parseEquation(element, false),
			markdown: (data) => `$${expressionOf(data)}$`
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

/** The columns plugin's forms: in markdown, the columns' blocks one after another. */
export const columnsForms = () =>
	({
		columns: {
			...layoutKinds.columns,
			html: (_, __, children) => `<div data-edytor-columns>${children}</div>`,
			plain: (_, __, children) => children,
			parse: (element: HTMLElement) =>
				element.hasAttribute('data-edytor-columns') ? {} : undefined,
			markdown: (_, __, children) => children
		},
		column: {
			...layoutKinds.column,
			html: (block, _, children) =>
				`<div data-edytor-column data-width="${weightOf(block.data)}">${children}</div>`,
			plain: (_, __, children) => children,
			parse: (element: HTMLElement) =>
				element.hasAttribute('data-edytor-column') ? parsedWidth(element) : undefined,
			markdown: (_, __, children) => children
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
