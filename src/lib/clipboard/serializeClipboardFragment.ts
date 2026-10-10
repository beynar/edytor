import type { JSONBlock, JSONText } from '$lib/utils/json.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { EdytorClipboardFragment, JSONContentPart } from './types.js';
import { EDYTOR_FRAGMENT_ATTRIBUTE } from './types.js';
import { isTextPart } from '$lib/block/contentRange.js';
import { colorClasses } from '$lib/block/colors.js';

/** The records the export reads: each kind, mark and atom declares its own forms. */
export type ExportKinds = Pick<Edytor, 'blocks' | 'marks' | 'inlineBlocks'>;

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

/** A block and its subtree as HTML (its colours as Notion's classes), or as plain text. */
const blockOf = (block: JSONBlock, kinds: ExportKinds, html: boolean): string => {
	const content = contentOf(block.content, kinds, html);
	const kids = block.children?.map((child) => blockOf(child, kinds, html)) ?? [];
	const kind = kinds.blocks.get(block.type);
	if (!html) {
		const children = kids.filter(Boolean).join('\n');
		return kind?.plain
			? kind.plain(block, content, children)
			: [content, children].filter(Boolean).join('\n');
	}
	const children = kids.join('');
	const form = kind?.html;
	const out = !form
		? `<p>${content}</p>${children}`
		: typeof form === 'string'
			? tag(form, content + children)
			: form(block, content, children);
	// A block's colours as Notion's export names them (`block-color-red`).
	return withClasses(out, colorClasses(block.data));
};

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
