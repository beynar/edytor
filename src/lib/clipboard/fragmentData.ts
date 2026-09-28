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

/** A plain object (arrays are not records here: fragment validation rejects them). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const decodeJson = <T>(value: string): T => JSON.parse(decodeURIComponent(atob(value))) as T;

const isValidTextPart = (value: unknown) => {
	if (!isRecord(value) || typeof value.text !== 'string') {
		return false;
	}

	return value.marks === undefined || isRecord(value.marks);
};

// Input is JSON (a parsed payload, or `cloneJsonSafe` on the programmatic path): no value walk.
const isValidInlineBlockPart = (value: unknown) =>
	isRecord(value) && typeof value.type === 'string' && value.type.length > 0;

const isValidContentPart = (value: unknown) =>
	isValidTextPart(value) || isValidInlineBlockPart(value);

const isValidBlock = (value: unknown): boolean => {
	if (!isRecord(value) || typeof value.type !== 'string' || value.type.length === 0) {
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

/** The HTML-embedded fragment (carries internal paste through clipboards that strip custom MIME types). */
const EMBEDDED = new RegExp(`${EDYTOR_FRAGMENT_ATTRIBUTE}\\s*=\\s*(['"])([A-Za-z0-9+/=]*)\\1`, 'i');

/** The private MIME first, then the fragment embedded in the HTML flavour. */
export const readEdytorClipboardFragment = (
	data: Pick<DataTransfer, 'getData'> | null | undefined
) => {
	const direct = data?.getData(EDYTOR_FRAGMENT_MIME);
	const embedded = data?.getData('text/html')?.match(EMBEDDED)?.[2];
	return (
		(direct && parseEncodedFragment(direct)) || (embedded && parseEncodedFragment(embedded)) || null
	);
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
