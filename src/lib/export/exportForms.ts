/**
 * The forms only `edytor/export` reads, by kind, mark and atom name: every
 * bundled kind's Markdown form, the HTML forms and import hooks a view's
 * clipboard does without (a toggle's `<details>`, a code block's one
 * `<pre>` naming its language, a task list's to-dos), and the list
 * wrapping of sibling items. A record's own form wins; these fill the
 * ones it lacks. They live here, not on the records, so a view ships none
 * of them.
 */
import type { JSONBlock } from '$lib/utils/json.js';
import type { BlockDefinition, MarkDefinition, InlineBlockDefinition } from '$lib/plugins.js';
import { sanitizeLinkHref } from '$lib/utils/sanitize.js';
import { DEFAULT_CALLOUT_ICON } from '$lib/plugins/richtext/callouts.js';
import { imageAltOf, safeImageSrc } from '$lib/plugins/image/image.js';
import { fileNameOf, safeMediaSrc, safeWebUrl } from '$lib/plugins/media/sources.js';
import { pageIdOf, pageTitleOf, type PagePluginOptions } from '$lib/plugins/page/page.js';
import { expressionOf } from '$lib/plugins/equation/tex.js';
import {
	escapeHtml,
	type BlockForms,
	type ExportKinds,
	type SiblingsHtml
} from '$lib/clipboard/serializeClipboardFragment.js';
import { capped, headingLevel } from './forms.js';

/** A child block's text joined (a code line's): marks and atoms aside. */
const textOf = (block: JSONBlock) =>
	(block.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
/** A code block's language as stored: a short name, else none. */
const languageOf = (data: Record<string, unknown> | undefined) =>
	typeof data?.language === 'string' && /^[\w#+.-]{1,40}$/.test(data.language)
		? data.language
		: undefined;
/** A code block's lines. */
const linesOf = (block: JSONBlock) => (block.children ?? []).map(textOf).join('\n');

/** The HTML forms and import hooks a view's records do without. */
export const blockExtras = {
	code: {
		html: (block) => {
			const language = languageOf(block.data);
			const named = language ? escapeHtml(language) : '';
			return `<pre${named && ` data-language="${named}"`}><code${named && ` class="language-${named}"`}>${escapeHtml(linesOf(block))}</code></pre>`;
		},
		plain: linesOf,
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
		}
	},
	toggle: {
		html: (_, content, children) => `<details><summary>${content}</summary>${children}</details>`
	},
	// HTML import: its own export, and a GitHub task list's item.
	'todo-item': {
		parse: (el: HTMLElement) => {
			if (el.localName !== 'li') return;
			const box = [...el.children].find(
				(child) => child.localName === 'input' && child.getAttribute('type') === 'checkbox'
			);
			return box ? { checked: box.hasAttribute('checked') } : undefined;
		}
	}
} satisfies Record<string, BlockForms>;

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

type BlockMarkdown = NonNullable<BlockDefinition['markdown']>;

/** A markdown link destination: `<…>` when it holds a space or a parenthesis. */
const destination = (href: string) =>
	/[\s()<>]/.test(href) ? `<${href.replace(/>/g, '%3E')}>` : href;
/** Text for a markdown link's label: its brackets and backslashes escaped. */
const label = (text: string) => text.replace(/[\\[\]]/g, (c) => `\\${c}`);
/** A block's children markdown after its own line(s), a blank line apart. */
const then = (own: string, children: string) => (children ? `${own}\n\n${children}` : own);
/** A quote's lines, each behind `> `. */
const quoted = (text: string) =>
	text
		.split('\n')
		.map((line) => (line ? `> ${line}` : '>'))
		.join('\n');
/** A list item's markdown: its marker and text, its children indented under it. */
const item =
	(marker: (block: JSONBlock, index: number) => string): BlockMarkdown =>
	(block, content, children, { index, indent }) => {
		const own = marker(block, index);
		return children
			? `${own}${content}\n${indent(children, ' '.repeat(own.length))}`
			: own + content;
	};
/** A `<details>` disclosure: GitHub and most readers show it folded; `textToBlocks` reads it back. */
const details = (summary: string, children: string) =>
	`<details>\n<summary>${summary}</summary>\n\n${children ? `${children}\n\n` : ''}</details>`;
/** A fence longer than any backtick run of `text`'s line starts (three at least). */
const fenceFor = (text: string) =>
	'`'.repeat(Math.max(3, ...[...text.matchAll(/^\s*(`{3,})/gm)].map((m) => m[1]!.length + 1)));
/** A markdown link line (a bookmark's, a file's), its caption after it. */
const linkLine = (text: string, href: string | null, caption: string, children: string) =>
	then(
		[href ? `[${label(text || href)}](${destination(href)})` : '', caption]
			.filter(Boolean)
			.join('\n\n'),
		children
	);
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
const children: BlockMarkdown = (_, __, children) => children;
const source: BlockMarkdown = (block, caption, children) => {
	const src = safeMediaSrc(block.data?.src);
	return linkLine(src ?? '', src, caption, children);
};

/** Each bundled kind's Markdown form; `page` links a page through `options.href`. */
export const blockMarkdown = (options: PagePluginOptions = {}, untitled = 'Untitled') =>
	({
		heading: (block, content, children) =>
			then(`${'#'.repeat(Number(headingLevel(block.data?.level).slice(1)))} ${content}`, children),
		'bulleted-list-item': item(() => '- '),
		'numbered-list-item': item((_, index) => `${index}. `),
		'todo-item': item((block) => `- [${block.data?.checked === true ? 'x' : ' '}] `),
		'list-item': item(() => '- '),
		toggle: (_, content, children) => details(content, children),
		'toggle-heading': (block, content, children) => {
			const tag = headingLevel(block.data?.level);
			return details(`<${tag}>${content}</${tag}>`, children);
		},
		// A GitHub alert: `> [!NOTE]`, then the icon and the title, then the content.
		callout: (block, content, children) => {
			const icon = typeof block.data?.icon === 'string' ? block.data.icon : DEFAULT_CALLOUT_ICON;
			const title = [icon, content].filter(Boolean).join(' ');
			return quoted(['[!NOTE]', title, ...(children ? ['', children] : [])].join('\n'));
		},
		quote: (_, content, children) => quoted(then(content, children)),
		divider: () => '---',
		// Its items are `list-item`s: numbered here.
		'ordered-list': (_, __, children) => {
			let n = 0;
			return children.replace(/^- /gm, () => `${++n}. `);
		},
		'unordered-list': children,
		code: (block) => {
			const lines = (block.children ?? []).map(textOf).join('\n');
			const fence = fenceFor(lines);
			return `${fence}${languageOf(block.data) ?? ''}\n${lines}${lines ? '\n' : ''}${fence}`;
		},
		codeLine: (block) => textOf(block),
		table: (block, _, __, { inline }) => {
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
		},
		tableCell: (_, content) => content,
		image: (block, caption, children) => {
			const src = safeImageSrc(block.data?.src);
			if (!src) return then(caption, children);
			const title = caption ? ` "${caption.replace(/"/g, '\\"')}"` : '';
			return then(`![${label(imageAltOf(block.data))}](${destination(src)}${title})`, children);
		},
		embed: (block, caption, children) => {
			const url = safeWebUrl(block.data?.url);
			return linkLine(url ?? '', url, caption, children);
		},
		bookmark: (block, caption, children) => {
			const url = safeWebUrl(block.data?.url);
			return linkLine(capped(block.data?.title, 300) ?? url ?? '', url, caption, children);
		},
		file: (block, caption, children) => {
			const src = safeMediaSrc(block.data?.src);
			const name = String(block.data?.name || (src && fileNameOf(src)) || '');
			return linkLine(name, src, caption, children);
		},
		video: source,
		audio: source,
		page: (block) => {
			const title = label(pageTitleOf(block.data?.title) ?? untitled);
			const pageId = pageIdOf(block.data?.pageId);
			const href = pageId && options.href ? sanitizeLinkHref(options.href(pageId)) : null;
			return href ? `[${title}](${destination(href)})` : title;
		},
		toc: () => '',
		equation: (block) => `$$\n${expressionOf(block.data)}\n$$`,
		columns: children,
		column: children
	}) satisfies Record<string, BlockMarkdown>;

/** Each rich text mark's delimiters; an unsafe link exports its text alone, as it renders inert. */
export const markMarkdown = {
	bold: ['**', '**'],
	italic: ['*', '*'],
	strike: ['~~', '~~'],
	code: ['`', '`'],
	link: (value: { href?: unknown }) => {
		const href = sanitizeLinkHref(value?.href);
		return href ? (['[', `](${destination(href)})`] as const) : undefined;
	}
} satisfies Record<string, NonNullable<MarkDefinition['markdown']>>;

/** Each bundled atom's Markdown form (else its `plain` form). */
export const atomMarkdown = {
	inlineEquation: (data: unknown) => `$${expressionOf(data)}$`
} satisfies Record<string, NonNullable<InlineBlockDefinition['markdown']>>;
