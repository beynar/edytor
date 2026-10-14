/**
 * The view's uploads as the other layers see them: the one per view the
 * first media plugin given an `upload` claims (`uploadHooks`), and whether it takes a
 * file (a kind's `upload` accepts it). A file dragged over the view shows
 * where it lands only when its uploads take it (`drop`, the plugin layer's
 * `plugins/fileDrop.ts`, Pragmatic's external adapter); a view without uploads ignores dropped files.
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import type { DropAt } from './attempt.js';

/** Files dragged from outside over the view: where they land. */
export interface FileDropPort {
	/**
	 * The placement the drop of files being handled landed at, once (the
	 * plugin layer's drop target resolves it before the host's `drop`
	 * listener runs); `null` where none shows.
	 */
	take(): DropAt | null;
}

/** What the view's uploads answer about a file. */
export interface ViewUploads {
	/** The kind that takes `file` (its record's `upload`), so a paste or a drop places it. */
	kindOf(file: File): string | undefined;
	/** Where dropped files land (the plugin layer's indicator). */
	readonly drop: FileDropPort;
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
