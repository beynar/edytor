import { mount, unmount } from 'svelte';
import type { Plugin } from '$lib/plugins.js';
import type { VersionChange } from './diff.js';
import VersionHighlights from './VersionHighlights.svelte';

/**
 * The history panel's preview chrome: each block `changes()` names gets a
 * tint over its own row in the overlay, by its change (`added`, `removed`,
 * `changed`). `changes` is read reactively, so one plugin serves every
 * preview the panel mounts.
 */
export const versionHighlightsPlugin =
	(changes: () => ReadonlyMap<string, VersionChange>): Plugin =>
	(edytor) => ({
		onEdytorAttached: () => {
			const highlights = mount(VersionHighlights, {
				target: edytor.overlay.layer!,
				props: { edytor, changes }
			});
			return () => void unmount(highlights);
		}
	});
