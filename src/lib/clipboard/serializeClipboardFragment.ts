/**
 * The document's export forms, one reading for the clipboard and for
 * `toHTML` / `toMarkdown` (`edytor/export`): each kind, mark and atom
 * declares its own forms (`html`, `plain`, `markdown`; a mark's `tag` and
 * `attributes`), and this module only walks the blocks. Pure: no view, no
 * DOM, no Svelte.
 */
import type { JSONBlock, JSONText, SerializableContent } from '$lib/utils/json.js';
import type { BlockDefinition, InlineBlockDefinition, MarkDefinition } from '$lib/plugins.js';
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
export const contentOf = (content: JSONContentPart[] = [], kinds: ExportKinds, html: boolean) =>
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

/**
 * How sibling blocks' HTML joins (`edytor/export` wraps a run of list items
 * in its list): the blocks, their HTML, and their parent's `html` form.
 * Without one, one after another (the clipboard's).
 */
export type SiblingsHtml = (
	blocks: JSONBlock[],
	html: string[],
	parent?: BlockForms['html']
) => string;

/** A block and its subtree as HTML (its colours as Notion's classes), or as plain text. */
const blockOf = (
	block: JSONBlock,
	kinds: ExportKinds,
	html: boolean,
	wrap?: SiblingsHtml
): string => {
	const content = contentOf(block.content, kinds, html);
	const kids = block.children?.map((child) => blockOf(child, kinds, html, wrap)) ?? [];
	const kind = kinds.blocks.get(block.type);
	if (!html) {
		const children = kids.filter(Boolean).join('\n');
		return kind?.plain
			? kind.plain(block, content, children)
			: [content, children].filter(Boolean).join('\n');
	}
	const form = kind?.html;
	const children = wrap ? wrap(block.children ?? [], kids, form) : kids.join('');
	const out = !form
		? `<p>${content}</p>${children}`
		: typeof form === 'string'
			? tag(form, content + children)
			: form(block, content, children);
	// A block's colours as Notion's export names them (`block-color-red`).
	return withClasses(out, colorClasses(block.data));
};

/** Blocks as HTML: the clipboard's and `toHTML`'s one reading of the kinds' forms. */
export const blocksToHtml = (blocks: JSONBlock[], kinds: ExportKinds, wrap: SiblingsHtml) =>
	wrap(
		blocks,
		blocks.map((block) => blockOf(block, kinds, true, wrap))
	);

export const serializeClipboardFragmentToPlainText = (
	fragment: EdytorClipboardFragment,
	kinds: ExportKinds
) =>
	fragment.kind === 'blocks'
		? fragment.blocks.map((block) => blockOf(block, kinds, false)).join('\n')
		: contentOf(fragment.content, kinds, false);

export const serializeClipboardFragmentToHtml = (
	fragment: EdytorClipboardFragment,
	kinds: ExportKinds
) => {
	const encoded = encodeClipboardJson(fragment);
	const html =
		fragment.kind === 'blocks'
			? fragment.blocks.map((block) => blockOf(block, kinds, true)).join('')
			: `<p>${contentOf(fragment.content, kinds, true)}</p>`;
	return `<meta charset="utf-8"><span ${EDYTOR_FRAGMENT_ATTRIBUTE}="${encoded}" hidden></span>${html}`;
};
