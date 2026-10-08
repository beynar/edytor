<script module lang="ts">
	import type { VersionChange } from './diff.js';
	import type { JSONDoc } from '$lib/utils/json.js';
	import type { HistoryVersion } from './client.js';
	import type { HistoryPanelProps } from './panel.js';

	/** No change highlighted. */
	const NONE: ReadonlyMap<string, VersionChange> = new Map();
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import Edytor from '$lib/components/Edytor.svelte';
	import { HistoryRequestError } from './client.js';
	import { versionDiff } from './diff.js';
	import { versionHighlightsPlugin } from './versionHighlights.js';
	import { labelsWith } from '$lib/labels.js';

	let {
		client,
		document: live,
		plugins = [],
		defaultPlugins = true,
		readonly = false,
		highlight = $bindable(true),
		locale,
		labels: labelOverrides,
		class: className,
		previewClass,
		version: versionRow,
		onRestore,
		onUndo,
		onError
	}: HistoryPanelProps = $props();

	const labels = $derived(labelsWith('history', labelOverrides));

	/** The versions, newest first (`null` while the first list loads). */
	let versions = $state.raw<HistoryVersion[] | null>(null);
	let selected = $state<string | null>(null);
	/** The selected version's JSON, once read (`null` while it loads or when it is gone). */
	let shown = $state.raw<JSONDoc | null>(null);
	let reading = $state(false);
	/** The live document as JSON, read again at each of its commits. */
	let current = $state.raw<JSONDoc | null>(null);
	let busy = $state(false);
	/** A restore this panel applied, which Undo restore can take back. */
	let undoable = $state(false);
	/** The last outcome, announced (`aria-live`). */
	let status = $state('');
	let failed = $state(false);
	/** The request serial: an older answer never replaces a newer one. */
	let serial = 0;

	$effect(() => {
		const document = live;
		if (!document) {
			current = null;
			return;
		}
		current = document.facade.toJSON();
		return document.facade.onChange(() => (current = document.facade.toJSON()));
	});

	const diff = $derived(shown && current ? versionDiff(shown, current) : null);
	const changes = $derived(highlight && diff ? diff.changes : NONE);
	/** What the preview renders: the version, with the blocks added since when highlighting. */
	const previewValue = $derived(shown && (highlight && diff ? diff.preview : shown));
	/** The preview remounts when what it renders changes (`value` is read once). */
	const previewSource = $derived(previewValue && JSON.stringify(previewValue));
	const previewPlugins = $derived([versionHighlightsPlugin(() => changes), ...plugins]);

	const fail = (error: unknown) => {
		failed = true;
		status =
			error instanceof HistoryRequestError && (error.status === 401 || error.status === 403)
				? labels.denied
				: labels.failed;
		onError?.(error);
	};

	/** List the versions again; keeps the selection when it is still listed, else selects the newest. */
	export const refresh = async () => {
		try {
			const listed = await client.list();
			versions = listed;
			if (selected === null || !listed.some((entry) => entry.key === selected)) {
				void select(listed[0]?.key ?? null);
			}
		} catch (error) {
			versions = versions ?? [];
			fail(error);
		}
	};

	/** Preview the version `key` (`null`: none). */
	export const select = async (key: string | null) => {
		selected = key;
		shown = null;
		failed = false;
		status = '';
		const mine = ++serial;
		if (key === null) return;
		reading = true;
		try {
			const json = await client.read(key);
			if (mine !== serial) return;
			shown = json;
			if (json === null) {
				failed = true;
				status = labels.unavailable;
			}
		} catch (error) {
			if (mine === serial) fail(error);
		} finally {
			if (mine === serial) reading = false;
		}
	};

	const restore = async () => {
		if (selected === null || busy) return;
		busy = true;
		failed = false;
		status = labels.restoring;
		try {
			const result = await client.restore(selected);
			if (result.status === 'applied') undoable = true;
			// A version gone since it was listed: list again, then say so.
			if (result.status === 'refused') await refresh();
			failed = result.status === 'refused';
			status =
				result.status === 'applied'
					? labels.restored
					: result.status === 'noop'
						? labels.unchanged
						: labels.unavailable;
			onRestore?.(result);
		} catch (error) {
			fail(error);
		} finally {
			busy = false;
		}
	};

	const undo = async () => {
		if (busy) return;
		busy = true;
		failed = false;
		try {
			const result = await client.undo();
			undoable = false;
			status = result.status === 'applied' ? labels.undone : labels.nothingToUndo;
			onUndo?.(result);
		} catch (error) {
			fail(error);
		} finally {
			busy = false;
		}
	};

	// The first list, and a new one for a new client.
	$effect(() => {
		void client;
		untrack(() => void refresh());
	});

	/** A date of the room's calendar (`YYYY-MM-DD`), written in `locale`. */
	const dateOf = (entry: HistoryVersion) => {
		const day = new Date(`${entry.date}T00:00:00Z`);
		if (Number.isNaN(day.getTime())) return entry.date;
		return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(day);
	};
	const titleOf = (entry: HistoryVersion) =>
		`${dateOf(entry)} · ${entry.slot === 'am' ? labels.morning : labels.evening}`;
	const timeOf = (entry: HistoryVersion) => {
		const at = new Date(entry.at);
		return Number.isNaN(at.getTime())
			? ''
			: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
	};
	const editorsOf = (entry: HistoryVersion) => {
		if (entry.editors.length === 0 && !entry.more) return labels.noEditors;
		const more = entry.more ? ` ${labels.moreEditors(entry.more)}` : '';
		return `${entry.editors.join(', ')}${more}`;
	};

	const selectedEntry = $derived(versions?.find((entry) => entry.key === selected) ?? null);

	/** The listbox's keys: the arrows, Home and End move the selection and the focus. */
	const onListKey = (event: KeyboardEvent) => {
		if (!versions?.length) return;
		const at = versions.findIndex((entry) => entry.key === selected);
		const next =
			event.key === 'ArrowDown'
				? Math.min(versions.length - 1, at + 1)
				: event.key === 'ArrowUp'
					? Math.max(0, at - 1)
					: event.key === 'Home'
						? 0
						: event.key === 'End'
							? versions.length - 1
							: null;
		if (next === null) return;
		event.preventDefault();
		const key = versions[next]!.key;
		if (key !== selected) void select(key);
		const list = event.currentTarget as HTMLElement;
		(list.querySelectorAll('[role="option"]')[next] as HTMLElement | undefined)?.focus();
	};
</script>

<section data-edytor-history class={className} aria-label={labels.title}>
	<div data-edytor-history-body>
		<div data-edytor-history-preview>
			<header data-edytor-history-header>
				<h2 data-edytor-history-title>
					{selectedEntry ? titleOf(selectedEntry) : labels.title}
				</h2>
				{#if diff}
					<div data-edytor-history-legend>
						<label data-edytor-history-toggle>
							<input type="checkbox" bind:checked={highlight} />
							{labels.highlight}
						</label>
						{#if highlight}
							{#if diff.added + diff.removed + diff.changed === 0}
								<span data-edytor-history-count="same">{labels.same}</span>
							{/if}
							{#if diff.added}
								<span data-edytor-history-count="added">{labels.added(diff.added)}</span>
							{/if}
							{#if diff.removed}
								<span data-edytor-history-count="removed">{labels.removed(diff.removed)}</span>
							{/if}
							{#if diff.changed}
								<span data-edytor-history-count="changed">{labels.changed(diff.changed)}</span>
							{/if}
						{/if}
					</div>
				{/if}
			</header>
			<div data-edytor-history-page aria-busy={reading}>
				{#if previewValue}
					{#key previewSource}
						<Edytor
							readonly
							value={previewValue}
							plugins={previewPlugins}
							{defaultPlugins}
							blockHandles={false}
							class={previewClass}
							aria-label={labels.preview}
						/>
					{/key}
				{:else}
					<p data-edytor-history-placeholder>
						{reading || versions === null ? labels.loading : labels.choose}
					</p>
				{/if}
			</div>
		</div>
		<aside data-edytor-history-side>
			<h3 data-edytor-history-heading>{labels.versions}</h3>
			{#if versions === null}
				<p data-edytor-history-placeholder>{labels.loading}</p>
			{:else if versions.length === 0}
				<p data-edytor-history-placeholder>{labels.empty}</p>
			{:else}
				<ul
					data-edytor-history-list
					role="listbox"
					aria-label={labels.versions}
					onkeydown={onListKey}
				>
					{#each versions as entry (entry.key)}
						{@const isSelected = entry.key === selected}
						<li role="presentation">
							<button
								type="button"
								role="option"
								aria-selected={isSelected}
								tabindex={isSelected || (selected === null && entry === versions[0]) ? 0 : -1}
								data-edytor-history-version={entry.key}
								onclick={() => void select(entry.key)}
							>
								{#if versionRow}
									{@render versionRow(entry, { selected: isSelected })}
								{:else}
									<span data-edytor-history-version-title>{titleOf(entry)}</span>
									<span data-edytor-history-version-editors>{editorsOf(entry)}</span>
									<span data-edytor-history-version-time>
										{labels.saved}
										<time datetime={new Date(entry.at).toISOString()}>{timeOf(entry)}</time>
									</span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
			<footer data-edytor-history-actions>
				<p
					data-edytor-history-status
					role="status"
					aria-live="polite"
					data-failed={failed || undefined}
				>
					{status}
				</p>
				{#if !readonly}
					<div data-edytor-history-buttons>
						{#if undoable}
							<button
								type="button"
								data-edytor-history-undo
								disabled={busy}
								onclick={() => void undo()}
							>
								{labels.undo}
							</button>
						{/if}
						<button
							type="button"
							data-edytor-history-restore
							disabled={busy || selected === null || shown === null}
							onclick={() => void restore()}
						>
							{busy ? labels.restoring : labels.restore}
						</button>
					</div>
				{/if}
			</footer>
		</aside>
	</div>
</section>

<style>
	[data-edytor-history] {
		container-type: inline-size;
		height: 100%;
		min-height: 0;
		color: inherit;
		font: inherit;
	}
	/* The grid inside the container, so its own width can reshape it. */
	[data-edytor-history-body] {
		display: grid;
		grid-template-columns: minmax(0, 1fr) var(--edytor-history-side-width, 260px);
		height: 100%;
		min-height: 0;
	}
	[data-edytor-history-preview] {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	[data-edytor-history-header] {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 8px 16px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--edytor-history-border, rgb(55 53 47 / 0.09));
	}
	[data-edytor-history-title] {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
	}
	[data-edytor-history-legend] {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 12px;
		font-size: 12px;
		color: var(--edytor-history-muted, rgb(55 53 47 / 0.8));
	}
	[data-edytor-history-toggle] {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		cursor: pointer;
	}
	[data-edytor-history-count]::before {
		content: '';
		display: inline-block;
		width: 8px;
		height: 8px;
		margin-inline-end: 4px;
		border-radius: 2px;
		background: currentColor;
		vertical-align: baseline;
	}
	[data-edytor-history-count='same']::before {
		display: none;
	}
	[data-edytor-history-count='added']::before {
		background: var(--edytor-version-added-bar, rgb(68 131 97));
	}
	[data-edytor-history-count='removed']::before {
		background: var(--edytor-version-removed-bar, rgb(212 76 71));
	}
	[data-edytor-history-count='changed']::before {
		background: var(--edytor-version-changed-bar, rgb(203 145 47));
	}
	[data-edytor-history-page] {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 16px 24px;
	}
	[data-edytor-history-side] {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-inline-start: 1px solid var(--edytor-history-border, rgb(55 53 47 / 0.09));
		background: var(--edytor-history-side, rgb(251 251 250));
	}
	[data-edytor-history-heading] {
		margin: 0;
		padding: 12px 12px 6px;
		font-size: 12px;
		font-weight: 500;
		color: var(--edytor-history-muted, rgb(55 53 47 / 0.8));
	}
	[data-edytor-history-placeholder] {
		margin: 0;
		padding: 8px 12px;
		font-size: 13px;
		color: var(--edytor-history-muted, rgb(55 53 47 / 0.8));
	}
	[data-edytor-history-list] {
		flex: 1;
		min-height: 0;
		overflow: auto;
		margin: 0;
		padding: 0 6px 6px;
		list-style: none;
	}
	[data-edytor-history-list] button {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		padding: 6px 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: start;
		cursor: pointer;
	}
	[data-edytor-history-list] button:hover {
		background: var(--edytor-history-hover, rgb(55 53 47 / 0.06));
	}
	[data-edytor-history-list] button[aria-selected='true'] {
		background: var(--edytor-history-selected, rgb(35 131 226 / 0.14));
	}
	[data-edytor-history-version-title] {
		font-size: 14px;
		font-weight: 500;
	}
	[data-edytor-history-version-editors],
	[data-edytor-history-version-time] {
		font-size: 12px;
		color: var(--edytor-history-muted, rgb(55 53 47 / 0.8));
		overflow-wrap: anywhere;
	}
	[data-edytor-history-actions] {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		border-top: 1px solid var(--edytor-history-border, rgb(55 53 47 / 0.09));
	}
	[data-edytor-history-status] {
		margin: 0;
		min-height: 1em;
		font-size: 12px;
		color: var(--edytor-history-muted, rgb(55 53 47 / 0.8));
	}
	[data-edytor-history-status][data-failed] {
		color: var(--edytor-history-error, rgb(190 56 52));
	}
	[data-edytor-history-buttons] {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	[data-edytor-history-buttons] button {
		padding: 6px 12px;
		border: 1px solid var(--edytor-history-border, rgb(55 53 47 / 0.16));
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 14px;
		cursor: pointer;
	}
	[data-edytor-history-restore] {
		border-color: transparent !important;
		background: var(--edytor-history-accent, rgb(11 110 203)) !important;
		color: white !important;
		font-weight: 500;
	}
	[data-edytor-history-buttons] button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	@container (max-width: 640px) {
		[data-edytor-history-body] {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto minmax(0, 1fr);
		}
		[data-edytor-history-side] {
			order: -1;
			max-height: min(45vh, 320px);
			border-inline-start: 0;
			border-bottom: 1px solid var(--edytor-history-border, rgb(55 53 47 / 0.09));
		}
	}
</style>
