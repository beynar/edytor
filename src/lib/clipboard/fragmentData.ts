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
import { isObject } from '$lib/crdt/data.js';

const decodeJson = <T>(value: string): T => JSON.parse(decodeURIComponent(atob(value))) as T;

/** A kind's name: a non-empty string. */
const isName = (value: unknown) => typeof value === 'string' && value.length > 0;

/** Every item of a list (absent: none) passes `valid`. */
const all = (value: unknown, valid: (item: unknown) => boolean, optional = false) =>
	(optional && value === undefined) || (Array.isArray(value) && value.every(valid));

// Input is JSON (a parsed payload, or `cloneJsonSafe` on the programmatic path): no value walk.
/** A text (its marks a record) or an inline atom (its kind named). */
const isPart = (value: unknown) =>
	isObject(value) &&
	((typeof value.text === 'string' && (value.marks === undefined || isObject(value.marks))) ||
		isName(value.type));

const isBlock = (value: unknown): boolean =>
	isObject(value) &&
	isName(value.type) &&
	all(value.content, isPart, true) &&
	all(value.children, isBlock, true);

export const isValidEdytorClipboardFragment = (
	value: unknown
): value is EdytorClipboardFragment => {
	if (!isObject(value) || value.version !== 1 || value.source !== 'edytor') return false;
	if (value.kind === 'blocks') return all(value.blocks, isBlock);
	return value.kind === 'content' && isName(value.blockType) && all(value.content, isPart);
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
