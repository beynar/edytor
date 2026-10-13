<script lang="ts">
	import { Button } from '$registry/ui/button/index.js';
	import { untrack, type Snippet } from 'svelte';
	import { words } from './words.svelte.js';
	import {
		Edytor,
		VersionHistory,
		type EdytorDocument,
		type HistoryClient,
		type HistoryVersion,
		type Plugin
	} from 'edytor';

	/**
	 * A version history panel (Notion's), drawn over `VersionHistory`: the
	 * previewed version with its changes since highlighted, and the list of
	 * versions with Restore and Undo restore.
	 */
	let {
		client,
		document: live,
		plugins = [],
		defaultPlugins = true,
		readonly = false,
		locale,
		class: className,
		previewClass,
		row
	}: {
		client: HistoryClient;
		document?: EdytorDocument;
		plugins?: Plugin[];
		defaultPlugins?: boolean;
		readonly?: boolean;
		locale?: string | string[];
		class?: string;
		previewClass?: string;
		/** A version's row content, in place of its date, editors and time. */
		row?: Snippet<[HistoryVersion, { selected: boolean }]>;
	} = $props();

	const uid = $props.id();
	// Its options are read once: a new client is a new panel (`{#key}`).
	const history = untrack(
		() =>
			new VersionHistory({
				client,
				document: live,
				plugins,
				locale,
				id: uid
			})
	);
	const labels = $derived(words.history);
	/** A version's day and half of the day (`Oct 8, 2026 · Morning`). */
	const titleOf = (entry: HistoryVersion) =>
		`${history.dateOf(entry)} · ${entry.slot === 'am' ? labels.morning : labels.evening}`;
	/** Who edited a version (`Ada, Alan +2`). */
	const editorsOf = (entry: HistoryVersion) =>
		entry.editors.length === 0 && !entry.more
			? labels.noEditors
			: `${entry.editors.join(', ')}${entry.more ? ` ${labels.moreEditors(entry.more)}` : ''}`;
	const diff = $derived(history.diff);
</script>

<section data-edytor-history class={className} aria-label={labels.title}>
	<div data-edytor-history-body>
		<div data-edytor-history-preview>
			<header data-edytor-history-header>
				<h2 data-edytor-history-title>
					{history.selectedVersion ? titleOf(history.selectedVersion) : labels.title}
				</h2>
				{#if diff}
					<div data-edytor-history-legend>
						<label data-edytor-history-toggle>
							<input type="checkbox" bind:checked={history.highlight} />
							{labels.highlight}
						</label>
						{#if history.highlight}
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
			<div data-edytor-history-page aria-busy={history.reading}>
				{#if history.preview}
					{#key history.previewKey}
						<Edytor
							readonly
							value={history.preview}
							plugins={history.previewPlugins}
							{defaultPlugins}
							class={previewClass}
							aria-label={labels.preview}
						/>
					{/key}
				{:else}
					<p data-edytor-history-placeholder>
						{history.reading || history.versions === null ? labels.loading : labels.choose}
					</p>
				{/if}
			</div>
		</div>
		<aside data-edytor-history-side>
			<h3 data-edytor-history-heading>{labels.versions}</h3>
			{#if history.versions === null}
				<p data-edytor-history-placeholder>{labels.loading}</p>
			{:else if history.versions.length === 0}
				<p data-edytor-history-placeholder>{labels.empty}</p>
			{:else}
				<ul
					data-edytor-history-list
					role="listbox"
					aria-label={labels.versions}
					{@attach history.keys}
				>
					{#each history.versions as entry, index (entry.key)}
						<li role="presentation">
							<Button
								variant="ghost"
								data-edytor-history-version={entry.key}
								data-selected={entry.key === history.selected}
								{@attach history.option(index)}
								onclick={() => void history.select(entry.key)}
							>
								{#if row}
									{@render row(entry, { selected: entry.key === history.selected })}
								{:else}
									<span data-edytor-history-version-title>{titleOf(entry)}</span>
									<span data-edytor-history-version-editors>{editorsOf(entry)}</span>
									<span data-edytor-history-version-time>
										{labels.saved}
										<time datetime={new Date(entry.at).toISOString()}>{history.timeOf(entry)}</time>
									</span>
								{/if}
							</Button>
						</li>
					{/each}
				</ul>
			{/if}
			<footer data-edytor-history-actions>
				<p
					data-edytor-history-status
					role="status"
					aria-live="polite"
					data-failed={history.failed || undefined}
				>
					{history.status && labels[history.status]}
				</p>
				{#if !readonly}
					<div data-edytor-history-buttons>
						{#if history.undoable}
							<Button
								variant="ghost"
								data-edytor-history-undo
								disabled={history.busy}
								onclick={() => void history.undo()}
							>
								{labels.undo}
							</Button>
						{/if}
						<Button
							variant="ghost"
							data-edytor-history-restore
							disabled={history.busy || history.selected === null || history.shown === null}
							onclick={() => void history.restore()}
						>
							{history.busy ? labels.restoring : labels.restore}
						</Button>
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
		border-bottom: 1px solid var(--edytor-history-border, var(--accent));
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
		color: var(--edytor-history-muted, color-mix(in oklab, var(--foreground) 70%, transparent));
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
		background: var(--edytor-version-added-bar, var(--edytor-color-green));
	}
	[data-edytor-history-count='removed']::before {
		background: var(--edytor-version-removed-bar, var(--destructive));
	}
	[data-edytor-history-count='changed']::before {
		background: var(--edytor-version-changed-bar, var(--edytor-color-yellow));
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
		border-inline-start: 1px solid var(--edytor-history-border, var(--accent));
		background: var(--edytor-history-side, var(--muted));
	}
	[data-edytor-history-heading] {
		margin: 0;
		padding: 12px 12px 6px;
		font-size: 12px;
		font-weight: 500;
		color: var(--edytor-history-muted, color-mix(in oklab, var(--foreground) 70%, transparent));
	}
	[data-edytor-history-placeholder] {
		margin: 0;
		padding: 8px 12px;
		font-size: 13px;
		color: var(--edytor-history-muted, color-mix(in oklab, var(--foreground) 70%, transparent));
	}
	[data-edytor-history-list] {
		flex: 1;
		min-height: 0;
		overflow: auto;
		margin: 0;
		padding: 0 6px 6px;
		list-style: none;
	}
	[data-edytor-history-list] :global(button) {
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
	[data-edytor-history-list] :global(button:hover) {
		background: var(--edytor-history-hover, var(--accent));
	}
	[data-edytor-history-list] :global(button[data-selected='true']) {
		background: var(--edytor-history-selected, color-mix(in oklab, var(--ring) 14%, transparent));
	}
	[data-edytor-history-version-title] {
		font-size: 14px;
		font-weight: 500;
	}
	[data-edytor-history-version-editors],
	[data-edytor-history-version-time] {
		font-size: 12px;
		color: var(--edytor-history-muted, color-mix(in oklab, var(--foreground) 70%, transparent));
		overflow-wrap: anywhere;
	}
	[data-edytor-history-actions] {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		border-top: 1px solid var(--edytor-history-border, var(--accent));
	}
	[data-edytor-history-status] {
		margin: 0;
		min-height: 1em;
		font-size: 12px;
		color: var(--edytor-history-muted, color-mix(in oklab, var(--foreground) 70%, transparent));
	}
	[data-edytor-history-status][data-failed] {
		color: var(
			--edytor-history-error,
			color-mix(in oklab, var(--destructive) 75%, var(--foreground))
		);
	}
	[data-edytor-history-buttons] {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	[data-edytor-history-buttons] :global(button) {
		padding: 6px 12px;
		border: 1px solid var(--edytor-history-border, var(--border));
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 14px;
		cursor: pointer;
	}
	[data-edytor-history] :global([data-edytor-history-restore]) {
		border-color: transparent !important;
		background: var(--edytor-history-accent, var(--primary)) !important;
		color: white !important;
		font-weight: 500;
	}
	[data-edytor-history-buttons] :global(button:disabled) {
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
			border-bottom: 1px solid var(--edytor-history-border, var(--accent));
		}
	}
</style>
