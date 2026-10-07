import type { Edytor } from '$lib/edytor.svelte.js';

/** One occurrence: `length` characters of block `block` from display offset `offset` (atoms count 1). */
export type FindMatch = { block: string; offset: number; length: number };

export type FindOptions = {
	/** Match case exactly (default: ignore it, as Notion and the browsers do). */
	caseSensitive?: boolean;
};

/**
 * Lower case, character by character, where that keeps the length (`İ`
 * lowers to two code units and stays as it is): offsets in the folded text
 * are offsets in the text.
 */
const fold = (value: string) => {
	let out = '';
	for (const char of value) {
		const lower = char.toLowerCase();
		out += lower.length === char.length ? lower : char;
	}
	return out;
};

/**
 * Every occurrence of `query` in the document's text, in reading order
 * (pre-order, a closed toggle's body included: what hides it is view state,
 * not the document). A match lies in one text segment: an inline atom
 * (a mention) ends it, and marks never do. Matches do not overlap.
 */
export const findMatches = (
	edytor: Edytor,
	query: string,
	{ caseSensitive = false }: FindOptions = {}
): FindMatch[] => {
	if (!query) return [];
	const { facade, idToBlock } = edytor;
	const needle = caseSensitive ? query : fold(query);
	const matches: FindMatch[] = [];
	const walk = (parent: string | null) => {
		for (const block of facade.childrenIds(parent)) {
			for (const part of idToBlock.parts(block)) {
				if (part.kind !== 'text' || part.length < needle.length) continue;
				const text = part.items.map((item) => item.text).join('');
				const hay = caseSensitive ? text : fold(text);
				for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length))
					matches.push({ block, offset: part.start + at, length: needle.length });
			}
			walk(block);
		}
	};
	walk(null);
	return matches;
};
