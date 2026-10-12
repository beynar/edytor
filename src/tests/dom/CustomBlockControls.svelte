<script module lang="ts">
	import type {
		BookmarkCardPayload,
		CalloutIconPayload,
		EmbedFallbackPayload,
		EmptyBodyPayload,
		EquationErrorPayload,
		EquationPlaceholderPayload,
		FileRowPayload,
		PageBlockLinkPayload,
		TocEmptyPayload,
		TocEntryPayload,
		TodoCheckboxPayload
	} from '$lib/index.js';

	/**
	 * An app's own markup for the controls inside blocks, written as a custom
	 * menu is: each attaches the payload's attachment (its marker, ARIA,
	 * press and action) to its own element, and renders the payload's state,
	 * words and URLs.
	 */
	export {
		checkbox,
		calloutIcon,
		emptyBody,
		equationPlaceholder,
		equationError,
		bookmarkCard,
		fileRow,
		embedFallback,
		tocEntry,
		tocEmpty,
		pageLink
	};
</script>

{#snippet checkbox(box: TodoCheckboxPayload)}
	<button type="button" data-testid="custom-checkbox" {@attach box.control}
		>{box.checked ? '☑' : '☐'}</button
	>
{/snippet}

{#snippet calloutIcon(icon: CalloutIconPayload)}
	{#if icon.editable}
		<button type="button" data-testid="custom-callout-icon" {@attach icon.control}
			>[{icon.icon}]</button
		>
	{:else}
		<i data-testid="custom-callout-icon" {@attach icon.control}>[{icon.icon}]</i>
	{/if}
{/snippet}

{#snippet emptyBody(hint: EmptyBodyPayload)}
	<p data-testid="custom-empty-body" data-kind={hint.kind} {@attach hint.control}>+ {hint.label}</p>
{/snippet}

{#snippet equationPlaceholder(empty: EquationPlaceholderPayload)}
	<em data-testid="custom-equation-placeholder" data-display={String(empty.display)}
		>{empty.label}</em
	>
{/snippet}

{#snippet equationError(failed: EquationErrorPayload)}
	<code data-testid="custom-equation-error" title={failed.error}
		>{failed.label}: {failed.expression}</code
	>
{/snippet}

{#snippet bookmarkCard(card: BookmarkCardPayload)}
	<a data-testid="custom-bookmark" href={card.url} {@attach card.link}
		><b>{card.title ?? card.url}</b> <small>{card.description}</small></a
	>
{/snippet}

{#snippet fileRow(row: FileRowPayload)}
	<a data-testid="custom-file" href={row.src} {@attach row.link}>{row.name} ({row.sizeLabel})</a>
{/snippet}

{#snippet embedFallback(fallback: EmbedFallbackPayload)}
	<a data-testid="custom-embed-fallback" href={fallback.url} {@attach fallback.link}
		>Open {fallback.url}</a
	>
{/snippet}

{#snippet tocEntry(entry: TocEntryPayload)}
	<button
		type="button"
		data-testid="custom-toc-entry"
		data-depth={entry.depth}
		{@attach entry.control}>{entry.level}. {entry.label}</button
	>
{/snippet}

{#snippet tocEmpty(empty: TocEmptyPayload)}
	<p data-testid="custom-toc-empty">{empty.label}</p>
{/snippet}

{#snippet pageLink(link: PageBlockLinkPayload)}
	{#if link.href}
		<a data-testid="custom-page-link" href={link.href} {@attach link.control}>→ {link.label}</a>
	{:else}
		<button type="button" data-testid="custom-page-link" {@attach link.control}
			>→ {link.label}</button
		>
	{/if}
{/snippet}
