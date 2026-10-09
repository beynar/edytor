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
import { englishLabels, type HistoryPanelLabels, type PartialLabels } from '$lib/labels.js';
import type { MenuItemPayload } from '$lib/plugins/chrome.js';

export type { HistoryPanelLabels };

/** The panel's English words: the label dictionary's `history` section (`englishLabels.history`). */
export const defaultHistoryLabels: HistoryPanelLabels = englishLabels.history;

/**
 * One row of the versions list, for an `item` snippet: the row shape every
 * menu shares (`item` is the version, `label` its date and slot, `run` and
 * `select` preview it), with the version again. Spread `option` on the
 * row's focusable element (its `role="option"`, id, `aria-selected` and the
 * list's one tab stop): the list's arrows, Home and End walk those rows.
 */
export type HistoryVersionItem = MenuItemPayload<HistoryVersion> & {
	/** The version (the same as `item`). */
	version: HistoryVersion;
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
	labels?: PartialLabels<'history'>;
	/** The panel's class. */
	class?: string;
	/** The preview editor's class (your theme's, such as `edytor-notion`). */
	previewClass?: string;
	/** A version's row content, in place of its date, editors and time. */
	version?: Snippet<[HistoryVersion, { selected: boolean }]>;
	/**
	 * Replace a version's whole row (the list item's content): one object
	 * argument, the shape every menu's rows share. Spread its `option` on
	 * the row's button. Takes precedence over `version`.
	 */
	item?: Snippet<[HistoryVersionItem]>;
	/** After a restore the room answered. */
	onRestore?: (result: HistoryRestoreResult) => void;
	/** After an undo the room answered. */
	onUndo?: (result: HistoryUndoResult) => void;
	/** A request failed (the panel shows `labels.denied` or `labels.failed`). */
	onError?: (error: unknown) => void;
};
