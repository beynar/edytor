import type { JSONBlock, JSONText } from '$lib/utils/json.js';
import type { EdytorClipboardFragment, JSONContentPart } from './types.js';
import { EDYTOR_FRAGMENT_ATTRIBUTE } from './types.js';
import { isTextPart } from '$lib/block/contentRange.js';

export const encodeClipboardJson = (value: unknown) =>
	btoa(encodeURIComponent(JSON.stringify(value)));

const escapeHtml = (value: string) =>
	value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const serializeTextPart = (part: JSONText) => {
	let html = escapeHtml(part.text).replace(/\n/g, '<br>');
	const marks = part.marks ?? {};

	if (marks.code) {
		html = `<code>${html}</code>`;
	}
	if (marks.bold) {
		html = `<strong>${html}</strong>`;
	}
	if (marks.italic) {
		html = `<em>${html}</em>`;
	}
	if (marks.underline) {
		html = `<u>${html}</u>`;
	}
	if (marks.strike) {
		html = `<s>${html}</s>`;
	}

	return html;
};

const getMentionLabel = (data: unknown) => {
	if (!isRecord(data)) {
		return '@mention';
	}

	const label = data.label ?? data.name ?? data.title ?? data.id;
	if (typeof label !== 'string' && typeof label !== 'number') {
		return '@mention';
	}

	const value = String(label);
	return value.startsWith('@') ? value : `@${value}`;
};

const serializeInlineBlockToPlainText = (part: Exclude<JSONContentPart, JSONText>) => {
	if (part.type === 'mention') {
		return getMentionLabel(part.data);
	}

	return '';
};

const serializeContentToHtml = (content: JSONContentPart[] = []) =>
	content
		.map((part) =>
			isTextPart(part)
				? serializeTextPart(part)
				: `<span data-edytor-inline-block="${escapeHtml(part.type)}"></span>`
		)
		.join('');

const getHeadingTag = (block: JSONBlock) => {
	const level = isRecord(block.data) ? block.data.level : null;
	return ['h1', 'h2', 'h3'].includes(String(level)) ? String(level) : 'h1';
};

const serializeBlockToHtml = (block: JSONBlock): string => {
	const content = serializeContentToHtml(block.content);
	const children = block.children?.map(serializeBlockToHtml).join('') ?? '';

	switch (block.type) {
		case 'heading': {
			const tag = getHeadingTag(block);
			return `<${tag}>${content}</${tag}>${children}`;
		}
		case 'quote':
			return `<blockquote>${content}${children}</blockquote>`;
		case 'ordered-list':
			return `<ol>${children}</ol>`;
		case 'unordered-list':
			return `<ul>${children}</ul>`;
		case 'list-item':
		case 'bulleted-list-item':
		case 'numbered-list-item':
			return `<li>${content}${children}</li>`;
		case 'todo-item': {
			const checked = isRecord(block.data) && block.data.checked === true ? ' checked' : '';
			return `<li data-edytor-todo-item="true"><input type="checkbox"${checked}>${content}${children}</li>`;
		}
		case 'codeLine':
			return `<pre><code>${content}</code></pre>`;
		case 'divider':
		case 'horizontalRule':
			return '<hr>';
		case 'image':
			return `<figure><figcaption>${content}</figcaption></figure>`;
		default:
			return `<p>${content}</p>${children}`;
	}
};

const serializeContentToPlainText = (content: JSONContentPart[] = []) =>
	content
		.map((part) => (isTextPart(part) ? part.text : serializeInlineBlockToPlainText(part)))
		.join('');

const serializeBlockToPlainText = (block: JSONBlock): string => {
	const content = serializeContentToPlainText(block.content);
	const children = block.children?.map(serializeBlockToPlainText).filter(Boolean).join('\n') ?? '';

	if (block.type === 'divider' || block.type === 'horizontalRule') {
		return '---';
	}

	if (block.type === 'todo-item') {
		const checkbox = isRecord(block.data) && block.data.checked === true ? '[x]' : '[ ]';
		return [`${checkbox} ${content}`.trim(), children].filter(Boolean).join('\n');
	}

	return [content, children].filter(Boolean).join('\n');
};

const fragmentHtml = (fragment: EdytorClipboardFragment) =>
	fragment.kind === 'blocks'
		? fragment.blocks.map(serializeBlockToHtml).join('')
		: `<p>${serializeContentToHtml(fragment.content)}</p>`;

export const serializeClipboardFragmentToPlainText = (fragment: EdytorClipboardFragment) =>
	fragment.kind === 'blocks'
		? fragment.blocks.map(serializeBlockToPlainText).join('\n')
		: serializeContentToPlainText(fragment.content);

export const serializeClipboardFragmentToHtml = (fragment: EdytorClipboardFragment) => {
	const encoded = encodeClipboardJson(fragment);
	return `<meta charset="utf-8"><span ${EDYTOR_FRAGMENT_ATTRIBUTE}="${encoded}" hidden></span>${fragmentHtml(fragment)}`;
};
