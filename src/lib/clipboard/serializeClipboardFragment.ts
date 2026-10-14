/**
 * The document's export forms, one reading for the clipboard and for
 * `toHTML` / `toMarkdown` (`edytor/export`): each kind, mark and atom
 * declares its own forms (`html`, `plain`, `markdown`; a mark's `tag` and
 * `attributes`), and this module only walks the blocks. Pure: no view, no
 * DOM, no Svelte.
 */
import type { JSONBlock, JSONText, SerializableContent } from '$lib/utils/json.js';
import type {
	BlockDefinition,
	InlineBlockDefinition,
	MarkDefinition,
	MarkdownContext
} from '$lib/plugins.js';
import type { EdytorClipboardFragment, JSONContentPart } from './types.js';
import { EDYTOR_FRAGMENT_ATTRIBUTE } from './types.js';
import { isTextPart } from '$lib/block/contentRange.js';
import { colorClasses } from '$lib/block/colors.js';

/** A kind's export and import forms: the fields of its record the export and HTML import read. */
export type BlockForms = Pick<
	BlockDefinition,
	| 'html'
	| 'plain'
	| 'markdown'
	| 'parse'
	| 'element'
	| 'contentElement'
	| 'void'
	| 'island'
	| 'lines'
	| 'rendersContent'
	| 'defaultChild'
	| 'itemKind'
> & {
	/** The data of each way to create the kind: HTML import finds a preset's tag. */
	presets?: { data?: Record<string, SerializableContent> }[];
};
/** A mark's export and import forms. */
export type MarkForms = Pick<MarkDefinition, 'tag' | 'attributes' | 'parse' | 'markdown'>;
/** An atom's export and import forms. */
export type AtomForms = Pick<InlineBlockDefinition, 'html' | 'plain' | 'markdown' | 'parse'>;

/** The records the export reads: each kind, mark and atom declares its own forms (a view is one). */
export type ExportKinds = {
	readonly blocks: ReadonlyMap<string, BlockForms>;
	readonly marks: ReadonlyMap<string, MarkForms>;
	readonly inlineBlocks: ReadonlyMap<string, AtomForms>;
};

export const encodeClipboardJson = (value: unknown) =>
	btoa(encodeURIComponent(JSON.stringify(value)));

/** `value` escaped for an HTML text or a double-quoted attribute: every kind's export reads it. */
export const escapeHtml = (value: string) =>
	value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A tag form wraps `inner`; attributes left `undefined` are omitted. */
const tag = (name: string, inner: string, attributes: Record<string, string | undefined> = {}) =>
	`<${name}${Object.entries(attributes)
		.map(([key, value]) => (value === undefined ? '' : ` ${key}="${escapeHtml(value)}"`))
		.join('')}>${inner}</${name}>`;

/** A mark exports the element it renders: its `tag` and `attributes`. */
const textHtml = (part: JSONText, kinds: ExportKinds) => {
	let html = escapeHtml(part.text).replace(/\n/g, '<br>');
	for (const [name, mark] of kinds.marks) {
		const value = part.marks?.[name];
		if (mark.tag && value) html = tag(mark.tag, html, mark.attributes?.(value));
	}
	return html;
};

/** The content as HTML, or as plain text: an atom by its kind's form (`html`, `plain`). */
const contentOf = (content: JSONContentPart[] = [], kinds: ExportKinds, html: boolean) =>
	content
		.map((part) => {
			if (isTextPart(part)) return html ? textHtml(part, kinds) : part.text;
			const atom = kinds.inlineBlocks.get(part.type);
			return html
				? (atom?.html?.(part.data) ??
						`<span data-edytor-inline-block="${escapeHtml(part.type)}"></span>`)
				: (atom?.plain?.(part.data) ?? '');
		})
		.join('');

/** `classes` added to the first element of `html` (the block's own), beside a class it has. */
const withClasses = (html: string, classes: string) =>
	classes
		? html.replace(/^<([a-z][\w-]*)([^>]*?)(\/?)>/i, (_, name: string, attributes: string, end) => {
				const own = /\sclass="([^"]*)"/.exec(attributes);
				const merged = own
					? attributes.replace(own[0], ` class="${own[1]} ${classes}"`)
					: `${attributes} class="${classes}"`;
				return `<${name}${merged}${end}>`;
			})
		: html;

/** The list tag a list container of `type`'s items exports (`ul`, `ol`), from its `itemKind`. */
const listTagOf = (type: string, kinds: ExportKinds) => {
	for (const [, kind] of kinds.blocks)
		if (kind.itemKind === type && (kind.html === 'ol' || kind.html === 'ul')) return kind.html;
	return 'ul';
};

/**
 * Sibling blocks as HTML: a run of list items no list element holds (a
 * document's items are siblings, `<li>` alone) is wrapped in its list's
 * tag, the one its container kind exports (`ol` for numbered items).
 */
const siblingsHtml = (blocks: JSONBlock[], kinds: ExportKinds, inList: boolean) => {
	let out = '';
	let open: string | null = null;
	for (const block of blocks) {
		const html = blockOf(block, kinds, true);
		const item = !inList && /^<li[\s>]/.test(html);
		const list = item ? listTagOf(block.type, kinds) : null;
		if (open && open !== list) out += `</${open}>`;
		if (list && open !== list) out += `<${list}>`;
		open = list;
		out += html;
	}
	return open ? `${out}</${open}>` : out;
};

/** A block and its subtree as HTML (its colours as Notion's classes), or as plain text. */
const blockOf = (block: JSONBlock, kinds: ExportKinds, html: boolean): string => {
	const content = contentOf(block.content, kinds, html);
	const kind = kinds.blocks.get(block.type);
	if (!html) {
		const kids = block.children?.map((child) => blockOf(child, kinds, false)) ?? [];
		const children = kids.filter(Boolean).join('\n');
		return kind?.plain
			? kind.plain(block, content, children)
			: [content, children].filter(Boolean).join('\n');
	}
	const form = kind?.html;
	const children = siblingsHtml(block.children ?? [], kinds, form === 'ul' || form === 'ol');
	const out = !form
		? `<p>${content}</p>${children}`
		: typeof form === 'string'
			? tag(form, content + children)
			: form(block, content, children);
	// A block's colours as Notion's export names them (`block-color-red`).
	return withClasses(out, colorClasses(block.data));
};

/** Blocks as HTML: the clipboard's and `toHTML`'s one reading of the kinds' forms. */
export const blocksToHtml = (blocks: JSONBlock[], kinds: ExportKinds) =>
	siblingsHtml(blocks, kinds, false);

/** Blocks as plain text, one block per line. */
export const blocksToPlainText = (blocks: JSONBlock[], kinds: ExportKinds) =>
	blocks.map((block) => blockOf(block, kinds, false)).join('\n');

/** Characters markdown reads as syntax inside a line: escaped in exported text. */
const MD_SPECIAL = /[\\`*_[\]~<]/g;
/** A line start markdown reads as a block (a heading, a list item, a quote, a rule): escaped. */
const MD_LINE_START = /^(\s*)(#{1,6}(?=\s|$)|[-+](?=\s)|\d+(?=[.)]\s)|>|=+\s*$|-{3,}\s*$)/;

/** Text as markdown: its syntax characters escaped, a soft break a hard break (`\` + newline). */
const escapeMarkdown = (text: string) =>
	text.replace(MD_SPECIAL, (c) => `\\${c}`).replace(/\n/g, '\\\n');

/** The delimiters a mark's value exports as, or none. */
const delimitersOf = (mark: MarkForms, value: unknown) =>
	typeof mark.markdown === 'function' ? mark.markdown(value) : mark.markdown;

/** A code span's fence: one backtick more than the longest run inside it. */
const codeFence = (text: string) =>
	'`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);

/**
 * Rich text as inline markdown. Marks open in their registration order
 * reversed (the first registered innermost, as HTML wraps them), a mark
 * spanning several runs opens once (`**a *b***`), a mark without a
 * `markdown` form is left out, and a delimiter never sits on a space
 * (`** x**` is no emphasis): the spaces move outside it.
 */
const inlineMarkdown = (content: JSONContentPart[] = [], kinds: ExportKinds) => {
	// A code span holds no markup: it opens last, innermost.
	const order = [...kinds.marks.keys()]
		.reverse()
		.sort((a, b) => Number(a === 'code') - Number(b === 'code'));
	/** The open marks, outermost first: name, value key and closing delimiter. */
	const open: { name: string; key: string; close: string }[] = [];
	let out = '';
	const closeTo = (depth: number) => {
		// A delimiter closes after the text's last non-space: trailing spaces move out.
		const spaces = /[ \t]*$/.exec(out)![0];
		out = out.slice(0, out.length - spaces.length);
		while (open.length > depth) out += open.pop()!.close;
		out += spaces;
	};
	for (const part of content) {
		if (!isTextPart(part)) {
			closeTo(0);
			const atom = kinds.inlineBlocks.get(part.type);
			out += atom?.markdown?.(part.data) ?? escapeMarkdown(atom?.plain?.(part.data) ?? '');
			continue;
		}
		const wanted = order
			.map((name) => {
				const mark = kinds.marks.get(name)!;
				const value = part.marks?.[name];
				const delimiters = value ? delimitersOf(mark, value) : undefined;
				return delimiters && { name, key: JSON.stringify(value), delimiters };
			})
			.filter((m) => !!m);
		// Keep the open marks this run still has, in order; close from the first it lacks.
		let keep = 0;
		while (
			keep < open.length &&
			wanted.some((m) => m.name === open[keep]!.name && m.key === open[keep]!.key)
		)
			keep++;
		// A mark opening inside an open code span would be literal: the span closes first.
		const opening = wanted.some((m) => !open.slice(0, keep).some((o) => o.name === m.name));
		const span = open.findIndex((m) => m.name === 'code');
		if (opening && span !== -1 && span < keep) keep = span;
		closeTo(keep);
		const code = wanted.some((m) => m.name === 'code');
		const raw = part.text;
		const lead = /^[ \t]*/.exec(raw)![0];
		const body = raw.slice(lead.length);
		out += lead;
		if (!body) continue;
		for (const mark of wanted)
			if (!open.some((m) => m.name === mark.name)) {
				const [start, end] = mark.delimiters;
				const fence = mark.name === 'code' ? codeFence(body) : '';
				const pad = fence && /^`|`$/.test(body) ? ' ' : '';
				out += fence ? fence + pad : start;
				open.push({ name: mark.name, key: mark.key, close: fence ? pad + fence : end });
			}
		out += code ? body : escapeMarkdown(body);
	}
	closeTo(0);
	return out;
};

/** Every line of `text` prefixed with `prefix` (an empty line with its trimmed form). */
const indent = (text: string, prefix: string) =>
	text
		.split('\n')
		.map((line) => (line ? prefix + line : prefix.trimEnd()))
		.join('\n');

/** A list item's markdown (`- `, `1. `, `- [ ] `): its block's first line starts one. */
const LIST_LINE = /^(?:[-*+]|\d+[.)])\s/;

/**
 * Sibling blocks as markdown: a blank line between blocks, a single
 * newline between items of one list (a tight list).
 */
const siblingsMarkdown = (blocks: JSONBlock[], kinds: ExportKinds) => {
	let out = '';
	let previous: string | null = null;
	let run = 0;
	let type: string | null = null;
	for (const block of blocks) {
		run = block.type === type ? run + 1 : 1;
		type = block.type;
		const md = blockMarkdown(block, kinds, run);
		if (!md) continue;
		if (previous !== null) out += LIST_LINE.test(previous) && LIST_LINE.test(md) ? '\n' : '\n\n';
		out += md;
		previous = md;
	}
	return out;
};

/** A block and its subtree as markdown, by its kind's form. */
const blockMarkdown = (block: JSONBlock, kinds: ExportKinds, index: number): string => {
	const kind = kinds.blocks.get(block.type);
	const content = inlineMarkdown(block.content, kinds);
	const children = siblingsMarkdown(block.children ?? [], kinds);
	if (kind?.markdown) {
		const context: MarkdownContext = {
			index,
			indent,
			inline: (parts) => inlineMarkdown(parts, kinds)
		};
		return kind.markdown(block, content, children, context);
	}
	if (kind?.plain) {
		const plain = kind.plain(block, contentOf(block.content, kinds, false), '');
		return [plain && escapeMarkdown(plain), children].filter(Boolean).join('\n\n');
	}
	// A paragraph: its text, a leading block marker escaped (`\# not a heading`).
	const text = content.replace(MD_LINE_START, (_, space: string, marker: string) =>
		/^\d/.test(marker) ? `${space}${marker}\\` : `${space}\\${marker}`
	);
	return [text, children].filter(Boolean).join('\n\n');
};

/** Blocks as markdown (`toMarkdown`), by each kind's, mark's and atom's `markdown` form. */
export const blocksToMarkdown = (blocks: JSONBlock[], kinds: ExportKinds) =>
	siblingsMarkdown(blocks, kinds);

/** Rich text as inline markdown (`toMarkdown`'s reading of a line). */
export const contentToMarkdown = (content: JSONContentPart[], kinds: ExportKinds) =>
	inlineMarkdown(content, kinds);

export const serializeClipboardFragmentToPlainText = (
	fragment: EdytorClipboardFragment,
	kinds: ExportKinds
) =>
	fragment.kind === 'blocks'
		? blocksToPlainText(fragment.blocks, kinds)
		: contentOf(fragment.content, kinds, false);

export const serializeClipboardFragmentToHtml = (
	fragment: EdytorClipboardFragment,
	kinds: ExportKinds
) => {
	const encoded = encodeClipboardJson(fragment);
	const html =
		fragment.kind === 'blocks'
			? blocksToHtml(fragment.blocks, kinds)
			: `<p>${contentOf(fragment.content, kinds, true)}</p>`;
	return `<meta charset="utf-8"><span ${EDYTOR_FRAGMENT_ATTRIBUTE}="${encoded}" hidden></span>${html}`;
};
