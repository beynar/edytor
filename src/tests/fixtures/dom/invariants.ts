/**
 * Reusable document invariants for the dom lane.
 *
 * `expectNoHiddenContent(edytor)` — the no-hidden-content invariant: every
 * character the document stores is one the view can show. A block whose kind
 * renders no content (a list, a code block, a divider) holds no text or
 * inline atom, and a line of a `lines` island (a code line) holds no
 * children. A paste, drop or edit that parks text there leaves it stored and
 * synced but invisible (GX-01). Call it after any structural write.
 */
import { expect } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';

/** Where `edytor.value` stores content its view never shows, as `path: reason`. */
export const hiddenContent = (edytor: Edytor): string[] => {
	const found: string[] = [];
	const walk = (blocks: JSONBlock[] | undefined, path: number[], lines: boolean) =>
		blocks?.forEach((block, index) => {
			const at = [...path, index].join('.');
			const definition = edytor.blocks.get(block.type);
			const held = (block.content ?? []).filter((part) => !('text' in part) || part.text !== '');
			if (definition?.rendersContent === false && held.length)
				found.push(`${at}: ${block.type} holds content it does not render`);
			if (lines && block.children?.length)
				found.push(`${at}: a line of a lines island holds children`);
			walk(block.children, [...path, index], definition?.lines === true);
		});
	walk(edytor.value.children, [], false);
	return found;
};

/** Assert the no-hidden-content invariant (see the module comment). */
export const expectNoHiddenContent = (edytor: Edytor) => expect(hiddenContent(edytor)).toEqual([]);
