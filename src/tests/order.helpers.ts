import type { Edytor } from '$lib/edytor.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';

/** `start`, `end` and every block between them in document order (no `end`: to the last). */
export const blocksBetween = (edytor: Edytor, start: Block, end: Block | null): Block[] => {
	const ids = edytor.facade.order();
	const from = ids.indexOf(start.id);
	if (from < 0) return [start];
	const to = end ? ids.indexOf(end.id, from) : -1;
	return ids
		.slice(from, to < 0 ? undefined : to + 1)
		.flatMap((id) => edytor.idToBlock.get(id) ?? []);
};
