/**
 * The view's uploads as the other layers see them: the one per view the
 * first media plugin given an `upload` claims (`uploadHooks`), and whether it takes a
 * file (a kind's `upload` accepts it). A file dragged over the view shows
 * where it lands only when its uploads take it (`dnd/fileDrop.ts`).
 */
import type { Edytor } from '$lib/edytor.svelte.js';

/** What the view's uploads answer about a file. */
export interface ViewUploads {
	/** The kind that takes `file` (its record's `upload`), so a paste or a drop places it. */
	kindOf(file: File): string | undefined;
}

const views = new WeakMap<Edytor, ViewUploads>();

/** The view's uploads, when a plugin claimed them. */
export const viewUploads = (edytor: Edytor | undefined): ViewUploads | undefined =>
	edytor && views.get(edytor);

/** Claim the view's uploads for `uploads`: the first claim wins (`false` after it). */
export const claimUploads = (edytor: Edytor, uploads: ViewUploads) => {
	if (views.has(edytor)) return false;
	views.set(edytor, uploads);
	return true;
};
