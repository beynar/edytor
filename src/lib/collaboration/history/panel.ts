/**
 * The version history panel's props and words (`HistoryPanel.svelte`).
 */
import type { Snippet } from 'svelte';
import type { EdytorDocument } from '$lib/crdt/document.js';
import type { Plugin } from '$lib/plugins.js';
import type {
	HistoryClient,
	HistoryRestoreResult,
	HistoryUndoResult,
	HistoryVersion
} from './client.js';

/** The panel's words, each replaceable (`labels`). */
export type HistoryPanelLabels = {
	/** The panel's name (its `aria-label`). */
	title: string;
	/** The list's name. */
	versions: string;
	/** The first half of a day (before local noon). */
	morning: string;
	/** The second half of a day (until midnight). */
	evening: string;
	loading: string;
	/** No version stored yet. */
	empty: string;
	/** A version's editors are unknown (a server edit). */
	noEditors: string;
	/** `{n}` more editors. */
	moreEditors: string;
	/** Shown before a version's write time. */
	saved: string;
	/** The preview's name (its `aria-label`). */
	preview: string;
	/** Pick a version to preview it. */
	choose: string;
	/** The highlight toggle. */
	highlight: string;
	/** `{n}` blocks added since the version. */
	added: string;
	/** `{n}` blocks removed since the version. */
	removed: string;
	/** `{n}` blocks changed since the version. */
	changed: string;
	/** The version equals the current document. */
	same: string;
	restore: string;
	restoring: string;
	undo: string;
	restored: string;
	/** A restore that changed nothing (`noop`). */
	unchanged: string;
	/** The version is gone (`refused`). */
	unavailable: string;
	undone: string;
	/** An undo with no restore to undo (`noop`). */
	nothingToUndo: string;
	/** A `401` or `403`. */
	denied: string;
	/** Any other failure. */
	failed: string;
};

export const defaultHistoryLabels: HistoryPanelLabels = {
	title: 'Version history',
	versions: 'Versions',
	morning: 'Morning',
	evening: 'Evening',
	loading: 'Loading…',
	empty: 'No versions yet. A version is saved twice a day while the page changes.',
	noEditors: 'No editors',
	moreEditors: '+{n}',
	saved: 'Saved',
	preview: 'Version preview',
	choose: 'Choose a version to preview it.',
	highlight: 'Highlight changes',
	added: '{n} added since',
	removed: '{n} removed since',
	changed: '{n} changed since',
	same: 'Same as the current page',
	restore: 'Restore version',
	restoring: 'Restoring…',
	undo: 'Undo restore',
	restored: 'Version restored.',
	unchanged: 'The page already matches this version.',
	unavailable: 'This version is no longer available.',
	undone: 'Restore undone.',
	nothingToUndo: 'There is no restore to undo.',
	denied: 'You do not have access to this history.',
	failed: 'The history could not be reached.'
};

export type HistoryPanelProps = {
	/** Where the versions come from: `createHistoryClient(…)`, or any object with `list`, `read`, `restore` and `undo`. */
	client: HistoryClient;
	/** The live document the preview is compared with. Without it, no change is highlighted. */
	document?: EdytorDocument;
	/** The preview's plugins: the ones the live view uses, so every kind renders as it does there. */
	plugins?: Plugin[];
	/** Whether the preview adds the default plugins, as `<Edytor defaultPlugins>`. */
	defaultPlugins?: boolean;
	/** Hide Restore and Undo restore (a reader). */
	readonly?: boolean;
	/** Highlight the blocks added, removed and changed since the version (bindable). */
	highlight?: boolean;
	/** The locale dates and times are written in (default the browser's). */
	locale?: string | string[];
	/** Replace any of the panel's words. */
	labels?: Partial<HistoryPanelLabels>;
	/** The panel's class. */
	class?: string;
	/** The preview editor's class (your theme's, such as `edytor-notion`). */
	previewClass?: string;
	/** A version's row content, in place of its date, editors and time. */
	version?: Snippet<[HistoryVersion, { selected: boolean }]>;
	/** After a restore the room answered. */
	onRestore?: (result: HistoryRestoreResult) => void;
	/** After an undo the room answered. */
	onUndo?: (result: HistoryUndoResult) => void;
	/** A request failed (the panel shows `labels.denied` or `labels.failed`). */
	onError?: (error: unknown) => void;
};
