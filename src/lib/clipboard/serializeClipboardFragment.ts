import type { JSONBlock, JSONText } from '$lib/utils/json.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { EdytorClipboardFragment, JSONContentPart } from './types.js';
import { EDYTOR_FRAGMENT_ATTRIBUTE } from './types.js';
import { isTextPart } from '$lib/block/contentRange.js';

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

/** A mark exports the element it renders (P2.7): its `tag` and `attributes`. */
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
				: `<span data-edytor-inline-block="${escapeHtml(part.type)}"></span>`
		)
		.join('');

const blockHtml = (block: JSONBlock, kinds: ExportKinds): string => {
	const content = contentHtml(block.content, kinds);
	const children = block.children?.map((child) => blockHtml(child, kinds)).join('') ?? '';
	const form = kinds.blocks.get(block.type)?.html;
	if (!form) return `<p>${content}</p>${children}`;
	return typeof form === 'string' ? tag(form, content + children) : form(block, content, children);
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
