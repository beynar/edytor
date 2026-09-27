import {
	EDYTOR_FRAGMENT_ATTRIBUTE,
	EDYTOR_FRAGMENT_MIME,
	type ClipboardWritable,
	type EdytorClipboardFragment
} from './types.js';
import {
	encodeClipboardJson,
	serializeClipboardFragmentToHtml,
	serializeClipboardFragmentToPlainText,
	type ExportKinds
} from './serializeClipboardFragment.js';

const decodeJson = <T>(value: string): T => JSON.parse(decodeURIComponent(atob(value))) as T;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isSerializableValue = (value: unknown): boolean => {
	if (value === null) {
		return true;
	}

	if (['string', 'number', 'boolean'].includes(typeof value)) {
		return true;
	}

	if (Array.isArray(value)) {
		return value.every(isSerializableValue);
	}

	if (isRecord(value)) {
		return Object.values(value).every(isSerializableValue);
	}

	return false;
};

const isValidTextPart = (value: unknown) => {
	if (!isRecord(value) || typeof value.text !== 'string') {
		return false;
	}

	return value.marks === undefined || isRecord(value.marks);
};

const isValidInlineBlockPart = (value: unknown) => {
	if (!isRecord(value) || typeof value.type !== 'string' || value.type.length === 0) {
		return false;
	}

	return value.data === undefined || isSerializableValue(value.data);
};

const isValidContentPart = (value: unknown) =>
	isValidTextPart(value) || isValidInlineBlockPart(value);

const isValidBlock = (value: unknown): boolean => {
	if (!isRecord(value) || typeof value.type !== 'string' || value.type.length === 0) {
		return false;
	}

	if (value.data !== undefined && !isSerializableValue(value.data)) {
		return false;
	}

	if (value.content !== undefined) {
		if (!Array.isArray(value.content) || !value.content.every(isValidContentPart)) {
			return false;
		}
	}

	if (value.children !== undefined) {
		if (!Array.isArray(value.children) || !value.children.every(isValidBlock)) {
			return false;
		}
	}

	return true;
};

export const isValidEdytorClipboardFragment = (
	value: unknown
): value is EdytorClipboardFragment => {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const fragment = value as Partial<EdytorClipboardFragment>;
	if (fragment.version !== 1 || fragment.source !== 'edytor') {
		return false;
	}

	if (fragment.kind === 'blocks') {
		return Array.isArray(fragment.blocks) && fragment.blocks.every(isValidBlock);
	}

	if (fragment.kind === 'content') {
		return (
			typeof fragment.blockType === 'string' &&
			fragment.blockType.length > 0 &&
			Array.isArray(fragment.content) &&
			fragment.content.every(isValidContentPart)
		);
	}

	return false;
};

const parseEncodedFragment = (encoded: string) => {
	try {
		const decoded = decodeJson<unknown>(encoded);
		return isValidEdytorClipboardFragment(decoded) ? decoded : null;
	} catch {
		return null;
	}
};

const extractEmbeddedFragmentWithDom = (html: string) => {
	if (typeof DOMParser === 'undefined') {
		return null;
	}

	const document = new DOMParser().parseFromString(html, 'text/html');
	const node = document.querySelector(`[${EDYTOR_FRAGMENT_ATTRIBUTE}]`);
	const encoded = node?.getAttribute(EDYTOR_FRAGMENT_ATTRIBUTE);
	return encoded ? parseEncodedFragment(encoded) : null;
};

const extractEmbeddedFragment = (html: string) => {
	const fragment = extractEmbeddedFragmentWithDom(html);
	if (fragment) {
		return fragment;
	}

	const match = html.match(new RegExp(`${EDYTOR_FRAGMENT_ATTRIBUTE}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
	return match?.[2] ? parseEncodedFragment(match[2]) : null;
};

export const readEdytorClipboardFragment = (
	data: Pick<DataTransfer, 'getData'> | null | undefined
) => {
	if (!data) {
		return null;
	}

	const direct = data.getData(EDYTOR_FRAGMENT_MIME);
	if (direct) {
		const fragment = parseEncodedFragment(direct);
		if (fragment) {
			return fragment;
		}
	}

	const html = data.getData('text/html');
	return html ? extractEmbeddedFragment(html) : null;
};

export const writeEdytorClipboardData = (
	data: ClipboardWritable | null | undefined,
	fragment: EdytorClipboardFragment,
	kinds: ExportKinds
) => {
	if (!data) {
		return;
	}

	data.setData(EDYTOR_FRAGMENT_MIME, encodeClipboardJson(fragment));
	data.setData('text/html', serializeClipboardFragmentToHtml(fragment, kinds));
	data.setData('text/plain', serializeClipboardFragmentToPlainText(fragment, kinds));
};
