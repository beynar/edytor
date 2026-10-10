import type { JSONInlineBlock, JSONText } from '$lib/utils/json.js';

export type JSONContentPart = JSONText | JSONInlineBlock;

export const isTextPart = (part: JSONContentPart): part is JSONText => 'text' in part;

/**
 * The parts of `content` inside display offsets `[from, to)` (an inline atom
 * counts 1): the texts sliced, an empty slice dropped, the atoms whole.
 */
export const sliceContent = (
	content: readonly JSONContentPart[] = [],
	from = 0,
	to = Infinity
): JSONContentPart[] => {
	const out: JSONContentPart[] = [];
	let at = 0;
	for (const part of content) {
		const start = at;
		at += isTextPart(part) ? part.text.length : 1;
		if (at <= from || start >= to) continue;
		out.push(
			isTextPart(part)
				? { ...part, text: part.text.slice(Math.max(0, from - start), to - start) }
				: part
		);
	}
	return out;
};
