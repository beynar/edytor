import type { PageLoad } from './$types';
import type { JSONDoc } from '$lib/utils/json.js';

const readDstDocument = (raw: string | null): JSONDoc | undefined => {
	if (raw === null) {
		return undefined;
	}

	const value: unknown = JSON.parse(raw);
	if (
		typeof value !== 'object' ||
		value === null ||
		!('children' in value) ||
		!Array.isArray(value.children)
	) {
		throw new TypeError('DST document must contain a children array');
	}

	return value as JSONDoc;
};

export const load: PageLoad = ({ url }) => {
	return {
		scenario: url.searchParams.get('scenario') ?? 'basic',
		dstDocument: readDstDocument(url.searchParams.get('dst')),
		empty: url.searchParams.get('empty'),
		collab: url.searchParams.get('collab'),
		collabws: url.searchParams.get('collabws'),
		wsserver: url.searchParams.get('wsserver'),
		// The library default (no periodic resync) unless a spec opts in: the
		// resync timer only heals deliberate harness loss (dropped frames).
		wsresync: Number(url.searchParams.get('wsresync')) || undefined,
		wsbackoff: Number(url.searchParams.get('wsbackoff')) || 500,
		// `wssync=factory` mounts the library's `createWebsocketSync` (its
		// default local store included; `wspersist=off` opts out) instead of
		// the hand-built provider stack the collab specs and DST drive.
		wssync: url.searchParams.get('wssync'),
		wspersist: url.searchParams.get('wspersist'),
		// Collaboration DST knobs: `actor` pins the document's local actor
		// identity (deterministic per peer) and `lineagedepth` opts the
		// document into the attribution history ring — both consumed only
		// when the page injects its own `document` (see +page.svelte).
		actor: url.searchParams.get('actor'),
		lineagedepth: (() => {
			const raw = url.searchParams.get('lineagedepth');
			if (raw === null) return undefined;
			const depth = Number(raw);
			if (!Number.isInteger(depth) || depth < 0) {
				throw new TypeError(`lineagedepth must be a non-negative integer, got "${raw}"`);
			}
			return depth;
		})(),
		// arch-v2 R1: `?cells=shadow` keeps render cells next to the mirror and
		// exposes their comparison on `window.__EDYTOR_CELLS__`.
		cells: url.searchParams.get('cells') === 'shadow',
		readonly: url.searchParams.get('readonly') === 'true',
		dynamicReadonly: url.searchParams.get('dynamicReadonly') === 'true',
		placeholder: url.searchParams.get('placeholder') ?? undefined,
		enterHotkey: url.searchParams.get('enterHotkey') === 'true',
		backspaceHotkey: url.searchParams.get('backspaceHotkey') === 'true',
		altGraphHotkey: url.searchParams.get('altGraphHotkey') === 'true',
		deadKeyHotkey: url.searchParams.get('deadKeyHotkey') === 'true',
		handles: url.searchParams.get('handles') === 'true',
		// The opt-in find plugin (`find=true`): Mod+F is the browser's without it.
		find: url.searchParams.get('find') === 'true',
		secondary: url.searchParams.get('secondary') === 'true',
		dir: url.searchParams.get('dir') === 'rtl' ? 'rtl' : 'ltr',
		translate:
			url.searchParams.get('translate') === 'yes'
				? 'yes'
				: url.searchParams.get('translate') === 'no'
					? 'no'
					: undefined,
		spellcheck:
			url.searchParams.get('spellcheck') === 'false'
				? false
				: url.searchParams.get('spellcheck') === 'true'
					? true
					: undefined,
		autocorrect:
			url.searchParams.get('autocorrect') === 'on'
				? 'on'
				: url.searchParams.get('autocorrect') === 'off'
					? 'off'
					: undefined,
		autocomplete:
			url.searchParams.get('autocomplete') === 'on'
				? 'on'
				: url.searchParams.get('autocomplete') === 'off'
					? 'off'
					: undefined,
		autocapitalize: url.searchParams.get('autocapitalize') ?? undefined
	};
};
