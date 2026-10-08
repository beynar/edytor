<script lang="ts">
	import { getContext, untrack } from 'svelte';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import {
		pageHref,
		pageIdOf,
		pageLabels,
		pageTitleOf,
		storePageTitle,
		type PagePluginOptions
	} from './page.js';

	/**
	 * A page block's link (Notion's subpage row): the page's icon and title,
	 * which open the page. The title is your `title(pageId)`'s answer while it
	 * gives one (a reactive read follows renames), else the one the block
	 * stores; a different answer is stored, outside the history, by a view
	 * that may write.
	 */
	let {
		data,
		handle,
		options
	}: {
		data: Record<string, unknown>;
		/** The block (none in a suggestion's preview: it opens nothing and stores nothing). */
		handle: Block | undefined;
		options: PagePluginOptions;
	} = $props();
	/** The view's words (a suggestion's preview, with no handle, speaks them too). */
	const labels = pageLabels.of(getContext<Edytor>('edytor'));

	const pageId = $derived(pageIdOf(data.pageId));
	const stored = $derived(pageTitleOf(data.title));
	/** The lookup's answer: a value at once, or a promise's once it settles. */
	let answered = $state<{ pageId: string; title: string | undefined } | null>(null);
	const asked = $derived(pageId && options.title ? options.title(pageId) : undefined);
	$effect(() => {
		const answer = asked;
		const id = pageId;
		if (!id || !(answer instanceof Promise)) return void (answered = null);
		let live = true;
		answer.then(
			(title) => live && (answered = { pageId: id, title: pageTitleOf(title) }),
			() => live && (answered = null)
		);
		return () => (live = false);
	});
	const looked = $derived(
		asked instanceof Promise
			? answered?.pageId === pageId
				? answered.title
				: undefined
			: pageTitleOf(asked)
	);
	const title = $derived(looked ?? stored);
	// The page's title as the lookup gives it, stored for views and exports without
	// one: once per answer, never because the stored title changed (two views whose
	// lookups disagree each store their answer once, never in turn forever).
	$effect(() => {
		const id = pageId;
		const answer = looked;
		if (!id || answer === undefined) return;
		// Neither the block (a snippet's view object, new at each render of its
		// parent) nor what the write reads is this effect's dependency.
		untrack(() => {
			if (handle && answer !== stored) storePageTitle(handle, id, answer);
		});
	});

	const href = $derived(pageHref(options, pageId));
	/**
	 * A click opens the page; a modified one (Mod, Shift) or a middle click
	 * opens it in a new tab (Notion), the browser's own on a link.
	 */
	const open = (event: MouseEvent) => {
		if (!pageId || !options.open) return;
		if (event.button !== 0 && event.button !== 1) return;
		const newTab = event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1;
		if (href && newTab) return;
		event.preventDefault();
		options.open(pageId, { newTab });
	};
	/** The middle button sends no `click`: its `auxclick` opens a new tab. */
	const aux = (event: MouseEvent) => {
		if (event.button === 1) open(event);
	};
</script>

{#snippet label()}
	<span data-edytor-page-icon aria-hidden="true"></span><span
		data-edytor-page-title
		data-untitled={title ? undefined : 'true'}>{title ?? labels.untitled}</span
	>
{/snippet}

{#if href}
	<a data-edytor-page-link {href} draggable="false" onclick={open} onauxclick={aux}
		>{@render label()}</a
	>
{:else}
	<button
		type="button"
		data-edytor-page-link
		disabled={!pageId || !options.open}
		onmousedown={(event) => event.preventDefault()}
		onclick={open}
		onauxclick={aux}>{@render label()}</button
	>
{/if}

<style>
	/* The link's structure, at zero specificity (`:where`); a theme draws it (`themes/notion.css`). */
	:global(:where([data-edytor-page-link])) {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: start;
		text-decoration: none;
		cursor: pointer;
	}
</style>
