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

const escapeHtml = (value: string) =>
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

const contentHtml = (content: JSONContentPart[] = [], kinds: ExportKinds) =>
	content
		.map((part) =>
			isTextPart(part)
				? textHtml(part, kinds)
				: (kinds.inlineBlocks.get(part.type)?.html?.(part.data) ??
					`<span data-edytor-inline-block="${escapeHtml(part.type)}"></span>`)
		)
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

const blockHtml = (block: JSONBlock, kinds: ExportKinds): string => {
	const content = contentHtml(block.content, kinds);
	const children = block.children?.map((child) => blockHtml(child, kinds)).join('') ?? '';
	const form = kinds.blocks.get(block.type)?.html;
	const html = !form
		? `<p>${content}</p>${children}`
		: typeof form === 'string'
			? tag(form, content + children)
			: form(block, content, children);
	// A block's colours as Notion's export names them (`block-color-red`).
	return withClasses(html, colorClasses(block.data));
};

const contentPlain = (content: JSONContentPart[] = [], kinds: ExportKinds) =>
	content
		.map((part) =>
			isTextPart(part) ? part.text : (kinds.inlineBlocks.get(part.type)?.plain?.(part.data) ?? '')
		)
		.join('');

const blockPlain = (block: JSONBlock, kinds: ExportKinds): string => {
	const content = contentPlain(block.content, kinds);
	const children =
		block.children
			?.map((child) => blockPlain(child, kinds))
			.filter(Boolean)
			.join('\n') ?? '';
	const form = kinds.blocks.get(block.type)?.plain;
	return form ? form(block, content, children) : [content, children].filter(Boolean).join('\n');
};

export const serializeClipboardFragmentToPlainText = (
	fragment: EdytorClipboardFragment,
	kinds: ExportKinds
) =>
	fragment.kind === 'blocks'
		? fragment.blocks.map((block) => blockPlain(block, kinds)).join('\n')
		: contentPlain(fragment.content, kinds);

export const serializeClipboardFragmentToHtml = (
	fragment: EdytorClipboardFragment,
	kinds: ExportKinds
) => {
	const encoded = encodeClipboardJson(fragment);
	const html =
		fragment.kind === 'blocks'
			? fragment.blocks.map((block) => blockHtml(block, kinds)).join('')
			: `<p>${contentHtml(fragment.content, kinds)}</p>`;
	return `<meta charset="utf-8"><span ${EDYTOR_FRAGMENT_ATTRIBUTE}="${encoded}" hidden></span>${html}`;
};
