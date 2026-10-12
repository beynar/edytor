/**
 * The version history's controller (`VersionHistory`): a room's stored
 * versions, the one previewed and its changes since (`versionDiff`), and
 * Restore / Undo restore. The app draws the panel: the list (its rows'
 * `option(index)` and the list's `keys`, attachments), the preview (`<Edytor readonly
 * value={history.preview} plugins={history.previewPlugins}>`), the status.
 */
import { untrack } from 'svelte';
import type { EdytorDocument } from '$lib/crdt/document.js';
import type { Plugin } from '$lib/plugins.js';
import type { JSONDoc } from '$lib/utils/json.js';
import {
	HistoryRequestError,
	type HistoryClient,
	type HistoryRestoreResult,
	type HistoryUndoResult,
	type HistoryVersion
} from './client.js';
import { versionDiff, type VersionChange } from './diff.js';
import { versionHighlightsPlugin } from './versionHighlights.js';
import type { Attachment } from 'svelte/attachments';
import { optionAttachment } from '$lib/plugins/list.svelte.js';
import { listen } from '$lib/utils/listen.js';

/**
 * The last outcome to announce (`''`: none): a restore in flight or done
 * (`unchanged`: the page already matched), the previewed version gone
 * (`unavailable`), an undo done or with nothing to undo, a request refused
 * (`denied`: a `401` or `403`) or failed. Your panel says it in its words.
 */
export type VersionHistoryStatus =
	| ''
	| 'restoring'
	| 'restored'
	| 'unchanged'
	| 'unavailable'
	| 'undone'
	| 'nothingToUndo'
	| 'denied'
	| 'failed';

/** No change highlighted. */
const NONE: ReadonlyMap<string, VersionChange> = new Map();

export type VersionHistoryOptions = {
	/** Where the versions come from: `createHistoryClient(…)`, or any object with `list`, `read`, `restore` and `undo`. */
	client: HistoryClient;
	/** The live document the preview is compared with. Without it, no change is highlighted. */
	document?: EdytorDocument;
	/** The preview's plugins: the ones the live view uses, so every kind renders as it does there. */
	plugins?: Plugin[];
	/** The locale dates and times are written in (default the browser's). */
	locale?: string | string[];
	/** The id prefix of the list's rows (page-unique: `$props.id()`). */
	id?: string;
	/** After a restore the room answered. */
	onRestore?: (result: HistoryRestoreResult) => void;
	/** After an undo the room answered. */
	onUndo?: (result: HistoryUndoResult) => void;
	/** A request failed (`status` is `denied` or `failed`). */
	onError?: (error: unknown) => void;
};

/**
 * A view of a room's versions, made in a component's script (its effects
 * list the versions, and follow the live document's commits). Read its
 * state reactively; `select`, `restore`, `undo` and `refresh` act.
 */
export class VersionHistory {
	/** The versions, newest first (`null` while the first list loads). */
	versions = $state.raw<HistoryVersion[] | null>(null);
	/** The previewed version's key. */
	selected = $state<string | null>(null);
	/** The previewed version's JSON, once read (`null` while it loads or when it is gone). */
	shown = $state.raw<JSONDoc | null>(null);
	/** The previewed version is being read. */
	reading = $state(false);
	/** A restore or an undo is in flight. */
	busy = $state(false);
	/** A restore this view applied, which `undo` can take back. */
	undoable = $state(false);
	/** The last outcome, to announce (`aria-live`) in your words. */
	status = $state<VersionHistoryStatus>('');
	/** The last outcome failed. */
	failed = $state(false);
	/** Highlight the blocks added, removed and changed since the version. */
	highlight = $state(true);
	/** The live document as JSON, read again at each of its commits. */
	#current = $state.raw<JSONDoc | null>(null);
	/** The request serial: an older answer never replaces a newer one. */
	#serial = 0;
	readonly #options: VersionHistoryOptions;

	constructor(options: VersionHistoryOptions) {
		this.#options = options;
		$effect(() => {
			const document = options.document;
			if (!document) return void (this.#current = null);
			this.#current = document.toJSON();
			return document.onChange(() => (this.#current = document.toJSON()));
		});
		$effect(() => untrack(() => void this.refresh()));
	}

	/** The previewed version against the live document: its counts and the changed blocks. */
	diff = $derived.by(() =>
		this.shown && this.#current ? versionDiff(this.shown, this.#current) : null
	);
	/** What the preview renders: the version, with the blocks removed since when highlighting. */
	preview = $derived.by(
		() => this.shown && (this.highlight && this.diff ? this.diff.preview : this.shown)
	);
	/** A key for the preview: it remounts when what it renders changes (`value` is read once). */
	previewKey = $derived.by(() => this.preview && JSON.stringify(this.preview));
	/** The blocks changed since the version, by id, while highlighting (else none). */
	changes = $derived.by(() => (this.highlight && this.diff ? this.diff.changes : NONE));
	/** The preview's plugins: the highlights of the changes (read live), then the app's. */
	previewPlugins = $derived.by(() => [
		versionHighlightsPlugin(() => this.changes),
		...(this.#options.plugins ?? [])
	]);
	/** The previewed version, as listed. */
	selectedVersion = $derived.by(
		() => this.versions?.find((entry) => entry.key === this.selected) ?? null
	);

	#fail = (error: unknown) => {
		this.failed = true;
		this.status =
			error instanceof HistoryRequestError && (error.status === 401 || error.status === 403)
				? 'denied'
				: 'failed';
		this.#options.onError?.(error);
	};

	/** List the versions again; keeps the selection when it is still listed, else selects the newest. */
	refresh = async () => {
		try {
			const listed = await this.#options.client.list();
			this.versions = listed;
			if (this.selected === null || !listed.some((entry) => entry.key === this.selected))
				void this.select(listed[0]?.key ?? null);
		} catch (error) {
			this.versions = this.versions ?? [];
			this.#fail(error);
		}
	};

	/** Preview the version `key` (`null`: none). */
	select = async (key: string | null) => {
		this.selected = key;
		this.shown = null;
		this.failed = false;
		this.status = '';
		const mine = ++this.#serial;
		if (key === null) return;
		this.reading = true;
		try {
			const json = await this.#options.client.read(key);
			if (mine !== this.#serial) return;
			this.shown = json;
			if (json === null) {
				this.failed = true;
				this.status = 'unavailable';
			}
		} catch (error) {
			if (mine === this.#serial) this.#fail(error);
		} finally {
			if (mine === this.#serial) this.reading = false;
		}
	};

	/** Restore the previewed version (the room writes it as one change). */
	restore = async () => {
		const { selected } = this;
		if (selected === null || this.busy) return;
		this.busy = true;
		this.failed = false;
		this.status = 'restoring';
		try {
			const result = await this.#options.client.restore(selected);
			if (result.status === 'applied') this.undoable = true;
			// A version gone since it was listed: list again, then say so.
			if (result.status === 'refused') await this.refresh();
			this.failed = result.status === 'refused';
			this.status =
				result.status === 'applied'
					? 'restored'
					: result.status === 'noop'
						? 'unchanged'
						: 'unavailable';
			this.#options.onRestore?.(result);
		} catch (error) {
			this.#fail(error);
		} finally {
			this.busy = false;
		}
	};

	/** Take back the restore this view applied. */
	undo = async () => {
		if (this.busy) return;
		this.busy = true;
		this.failed = false;
		try {
			const result = await this.#options.client.undo();
			this.undoable = false;
			this.status = result.status === 'applied' ? 'undone' : 'nothingToUndo';
			this.#options.onUndo?.(result);
		} catch (error) {
			this.#fail(error);
		} finally {
			this.busy = false;
		}
	};

	/** A version's day (`Oct 8, 2026`), in `locale`; its half of the day is `entry.slot`. */
	dateOf = (entry: HistoryVersion) => {
		const day = new Date(`${entry.date}T00:00:00Z`);
		return Number.isNaN(day.getTime())
			? entry.date
			: new Intl.DateTimeFormat(this.#options.locale, {
					dateStyle: 'medium',
					timeZone: 'UTC'
				}).format(day);
	};

	/** When a version was saved, in `locale`. */
	timeOf = (entry: HistoryVersion) => {
		const at = new Date(entry.at);
		return Number.isNaN(at.getTime())
			? ''
			: new Intl.DateTimeFormat(this.#options.locale, {
					dateStyle: 'medium',
					timeStyle: 'short'
				}).format(at);
	};

	/**
	 * The attachment of the version at `index`'s row
	 * (`{@attach history.option(index)}`, on its focusable element):
	 * `role="option"`, its id, `aria-selected`, the list's one tab stop when
	 * it is selected, else the first.
	 */
	option = (index: number): Attachment<HTMLElement> => {
		const selected = this.versions?.[index]?.key === this.selected;
		return optionAttachment(
			`${this.#options.id ?? 'edytor-history'}-version-${index}`,
			'option',
			selected,
			{ tabindex: selected || (this.selected === null && index === 0) ? 0 : -1 },
			false
		);
	};

	/** The list's attachment (`{@attach history.keys}`): the arrows, Home and End move the selection and the focus. */
	keys: Attachment<HTMLElement> = (node) => listen(node, 'keydown', this.#keydown);

	#keydown = (event: KeyboardEvent) => {
		const { versions } = this;
		if (!versions?.length) return;
		const at = versions.findIndex((entry) => entry.key === this.selected);
		const next = (
			{
				ArrowDown: Math.min(versions.length - 1, at + 1),
				ArrowUp: Math.max(0, at - 1),
				Home: 0,
				End: versions.length - 1
			} as Record<string, number>
		)[event.key];
		if (next === undefined) return;
		event.preventDefault();
		const key = versions[next]!.key;
		if (key !== this.selected) void this.select(key);
		const list = event.currentTarget as HTMLElement;
		(list.querySelectorAll('[role="option"]')[next] as HTMLElement | undefined)?.focus();
	};
}
